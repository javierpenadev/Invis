/*
 * OpenVPN: поиск установленного бинарника, запуск от администратора (TAP
 * требует elevation), статус по лог-файлу, остановка через management-порт.
 * Не зависит от Electron (пути передаются параметрами).
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const net = require('net');

/* Кандидаты: установленная Community-версия, PATH, каталог bin самого Invis */
function detectExe(extraPath) {
    const candidates = [
        'C:\\Program Files\\OpenVPN\\bin\\openvpn.exe',
        'C:\\Program Files (x86)\\OpenVPN\\bin\\openvpn.exe',
        extraPath,
        path.join(process.cwd(), 'bin', 'openvpn', 'openvpn.exe'),
    ].filter(Boolean);
    for (const p of candidates) {
        try { if (p && fs.existsSync(p)) return p; } catch (e) { /* нет доступа */ }
    }
    try {
        const out = execFileSync('where', ['openvpn.exe'], { encoding: 'utf8' });
        const first = out.split(/\r?\n/).find((l) => l.trim());
        if (first) return first.trim();
    } catch (e) { /* в PATH нет */ }
    return null;
}

/* Аргументы запуска: конфиг + лог + management + (для VPNGate) vpn/vpn */
function buildArgs({ configPath, logPath, mgmtPort, authFile }) {
    const args = [
        '--config', configPath,
        '--log', logPath,
        '--log-append',
        '--management', '127.0.0.1', String(mgmtPort),
        '--management-query-remote', '0',
        '--verb', '3',
    ];
    if (authFile) args.push('--auth-user-pass', authFile);
    return args;
}

/* Запуск от администратора (UAC): openvpn.exe нужен elevation для TAP */
function startElevated(exe, args) {
    const argList = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
    const ps = `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList ${argList} -Verb RunAs -WindowStyle Hidden`;
    spawn('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true, stdio: 'ignore', detached: true }).unref();
}

/* SIGTERM в management-порт — штатная остановка без повторного UAC */
function managementSignal(port, signal = 'signal SIGTERM', timeoutMs = 3000) {
    return new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port });
        let buf = '';
        const done = (ok) => { sock.destroy(); resolve(ok); };
        sock.setTimeout(timeoutMs);
        sock.on('connect', () => sock.write(`${signal}\n`));
        sock.on('data', (d) => {
            buf += d.toString();
            if (/SUCCESS:/i.test(buf)) done(true);
        });
        sock.on('timeout', () => done(false));
        sock.on('error', () => done(false));
        setTimeout(() => done(false), timeoutMs + 500);
    });
}

/* Последние строки лога openvpn */
function tailLog(logPath, maxBytes = 64 * 1024) {
    try {
        const fd = fs.openSync(logPath, 'r');
        try {
            const size = fs.fstatSync(fd).size;
            const start = Math.max(0, size - maxBytes);
            const buf = Buffer.alloc(size - start);
            fs.readSync(fd, buf, 0, buf.length, start);
            return buf.toString('utf8');
        } finally { fs.closeSync(fd); }
    } catch (e) { return ''; }
}

/* Признаки состояния в логе */
const SIGNALS = {
    connected: /Initialization Sequence Completed/i,
    authFailed: /AUTH_FAILED/i,
    optionsError: /OPTIONS ERROR/i,
    tapError: /(All TAP-Windows|Cannot open TAP|Tap-Win.*adapter)/i,
    exiting: /process exiting/i,
    resolving: /(RESOLVE|Connecting to|Attempting to establish TCP)/i,
};

module.exports = { detectExe, buildArgs, startElevated, managementSignal, tailLog, SIGNALS };
