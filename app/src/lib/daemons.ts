/*
 * DaemonSupervisor: запуск/остановка tor, dnscrypt-proxy и i2pd.
 * Не зависит от Electron. Состояния: 'off' | 'busy' | 'on' | 'error'.
 * Готовность: tor — по «Bootstrapped 100%», остальные — проверкой порта.
 */
import { spawn, execFile, ChildProcess } from 'child_process';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { PORTS, shortPathSync } from './configs';
import { DaemonName } from '../types';

export type DaemonState = 'off' | 'busy' | 'on' | 'error';

export interface ModuleStatus {
    state: DaemonState;
    status: string;
}

interface BaseSpec {
    label: string;
    exe: string;
    args: string[];
    cwd?: string;
}

interface BootstrapSpec extends BaseSpec {
    readiness: 'bootstrap';
}

interface PortProbeSpec extends BaseSpec {
    readiness?: undefined;
    probePort: number;
    portSuffix?: string;
}

export type DaemonSpec = BootstrapSpec | PortProbeSpec;

interface ProcessSlot {
    proc: ChildProcess | null;
    state: DaemonState;
    status: string;
    stopping: boolean;
    stopPromise: Promise<void> | null;
}

export interface OnStatePayload {
    name: DaemonName;
    state: DaemonState;
    status: string;
}

export function probePort(port: number, timeout = 400): Promise<boolean> {
    return new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port });
        const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
        sock.setTimeout(timeout);
        sock.once('connect', () => done(true));
        sock.once('timeout', () => done(false));
        sock.once('error', () => done(false));
    });
}

/* Опрашивает порт, пока не откроется или не выйдет время */
export function waitReady(port: number, { timeout = 30000, interval = 500 } = {}): Promise<boolean> {
    return new Promise((resolve) => {
        const started = Date.now();
        const tick = async (): Promise<void> => {
            if (await probePort(port, 400)) { resolve(true); return; }
            if (Date.now() - started >= timeout) { resolve(false); return; }
            setTimeout(() => { void tick(); }, interval);
        };
        void tick();
    });
}

export class DaemonSupervisor {
    readonly specs: Record<DaemonName, DaemonSpec>;
    readonly list: DaemonName[];
    state: Record<DaemonName, ProcessSlot>;

    constructor({ binDir, configDir, logDir, i2pdDataDir, dnscryptPort = PORTS.dnscrypt, onState }: {
        binDir: string;
        configDir: string;
        logDir: string;
        i2pdDataDir: string;
        dnscryptPort?: number;
        onState?: (payload: OnStatePayload) => void;
    }) {
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
        };
        this.list = Object.keys(this.specs) as DaemonName[];
        this.state = {} as Record<DaemonName, ProcessSlot>;
        for (const name of this.list) {
            this.state[name] = { proc: null, state: 'off', status: 'остановлен', stopping: false, stopPromise: null };
        }
        this.logs = {};
    }

    private onState: (payload: OnStatePayload) => void;
    private logDir: string;
    private logs: Record<string, fs.WriteStream | null>;

    _set(name: DaemonName, state: DaemonState, status: string): void {
        const st = this.state[name];
        if (st.state === state && st.status === status) return;
        st.state = state;
        st.status = status;
        this.onState({ name, state, status });
    }

    isRunning(name: DaemonName): boolean { return Boolean(this.state[name]?.proc); }

    start(name: DaemonName): void {
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

        /* Лог сессии: перезаписывается при каждом старте */
        fs.mkdirSync(this.logDir, { recursive: true });
        this.logs[name] = fs.createWriteStream(path.join(this.logDir, `${name}.log`), { flags: 'w' });

        let proc: ChildProcess;
        try {
            proc = spawn(spec.exe, spec.args, {
                cwd: spec.cwd || path.dirname(spec.exe),
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (e) {
            this._set(name, 'error', `не удалось запустить: ${(e as Error).message}`);
            return;
        }
        st.proc = proc;

        const onLine = (line: string) => this._handleLine(name, line.trim());
        const pipe = (chunk: Buffer) => {
            this.logs[name]?.write(chunk);
            for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) onLine(line);
        };
        proc.stdout?.on('data', pipe);
        proc.stderr?.on('data', pipe);

        proc.on('error', (err: Error & { code?: string | number }) => {
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
            /* Цензурная сеть или мёртвые мосты: bootstrap может не дойти до 100%
             * никогда — не висим в «подключается…» вечно (раньше состояние было
             * пожизненным до ручной остановки) */
            setTimeout(() => {
                if (this.state[name].proc === proc && this.state[name].state === 'busy') {
                    this._set(name, 'error', 'не подключился за 4 мин (мосты/сеть?) — попробуйте перезапустить');
                }
            }, 240000);
        } else {
            void waitReady(spec.probePort).then((ok) => {
                if (this.state[name].proc === proc && this.state[name].state === 'busy') {
                    if (ok) this._set(name, 'on', 'работает' + (spec.portSuffix || ''));
                    else this._set(name, 'error', 'порт не открылся за 30 с');
                }
            });
        }
    }

    /* Смена listen-порта dnscrypt (переключение системного DNS) */
    setDnscryptPort(port: number): void {
        const spec = this.specs.dnscrypt;
        if ('probePort' in spec) {
            spec.probePort = port;
            spec.portSuffix = ` (:${port})`;
        }
    }

    _handleLine(name: DaemonName, line: string): void {
        const spec = this.specs[name];
        const st = this.state[name];
        if (spec.readiness === 'bootstrap') {
            const m = line.match(/Bootstrapped (\d+)%/i);
            if (m) {
                const pct = Number(m[1]);
                if (pct >= 100 && st.state === 'busy') this._set(name, 'on', 'работает');
                else if (st.state === 'busy') this._set(name, 'busy', `${pct}%`);
            }
            if (/^\[err\]/i.test(line) && st.state === 'busy') {
                /* частый случай «дурака»: порт занят другим Tor/SOCKS-сервисом —
                 * «код 1» ничего не объясняет, объясняем прямо */
                if (/bind|address already in use/i.test(line)) {
                    this._set(name, 'error', 'Порт занят другим процессом (другой Tor/SOCKS-сервис?) — ' + line.slice(0, 100));
                } else {
                    this._set(name, 'error', line.slice(0, 120));
                }
            }
        } else if (name === 'dnscrypt' && 'probePort' in spec) {
            if (/Now listening to/i.test(line) && st.state === 'busy') {
                void probePort(spec.probePort, 1500).then((ok) => {
                    if (ok && st.state === 'busy') this._set(name, 'on', 'работает' + (spec.portSuffix || ''));
                });
            }
        }
    }

    stop(name: DaemonName): Promise<void> {
        const st = this.state[name];
        if (!st.proc) { this._set(name, 'off', 'остановлен'); return Promise.resolve(); }
        if (st.stopPromise) return st.stopPromise;
        st.stopping = true;
        this._set(name, 'busy', 'остановка…');
        const proc = st.proc;
        st.stopPromise = new Promise<void>((resolve) => {
            let exited = false;
            const done = () => { if (!exited) { exited = true; resolve(); } };
            /* Резолвимся по 'exit', а не по завершению taskkill: 'exit' прилетает
             * позже, и ранний start() молча натыкался на ещё живый st.proc */
            proc.once('exit', done);
            proc.once('error', done);
            /* /T — дерево процессов, /F — форсированно */
            execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
            /* Страховка, если 'exit' так и не придёт: раньше зомби st.proc
             * навсегда блокировал очередь start() и модуль зависал в «остановка…» */
            setTimeout(() => {
                if (this.state[name].proc === proc) {
                    this.state[name].proc = null;
                    this.logs[name]?.end();
                    this.logs[name] = null;
                    this._set(name, 'error', 'не остановился по taskkill — слот освобождён принудительно');
                }
                done();
            }, 5000);
        }).finally(() => { st.stopPromise = null; });
        return st.stopPromise;
    }

    startEnabled(autostart?: { dnscrypt?: boolean; tor?: boolean; i2p?: boolean }): DaemonName[] {
        const names = this.list.filter((n) => autostart?.[n]);
        names.forEach((n) => this.start(n));
        return names;
    }

    async stopAll(): Promise<void> {
        await Promise.all(this.list.map((n) => this.stop(n)));
    }

    status(): Record<DaemonName, ModuleStatus> {
        const out = {} as Record<DaemonName, ModuleStatus>;
        for (const name of this.list) {
            const { state, status } = this.state[name];
            out[name] = { state, status };
        }
        return out;
    }
}
