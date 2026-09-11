/*
 * Определение внешних IP: прямой (реальный) и через Tor (SOCKS5 на 9050).
 * SOCKS5-клиент минимальный, без зависимостей: CONNECT по домену + TLS поверх.
 */
import * as net from 'net';
import * as tls from 'tls';
import * as https from 'https';

function fetchIp(url: string, timeout = 8000): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout }, (res) => {
            let data = '';
            res.on('data', (c: Buffer) => { data += c; });
            res.on('end', () => {
                const ip = data.trim();
                /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? resolve(ip) : reject(new Error('неожиданный ответ'));
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('таймаут')); });
        req.on('error', reject);
    });
}

/* Прямой IP с запасным источником */
export async function getDirectIp(timeout = 8000): Promise<string> {
    try { return await fetchIp('https://api.ipify.org', timeout); }
    catch (e) { return await fetchIp('https://icanhazip.com', timeout); }
}

/* SOCKS5 CONNECT по домену; возвращает готовый сокет */
export function socksConnect(socksPort: number, host: string, port: number, timeout = 12000): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const sock = net.connect({ host: '127.0.0.1', port: socksPort });
        let buf = Buffer.alloc(0);
        let stage = 0; // 0 — приветствие, 1 — ответ CONNECT
        const fail = (msg: string) => { clearTimeout(to); try { sock.destroy(); } catch (e) { /* ок */ } reject(new Error(msg)); };
        const to = setTimeout(() => fail('таймаут SOCKS'), timeout);

        sock.on('data', (d: Buffer) => {
            buf = Buffer.concat([buf, d]);
            if (stage === 0) {
                if (buf.length < 2) return;
                if (buf[0] !== 5 || buf[1] !== 0) { fail('SOCKS: прокси отклонил метод'); return; }
                buf = buf.slice(2);
                stage = 1;
                const h = Buffer.from(host);
                const req = Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 0xff])]);
                sock.write(req);
                return;
            }
            if (stage === 1) {
                if (buf.length < 5) return;
                if (buf[1] !== 0) { fail(`SOCKS: ошибка соединения (код ${buf[1]})`); return; }
                clearTimeout(to);
                sock.removeAllListeners('data');
                sock.removeAllListeners('error');
                sock.setTimeout(0);
                resolve(sock);
            }
        });
        sock.on('error', (e) => fail(e.message));
        sock.on('connect', () => sock.write(Buffer.from([5, 1, 0])));
    });
}

export interface TorIpInfo {
    ip: unknown;
    isTor: boolean;
}

/* IP через Tor: HTTPS-запрос к check.torproject.org/api/ip через SOCKS5 */
export async function getTorIp(socksPort = 9050, timeout = 20000): Promise<TorIpInfo> {
    const raw = await socksConnect(socksPort, 'check.torproject.org', 443, timeout);
    return new Promise((resolve, reject) => {
        const tlsTo = setTimeout(() => reject(new Error('таймаут TLS/HTTP')), timeout);
        const sock = tls.connect({ socket: raw, servername: 'check.torproject.org' }, () => {
            sock.write('GET /api/ip HTTP/1.1\r\nHost: check.torproject.org\r\nConnection: close\r\n\r\n');
        });
        let data = '';
        let settled = false;
        const settle = <T,>(fn: (arg: T) => void, arg: T) => {
            if (settled) return;
            settled = true;
            clearTimeout(tlsTo);
            sock.removeAllListeners();
            try { raw.destroy(); } catch (e) { /* ок */ }
            fn(arg);
        };
        sock.on('data', (c: Buffer) => { data += c.toString(); });
        sock.on('end', () => {
            const body = data.split('\r\n\r\n').slice(1).join('\r\n\r\n');
            try {
                const j = JSON.parse(body) as { IP?: unknown; IsTor?: unknown };
                settle(resolve, { ip: j.IP, isTor: Boolean(j.IsTor) });
            } catch (e) {
                settle(reject, new Error('неожиданный ответ'));
            }
        });
        /* 'close' без 'end' (RST от exit-узла) раньше не завершал промис вовсе —
         * диагностика висела до 20-с таймаута; после нормального 'end' это no-op */
        sock.on('close', () => settle(reject, new Error('соединение закрыто до конца ответа')));
        sock.on('error', (e) => settle(reject, e));
    });
}
