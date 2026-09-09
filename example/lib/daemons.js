/*
 * DaemonSupervisor: запуск/остановка tor, dnscrypt-proxy и i2pd.
 * Не зависит от Electron. Состояния: 'off' | 'busy' | 'on' | 'error'.
 * Готовность: tor — по «Bootstrapped 100%», остальные — проверкой порта.
 */
const { spawn, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { PORTS } = require('./configs');

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
     *   binDir    — каталог с bin/{tor,dnscrypt,i2pd}
     *   configDir — каталог сгенерированных конфигов
     *   logDir    — каталог логов сессии
     *   onState   — callback({name, state, status})
     */
    constructor({ binDir, configDir, logDir, onState }) {
        this.onState = onState || (() => {});
        this.logDir = logDir;
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
                probePort: PORTS.dnscrypt,
            },
            i2p: {
                label: 'I2P',
                exe: path.join(binDir, 'i2pd', 'i2pd.exe'),
                args: ['--conf', path.join(configDir, 'i2pd.conf')],
                probePort: PORTS.i2pHttp,
            },
        };
        this.list = Object.keys(this.specs);
        this.state = {};
        for (const name of this.list) this.state[name] = { proc: null, state: 'off', status: 'остановлен', stopping: false };
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
        if (!spec || st.proc) return;
        if (!fs.existsSync(spec.exe)) {
            this._set(name, 'error', 'бинарник не найден (npm run fetch-bins)');
            return;
        }

        st.stopping = false;
        st.state = 'busy';
        st.status = 'запуск…';
        this.onState({ name, state: st.state, status: st.status });

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
                    if (ok) this._set(name, 'on', 'работает');
                    else this._set(name, 'error', 'порт не открылся за 30 с');
                }
            });
        }
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
                    if (ok && st.state === 'busy') this._set(name, 'on', 'работает');
                });
            }
        }
    }

    stop(name) {
        const st = this.state[name];
        if (!st.proc) { this._set(name, 'off', 'остановлен'); return Promise.resolve(); }
        st.stopping = true;
        this._set(name, 'busy', 'остановка…');
        return new Promise((resolve) => {
            /* /T — дерево процессов, /F — форсированно */
            execFile('taskkill', ['/pid', String(st.proc.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
        });
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
