/*
 * Диагностика модулей: DNS-запрос по TCP напрямую в listen-порт dnscrypt,
 * TCP-проба порта. Не зависит от Electron.
 */
const net = require('net');

function probeTcp(port, host = '127.0.0.1', timeout = 2000) {
    return new Promise((resolve) => {
        const sock = net.connect({ host, port });
        const done = (ok) => { try { sock.destroy(); } catch (e) { /* ок */ } resolve(ok); };
        const to = setTimeout(() => done(false), timeout);
        sock.once('connect', () => { clearTimeout(to); done(true); });
        sock.once('error', () => { clearTimeout(to); done(false); });
    });
}

/* Минимальный DNS A-запрос по TCP (2-байтовый префикс длины) */
function dnsQueryTcp(port, domain = 'ya.ru', timeout = 5000) {
    return new Promise((resolve) => {
        const qname = domain.split('.').map((l) => String.fromCharCode(l.length) + l).join('') + '\x00';
        const q = Buffer.concat([
            Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]),
            Buffer.from(qname, 'latin1'),
            Buffer.from([0, 1, 0, 1]),
        ]);
        const sock = net.connect({ host: '127.0.0.1', port });
        let buf = Buffer.alloc(0);
        const finish = (r) => { clearTimeout(to); try { sock.destroy(); } catch (e) { /* ок */ } resolve(r); };
        const to = setTimeout(() => finish({ ok: false, detail: 'таймаут' }), timeout);

        sock.on('connect', () => {
            const len = Buffer.alloc(2);
            len.writeUInt16BE(q.length);
            sock.write(Buffer.concat([len, q]));
        });
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (buf.length < 2) return;
            const need = buf.readUInt16BE(0);
            if (buf.length < need + 2) return;
            const msg = buf.slice(2, need + 2);      // само сообщение (без префикса длины)
            const rcode = msg[3] & 0x0f;
            const ancount = msg.readUInt16BE(6);
            /* Успех тоже через finish(): раньше сокет не закрывался и утекал */
            if (rcode === 0 && ancount > 0) finish({ ok: true, detail: `ответ: ${ancount} запис(ей)` });
            else finish({ ok: false, detail: `код ответа ${rcode}` });
        });
        sock.on('error', (e) => { clearTimeout(to); finish({ ok: false, detail: e.message }); });
    });
}

module.exports = { probeTcp, dnsQueryTcp };
