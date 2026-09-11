/*
 * Данные о выходных узлах Tor по странам: Onionoo (metrics.torproject.org).
 * Кэш в userData на 24 часа. Не зависит от Electron (cacheDir передаётся).
 */
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const URL_ = 'https://onionoo.torproject.org/details?flag=exit&fields=country,advertised_bandwidth';
const TTL_MS = 24 * 60 * 60 * 1000;

export interface CountryStats {
    count: number;
    mbps: number;
}

export interface ExitCountriesResult {
    ok: boolean;
    countries?: Record<string, CountryStats>;
    fresh?: boolean;
    ts?: number;
    stale?: boolean;
    error?: string;
}

function cacheFile(cacheDir: string): string {
    return path.join(cacheDir, 'onionoo-exits.json');
}

/* GET с поддержкой gzip-ответа */
function getJson(url: string, timeoutMs = 30000): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'Accept-Encoding': 'gzip', 'User-Agent': 'invis-onionoo' } }, (res) => {
            const code = res.statusCode ?? 0;
            if (code !== 200) {
                res.resume();
                reject(new Error(`HTTP ${code}`));
                return;
            }
            const chunks: Buffer[] = [];
            let stream: NodeJS.ReadableStream = res;
            if (res.headers['content-encoding'] === 'gzip') {
                stream = res.pipe(zlib.createGunzip());
            }
            stream.on('data', (c: Buffer) => chunks.push(c));
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

/* Данные уходят в innerHTML рендерера: пропускаем только строгую схему
 * { AA: { count, mbps } } — и для свежих данных, и для прочитанных из
 * кэша (файл в userData может быть подменён/повреждён). */
function sanitizeCountries(raw: unknown): Record<string, CountryStats> {
    const out: Record<string, CountryStats> = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [cc, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!/^[A-Z]{2}$/.test(cc) || !v || typeof v !== 'object') continue;
        const rec = v as Record<string, unknown>;
        out[cc] = {
            count: Math.max(0, Math.round(Number(rec.count) || 0)),
            mbps: Math.max(0, Math.round(Number(rec.mbps) || 0)),
        };
    }
    return out;
}

/*
 * Возвращает { ok, countries: { CC: { count, mbps } }, fresh, ts }.
 * fresh=true — данные только что из сети; false — из кэша (или кэш протух,
 * тогда fresh=true при удаче). При сетевой ошибке отдаём протухший кэш.
 */
export async function exitCountries(cacheDir: string, { force = false }: { force?: boolean } = {}): Promise<ExitCountriesResult> {
    const file = cacheFile(cacheDir);
    let cached: { ts?: number; countries?: unknown } | null = null;
    try {
        cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { /* кэша нет */ }
    const cacheUsable = Boolean(cached && (Date.now() - (cached.ts || 0)) < TTL_MS);
    if (cacheUsable && !force) {
        return { ok: true, countries: sanitizeCountries(cached?.countries), fresh: false, ts: cached?.ts };
    }
    try {
        const rel = await getJson(URL_) as { relays?: Array<{ country?: string; advertised_bandwidth?: number }> };
        /* агрегируем выходные узлы по стране */
        const agg: Record<string, CountryStats> = {};
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
        return { ok: false, error: (e as Error).message };
    }
}
