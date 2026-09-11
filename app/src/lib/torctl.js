/*
 * Tor ControlPort: аутентификация по cookie (CookieAuthentication 1 в torrc),
 * SIGNAL NEWNYM (новый IP) и GETINFO-проверки.
 * Не зависит от Electron.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const { PORTS } = require('./configs');

function readCookieHex(dataDir) {
    /* Tor называет файл control_auth_cookie, в некоторых сборках — control-auth-cookie */
    for (const name of ['control_auth_cookie', 'control-auth-cookie']) {
        try {
            return fs.readFileSync(path.join(dataDir, name)).toString('hex');
        } catch (e) { /* пробуем следующий вариант */ }
    }
    return null;
}

/* Выполняет команды по очереди, ждёт ответ "250 ..." (или "5xx") на каждую */
function controlSession(port, cookieHex, commands) {
    return new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port });
        let buf = '';
        let idx = 0;
        let settled = false;
        const results = [];
        const finish = (ok, detail) => {
            if (settled) return;      // Tor может закрыть соединение после SIGNAL
            settled = true;
            clearTimeout(to);
            try { sock.destroy(); } catch (e) { /* уже закрыт */ }
            resolve({ ok, detail, results });
        };
        const to = setTimeout(() => finish(false, 'таймаут ControlPort'), 6000);

        const sendNext = () => {
            if (idx >= commands.length) {
                sock.write('QUIT\r\n');
                setTimeout(() => finish(true, 'ok'), 250);
                return;
            }
            sock.write(commands[idx] + '\r\n');
        };

        sock.on('connect', sendNext);
        sock.on('data', (d) => {
            buf += d.toString();
            const lines = buf.split(/\r?\n/);
            buf = lines.pop(); // хвост без \r\n — ждём продолжения
            const finalLine = lines.find((l) => /^(250|5\d\d)( |$)/.test(l));
            if (finalLine) {
                results.push(...lines);
                const ok = finalLine.startsWith('250');
                buf = '';
                idx += 1;
                if (!ok) { finish(false, finalLine.slice(0, 120)); return; }
                sendNext();
            }
        });
        sock.on('error', (e) => {
            /* после успешной отправки всех команд разрыв соединения — норма */
            finish(idx >= commands.length, idx >= commands.length ? 'ok' : e.message);
        });
    });
}

function authCommands(dataDir) {
    const cookieHex = readCookieHex(dataDir);
    return cookieHex
        ? { cookieHex, commands: [`AUTHENTICATE ${cookieHex}`] }
        : null;
}

/* SIGNAL NEWNYM — запрос новой цепочки (нового выходного IP) */
function newIp(dataDir, port = PORTS.torControl) {
    const auth = authCommands(dataDir);
    if (!auth) return Promise.resolve({ ok: false, detail: 'cookie ControlPort не найден' });
    return controlSession(port, auth.cookieHex, [...auth.commands, 'SIGNAL NEWNYM']);
}

/* Установлена ли цепочка Tor (GETINFO status/circuit-established) */
async function circuitEstablished(dataDir, port = PORTS.torControl) {
    const auth = authCommands(dataDir);
    if (!auth) return false;
    const r = await controlSession(port, auth.cookieHex, [...auth.commands, 'GETINFO status/circuit-established']);
    return r.ok && r.results.some((l) => l.includes('status/circuit-established=1'));
}

module.exports = { newIp, circuitEstablished };
