/*
 * Данные о выходных узлах Tor по странам: Onionoo (metrics.torproject.org).
 * Кэш в userData на 24 часа. Не зависит от Electron (cacheDir передаётся).
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const URL_ = 'https://onionoo.torproject.org/details?flag=exit&fields=country,advertised_bandwidth';
const TTL_MS = 24 * 60 * 60 * 1000;

function cacheFile(cacheDir) {
    return path.join(cacheDir, 'onionoo-exits.json');
}

/* GET с поддержкой gzip-ответа */
function getJson(url, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'Accept-Encoding': 'gzip', 'User-Agent': 'invis-onionoo' } }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            let stream = res;
            if (res.headers['content-encoding'] === 'gzip') {
                stream = res.pipe(zlib.createGunzip());
            }
            stream.on('data', (c) => chunks.push(c));
            stream.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch (e) { reject(new Error('битый JSON ответа')); }
            });
            stream.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => { req.destroy(new Error('таймаут запроса')); });
    });
}

/*
 * Возвращает { ok, countries: { CC: { count, mbps } }, fresh, ts }.
 * fresh=true — данные только что из сети; false — из кэша (или кэш протух,
 * тогда fresh=true при удаче). При сетевой ошибке отдаём протухший кэш.
 */

/* Данные уходят в innerHTML рендерера: пропускаем только строгую схему
 * { AA: { count, mbps } } — и для свежих данных, и для прочитанных из
 * кэша (файл в userData может быть подменён/повреждён). */
function sanitizeCountries(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [cc, v] of Object.entries(raw)) {
        if (!/^[A-Z]{2}$/.test(cc) || !v || typeof v !== 'object') continue;
        out[cc] = {
            count: Math.max(0, Math.round(Number(v.count) || 0)),
            mbps: Math.max(0, Math.round(Number(v.mbps) || 0)),
        };
    }
    return out;
}

async function exitCountries(cacheDir, { force = false } = {}) {
    const file = cacheFile(cacheDir);
    let cached = null;
    try {
        cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { /* кэша нет */ }
    const cacheUsable = cached && (Date.now() - cached.ts) < TTL_MS;
    if (cacheUsable && !force) {
        return { ok: true, countries: sanitizeCountries(cached.countries), fresh: false, ts: cached.ts };
    }
    try {
        const rel = await getJson(URL_);
        /* агрегируем выходные узлы по стране */
        const agg = {};
        for (const r of rel.relays || []) {
            const cc = String(r.country || '').toUpperCase();
            if (!/^[A-Z]{2}$/.test(cc)) continue;
            if (!agg[cc]) agg[cc] = { count: 0, mbps: 0 };
            agg[cc].count += 1;
            agg[cc].mbps += (Number(r.advertised_bandwidth) || 0) / 125000; /* байт/с -> Мбит/с */
        }
        for (const cc of Object.keys(agg)) agg[cc].mbps = Math.round(agg[cc].mbps);
        const out = { ts: Date.now(), countries: agg };
        try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(out)); } catch (e) { /* кэш не критичен */ }
        return { ok: true, countries: sanitizeCountries(agg), fresh: true, ts: out.ts };
    } catch (e) {
        if (cached) return { ok: true, countries: sanitizeCountries(cached.countries), fresh: false, ts: cached.ts, stale: true };
        return { ok: false, error: e.message };
    }
}

module.exports = { exitCountries };
