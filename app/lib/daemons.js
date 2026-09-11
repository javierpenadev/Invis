/*
 * DaemonSupervisor: запуск/остановка tor, dnscrypt-proxy и i2pd.
 * Не зависит от Electron. Состояния: 'off' | 'busy' | 'on' | 'error'.
 * Готовность: tor — по «Bootstrapped 100%», остальные — проверкой порта.
 */
const { spawn, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { PORTS, shortPathSync } = require('./configs');
const { managementSignal } = require('./openvpn');

/* Открытый OpenVPN, который не удалось остановить через management — фиксируем факт */
function netmodeKillHint() {
    try {
        fs.appendFileSync(path.join(require('os').tmpdir(), 'invis-openvpn.log'),
            new Date().toISOString() + ' stop failed (management unavailable)\n');
    } catch (e) { /* не критично */ }
}

function probePort(port, timeout = 400) {
    return new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port });
        const done = (ok) => { sock.destroy(); resolve(ok); };
        sock.setTimeout(timeout);
        sock.once('connect', () => done(true));
        sock.once('timeout', () => done(false));
        sock.once('error', () => done(false));
    });
}

/* Опрашивает порт, пока не откроется или не выйдет время */
function waitReady(port, { timeout = 30000, interval = 500 } = {}) {
    return new Promise((resolve) => {
        const started = Date.now();
        const tick = async () => {
            if (await probePort(port, 400)) { resolve(true); return; }
            if (Date.now() - started >= timeout) { resolve(false); return; }
            setTimeout(tick, interval);
        };
        tick();
    });
}

class DaemonSupervisor {
    /**
     * opts:
     *   binDir      — каталог с bin/{tor,dnscrypt,i2pd}
     *   configDir   — каталог сгенерированных конфигов
     *   logDir      — каталог логов сессии
     *   i2pdDataDir — каталог данных i2pd (внутри сертификаты)
     *   onState     — callback({name, state, status})
     */
    constructor({ binDir, configDir, logDir, i2pdDataDir, dnscryptPort = PORTS.dnscrypt, onState }) {
        this.onState = onState || (() => {});
        this.logDir = logDir;
        /* i2pd: datadir/certsdir только через CLI — ключ datadir в ini игнорируется.
         * Пути через shortPathSync: i2pd и tor не дружат с не-ASCII путями. */
        const S = shortPathSync;
        this.specs = {
            tor: {
                label: 'Tor',
                exe: path.join(binDir, 'tor', 'tor', 'tor.exe'),
                args: ['-f', path.join(configDir, 'torrc')],
                readiness: 'bootstrap',
            },
            dnscrypt: {
                label: 'DNSCrypt',
                exe: path.join(binDir, 'dnscrypt', 'win64', 'dnscrypt-proxy.exe'),
                args: ['-config', path.join(configDir, 'dnscrypt-proxy.toml')],
                cwd: configDir,
                probePort: dnscryptPort,
                portSuffix: ` (:${dnscryptPort})`,
            },
            i2p: {
                label: 'I2P',
                exe: path.join(binDir, 'i2pd', 'i2pd.exe'),
                args: [
                    '--conf', S(path.join(configDir, 'i2pd.conf')),
                    '--datadir', S(i2pdDataDir),
                    '--certsdir', S(path.join(i2pdDataDir, 'certificates')),
                ],
                probePort: PORTS.i2pHttp,
            },
            openvpn: {
                label: 'OpenVPN',
                exe: null,                    // детект в main (установленный OpenVPN)
                args: [],
                readiness: 'logfile',         // статус по строкам лога
                logFile: null,                // задаётся перед стартом
            },
        };
        this.list = Object.keys(this.specs);
        this.state = {};
        for (const name of this.list) this.state[name] = { proc: null, state: 'off', status: 'остановлен', stopping: false, logTimer: null };
        this.logs = {};
    }

    _set(name, state, status) {
        const st = this.state[name];
        if (st.state === state && st.status === status) return;
        st.state = state;
        st.status = status;
        this.onState({ name, state, status });
    }

    isRunning(name) { return Boolean(this.state[name]?.proc); }

    start(name) {
        const st = this.state[name];
        const spec = this.specs[name];
        if (!spec) return;
        /* Рестарт сразу после «Остановить всё»: процесс ещё гаснет — раньше
         * start() молча уходил в никуда и модуль не поднимался. Ставим в
         * очередь за остановкой. */
        if (st.stopPromise) {
            st.stopPromise.then(() => this.start(name)).catch(() => {});
            return;
        }
        if (st.proc) return;
        if (!fs.existsSync(spec.exe)) {
            this._set(name, 'error', 'бинарник не найден (npm run fetch-bins)');
            return;
        }

        st.stopping = false;
        st.state = 'busy';
        st.status = 'запуск…';
        this.onState({ name, state: st.state, status: st.status });

        /* OpenVPN: запуск от администратора (UAC), статус по его лог-файлу */
        if (spec.readiness === 'logfile') {
            this._startLogfileWatcher(name);
            return;
        }

        /* Лог сессии: перезаписывается при каждом старте */
        fs.mkdirSync(this.logDir, { recursive: true });
        this.logs[name] = fs.createWriteStream(path.join(this.logDir, `${name}.log`), { flags: 'w' });

        let proc;
        try {
            proc = spawn(spec.exe, spec.args, {
                cwd: spec.cwd || path.dirname(spec.exe),
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (e) {
            this._set(name, 'error', `не удалось запустить: ${e.message}`);
            return;
        }
        st.proc = proc;

        const onLine = (line) => this._handleLine(name, line.toString().trim());
        const pipe = (chunk) => {
            if (this.logs[name]) this.logs[name].write(chunk);
            for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) onLine(line);
        };
        proc.stdout.on('data', pipe);
        proc.stderr.on('data', pipe);

        proc.on('error', (err) => {
            if (this.state[name].proc === proc) this._set(name, 'error', `не удалось запустить: ${err.code || err.message}`);
        });

        proc.on('exit', (code) => {
            if (this.state[name].proc !== proc) return;
            this.state[name].proc = null;
            this.logs[name]?.end();
            this.logs[name] = null;
            if (this.state[name].stopping || code === 0) {
                this._set(name, 'off', 'остановлен');
            } else {
                this._set(name, 'error', `процесс завершён (код ${code})`);
            }
        });

        /* Готовность */
        if (spec.readiness === 'bootstrap') {
            /* Tor: 'on' выставит парсер Bootstrapped; страхуемся таймаутом */
            setTimeout(() => {
                if (this.state[name].proc === proc && this.state[name].state === 'busy') {
                    this._set(name, 'busy', 'подключается…');
                }
            }, 20000);
        } else {
            waitReady(spec.probePort).then((ok) => {
                if (this.state[name].proc === proc && this.state[name].state === 'busy') {
                    if (ok) this._set(name, 'on', 'работает' + (spec.portSuffix || ''));
                    else this._set(name, 'error', 'порт не открылся за 30 с');
                }
            });
        }
    }

    /* Смена listen-порта dnscrypt (переключение системного DNS) */
    setDnscryptPort(port) {
        this.specs.dnscrypt.probePort = port;
        this.specs.dnscrypt.portSuffix = ` (:${port})`;
    }

    /* ---------- OpenVPN (kind logfile): процесс запущен извне (elevated),
     * состояние читаем из его лог-файла ---------- */
    _startLogfileWatcher(name) {
        const spec = this.specs[name];
        const st = this.state[name];
        clearInterval(st.logTimer);
        let seen = '';
        const SIGNALS = spec.logSignals;
        st.logTimer = setInterval(() => {
            if (!st.proc) { clearInterval(st.logTimer); return; }
            const log = fs.readFileSync(spec.logFile, 'utf8').slice(-32 * 1024);
            const fresh = log.startsWith(seen) ? log.slice(seen.length) : log;
            seen = log.slice(-16 * 1024);
            if (!fresh) return;
            for (const line of fresh.split(/\r?\n/)) {
                if (line.trim()) this.logs[name]?.write(line + '\n');
            }
            if (SIGNALS.connected.test(fresh) && st.state === 'busy') {
                this._set(name, 'on', 'подключено');
            } else if (SIGNALS.authFailed.test(fresh) || SIGNALS.optionsError.test(fresh)
                    || SIGNALS.tapError.test(fresh)) {
                const m = fresh.match(/.*(AUTH_FAILED|OPTIONS ERROR.*|All TAP-Windows[^\n]*|Cannot open TAP[^\n]*)/i);
                this._set(name, 'error', m ? m[1].slice(0, 90) : 'ошибка подключения');
                clearInterval(st.logTimer);
            } else if (/RESOLVE|Connecting to/i.test(fresh) && st.state === 'busy') {
                this._set(name, 'busy', 'подключение…');
            }
        }, 1000);
    }

    /* Конфигурация openvpn перед стартом (exe/args/logFile) */
    configureOpenvpn({ exe, args, logFile, logSignals }) {
        this.specs.openvpn.exe = exe;
        this.specs.openvpn.args = args;
        this.specs.openvpn.logFile = logFile;
        this.specs.openvpn.logSignals = logSignals;
    }

    /* Процесс запущен вне супервизора (elevated openvpn) — начать слежение по логу */
    markStarted(name) {
        const st = this.state[name];
        if (!st || st.proc) return;
        st.proc = { external: true };
        st.state = 'busy';
        st.status = 'подключение…';
        this.onState({ name, state: st.state, status: st.status });
        fs.mkdirSync(this.logDir, { recursive: true });
        this.logs[name] = fs.createWriteStream(path.join(this.logDir, `${name}.log`), { flags: 'w' });
        this._startLogfileWatcher(name);
    }

    _handleLine(name, line) {
        const spec = this.specs[name];
        const st = this.state[name];
        if (spec.readiness === 'bootstrap') {
            const m = line.match(/Bootstrapped (\d+)%/i);
            if (m) {
                const pct = Number(m[1]);
                if (pct >= 100 && st.state === 'busy') this._set(name, 'on', 'работает');
                else if (st.state === 'busy') this._set(name, 'busy', `${pct}%`);
            }
            if (/^\[err\]/i.test(line) && st.state === 'busy') this._set(name, 'error', line.slice(0, 120));
        } else if (name === 'dnscrypt') {
            if (/Now listening to/i.test(line) && st.state === 'busy') {
                probePort(spec.probePort, 1500).then((ok) => {
                    if (ok && st.state === 'busy') this._set(name, 'on', 'работает' + (spec.portSuffix || ''));
                });
            }
        }
    }

    stop(name) {
        const st = this.state[name];
        if (!st.proc) { this._set(name, 'off', 'остановлен'); return Promise.resolve(); }
        if (st.stopPromise) return st.stopPromise;
        st.stopping = true;
        this._set(name, 'busy', 'остановка…');
        /* OpenVPN: штатный SIGTERM через management-порт (без повторного UAC) */
        if (this.specs[name]?.readiness === 'logfile') {
            clearInterval(st.logTimer);
            st.stopPromise = managementSignal(this.specs[name].mgmtPort)
                .catch(() => false)
                .then((ok) => {
                    st.proc = null;
                    this.logs[name]?.end();
                    this.logs[name] = null;
                    this._set(name, ok ? 'off' : 'error', ok ? 'остановлен' : 'не удалось остановить (закройте вручную)');
                    if (!ok) netmodeKillHint();
                })
                .finally(() => { st.stopPromise = null; });
            return st.stopPromise;
        }
        const proc = st.proc;
        st.stopPromise = new Promise((resolve) => {
            /* Резолвимся по 'exit', а не по завершению taskkill: 'exit' прилетает
             * позже, и ранний start() молча натыкался на ещё живый st.proc */
            const done = () => resolve();
            proc.once('exit', done);
            proc.once('error', done);
            /* /T — дерево процессов, /F — форсированно */
            execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
            setTimeout(done, 5000); // страховка, если 'exit' так и не придёт
        }).finally(() => { st.stopPromise = null; });
        return st.stopPromise;
    }

    startEnabled(autostart) {
        const names = this.list.filter((n) => autostart?.[n]);
        names.forEach((n) => this.start(n));
        return names;
    }

    async stopAll() {
        await Promise.all(this.list.map((n) => this.stop(n)));
    }

    status() {
        const out = {};
        for (const name of this.list) {
            const { state, status } = this.state[name];
            out[name] = { state, status };
        }
        return out;
    }
}

module.exports = { DaemonSupervisor, probePort, waitReady };
