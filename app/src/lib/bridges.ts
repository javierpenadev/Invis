/*
 * Запрос мостовых строк с bridges.torproject.org (format=plain).
 */
import * as https from 'https';

export type BridgesResult = { ok: true; lines: string[] } | { ok: false; error: string };

export function fetchBridges(transport = 'obfs4'): Promise<BridgesResult> {
    const url = `https://bridges.torproject.org/bridges?transport=${encodeURIComponent(transport)}&format=plain`;
    return new Promise((resolve) => {
        const get = (u: string, redirects: number): void => {
            if (redirects > 5) { resolve({ ok: false, error: 'слишком много редиректов' }); return; }
            https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Invis)' } }, (res) => {
                const code = res.statusCode ?? 0;
                if (code >= 300 && code < 400 && res.headers.location) {
                    res.resume();
                    return get(new URL(res.headers.location, u).href, redirects + 1);
                }
                let data = '';
                res.on('data', (c: Buffer) => { data += c; });
                res.on('end', () => {
                    const lines = data.split(/\r?\n/)
                        .map((s) => s.replace(/^Bridge\s+/, '').trim())
                        .filter((l) => l && !/[<>]/.test(l) && /\s/.test(l) && !/^no bridges/i.test(l));
                    if (lines.length) resolve({ ok: true, lines });
                    else resolve({ ok: false, error: 'Мостов сейчас не выдают — попробуйте позже или вставьте строки вручную.' });
                });
            }).on('error', (e) => resolve({ ok: false, error: e.message }));
        };
        get(url, 0);
    });
}
