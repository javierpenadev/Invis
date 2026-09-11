/*
 * VPNGate (проект Университета Цукубы): публичные volunteer-серверы OpenVPN.
 * Список по странам с пингом/скоростью, .ovpn скачивается из списка.
 * Кэш 30 минут в переданном каталоге. Не зависит от Electron.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const URL_ = 'https://www.vpngate.net/api/iphone/';
const TTL_MS = 30 * 60 * 1000;

function getBody(url, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'invis-vpngate', 'Accept-Encoding': 'identity' } }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', reject);
        }).on('error', reject).setTimeout(timeoutMs, function () { this.destroy(new Error('таймаут')); });
    });
}

/* CSV-строка с кавычками -> массив полей */
function parseCsvLine(line) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
            if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (ch === '"') q = false;
            else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur);
    return out;
}

function parseList(body) {
    const lines = body.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('*'));
    const hdrLine = lines.find((l) => l.startsWith('#'));
    if (!hdrLine) throw new Error('неожиданный формат списка');
    const hdr = hdrLine.slice(1).split(',');
    const servers = [];
    for (const line of lines) {
        if (line.startsWith('#')) continue; // заголовок
        const f = parseCsvLine(line);
        if (f.length < hdr.length) continue;
        const r = {};
        hdr.forEach((h, i) => { r[h.trim()] = f[i]; });
        if (!r.OpenVPN_ConfigData_Base64) continue;
        servers.push({
            host: r.HostName,
            ip: r.IP,
            score: Number(r.Score) || 0,
            pingMs: Number(r.Ping) || null,
            speedBps: Number(r.Speed) || 0,
            country: r.CountryLong || r.CountryShort,
            cc: (r.CountryShort || '').toUpperCase(),
            sessions: Number(r.NumVpnSessions) || 0,
            uptimeDays: Math.round((Number(r.Uptime) || 0) / 86400000),
            ovpn: r.OpenVPN_ConfigData_Base64,
        });
    }
    return servers;
}

/*
 * Список серверов: { ok, servers, fresh, ts } | { ok:false, error }.
 * fresh=false — отдали кэш (сеть недоступна или не пора).
 */
async function list(cacheDir, { force = false } = {}) {
    const file = path.join(cacheDir, 'vpngate-cache.json');
    let cached = null;
    try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* нет кэша */ }
    if (!force && cached && (Date.now() - cached.ts) < TTL_MS) {
        return { ok: true, servers: cached.servers, fresh: false, ts: cached.ts };
    }
    try {
        const servers = parseList(await getBody(URL_));
        const out = { ts: Date.now(), servers };
        try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(out)); } catch (e) { /* не критично */ }
        return { ok: true, servers, fresh: true, ts: out.ts };
    } catch (e) {
        if (cached) return { ok: true, servers: cached.servers, fresh: false, ts: cached.ts, stale: true };
        return { ok: false, error: e.message };
    }
}

/* Декодировать .ovpn сервера в файл */
function writeOvpn(cacheDir, server) {
    const safe = String(server.ip || server.host || 'server').replace(/[^\w.]/g, '_');
    const file = path.join(cacheDir, `vpngate-${safe}.ovpn`);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, Buffer.from(server.ovpn, 'base64'));
    return file;
}

module.exports = { list, writeOvpn };
