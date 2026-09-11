/*
 * Авто-обновление: проверка релизов GitHub, сравнение версий, скачивание,
 * сверка SHA-256 с SHA256SUMS.txt из релиза (тихая установка ставится только
 * после сверки целостности). Без внешних зависимостей. Публикуемые артефакты:
 *   Invis-Setup-<ver>.exe    — NSIS-установщик
 *   Invis-Portable-<ver>.exe — портативный
 *   SHA256SUMS.txt           — контрольные суммы (npm run checksums)
 */
import * as fs from 'fs';
import * as https from 'https';
import * as crypto from 'crypto';
import { IncomingMessage } from 'http';

export const REPO = 'javierpenadev/Invis';

export interface ReleaseInfo {
    version: string;
    tag: string;
    setupUrl: string | null;
    setupSizeMb: number | null;
    portableUrl: string | null;
    portableSizeMb: number | null;
    sumsUrl: string | null;
    htmlUrl: string;
}

/* 1.2.0 → [1,2,0]; сравнение по сегментам */
export function isNewer(remote: string, local: string): boolean {
    const r = String(remote).split('.').map((n) => parseInt(n, 10) || 0);
    const l = String(local).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
        if ((r[i] || 0) > (l[i] || 0)) return true;
        if ((r[i] || 0) < (l[i] || 0)) return false;
    }
    return false;
}

interface HttpGetOptions {
    headers?: Record<string, string>;
    redirects?: number;
    onProgress?: (pct: number) => void;
}

function httpsGet(url: string, { headers = {}, redirects = 0 }: HttpGetOptions = {}): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
        if (redirects > 5) { reject(new Error('слишком много редиректов')); return; }
        https.get(url, { headers: { 'User-Agent': 'Invis-updater', ...headers } }, (res) => {
            const code = res.statusCode ?? 0;
            if (code >= 300 && code < 400 && res.headers.location) {
                res.resume();
                resolve(httpsGet(new URL(res.headers.location, url).href, { headers, redirects: redirects + 1 }));
                return;
            }
            if (code !== 200) { res.resume(); reject(new Error(`HTTP ${code}`)); return; }
            resolve(res);
        }).on('error', reject);
    });
}

/* Последний стабильный релиз */
export async function latestRelease(): Promise<ReleaseInfo> {
    const res = await httpsGet(`https://api.github.com/repos/${REPO}/releases/latest`);
    let data = '';
    for await (const c of res) data += c;
    const rel = JSON.parse(data) as { tag_name?: string; assets?: Array<{ name: string; browser_download_url: string; size?: number }>; html_url?: string };
    if (!rel.tag_name) throw new Error('нет данных о релизе');
    let setupUrl: string | null = null;
    let setupSizeMb: number | null = null;
    let portableUrl: string | null = null;
    let portableSizeMb: number | null = null;
    let sumsUrl: string | null = null;
    for (const a of rel.assets || []) {
        if (/^Invis-Setup-.*\.exe$/.test(a.name)) { setupUrl = a.browser_download_url; setupSizeMb = a.size ? Math.round(a.size / 1048576) : null; }
        if (/^Invis-Portable-.*\.exe$/.test(a.name)) { portableUrl = a.browser_download_url; portableSizeMb = a.size ? Math.round(a.size / 1048576) : null; }
        if (a.name === 'SHA256SUMS.txt') sumsUrl = a.browser_download_url;
    }
    return {
        version: rel.tag_name.replace(/^v/, ''),
        tag: rel.tag_name,
        setupUrl,
        setupSizeMb,
        portableUrl,
        portableSizeMb,
        sumsUrl,
        htmlUrl: rel.html_url || `https://github.com/${REPO}/releases`,
    };
}

/* Текстовый GET (SHA256SUMS.txt и т.п.) */
export async function getText(url: string): Promise<string> {
    const res = await httpsGet(url);
    let data = '';
    for await (const c of res) data += c;
    return data;
}

/* Скачивание файла с прогрессом (percent 0–100) и таймаутом неактивности:
 * зависший CDN раньше навсегда оставлял updateState.downloading = true */
export async function download(url: string, dest: string, { onProgress, idleTimeoutMs = 30000 }: {
    onProgress?: (pct: number) => void;
    idleTimeoutMs?: number;
} = {}): Promise<string> {
    const res = await httpsGet(url);
    const total = Number(res.headers['content-length']) || 0;
    const out = fs.createWriteStream(dest);
    let done = 0;
    let lastPct = -1;
    let idle: NodeJS.Timeout | null = null;
    const armIdle = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => res.destroy(new Error(`загрузка остановилась (${idleTimeoutMs / 1000} с без данных)`)), idleTimeoutMs);
    };
    armIdle();
    res.on('data', (c: Buffer) => {
        armIdle();
        done += c.length;
        if (total && onProgress) {
            const pct = Math.floor((done / total) * 100);
            if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
        }
    });
    try {
        res.pipe(out);
        await new Promise<void>((resolve, reject) => {
            out.on('finish', () => resolve());
            out.on('error', reject);
            res.on('error', reject);
        });
    } finally {
        if (idle) clearTimeout(idle);
    }
    return dest;
}

/* SHA256SUMS.txt: "<hex>  <name>" → { name: hex } */
export function parseSums(text: string): Record<string, string> {
    const map: Record<string, string> = {};
    for (const line of String(text).split(/\r?\n/)) {
        const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
        if (m) map[m[2].trim()] = m[1].toLowerCase();
    }
    return map;
}

export function sha256File(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const s = fs.createReadStream(file);
        s.on('data', (c) => h.update(c));
        s.on('end', () => resolve(h.digest('hex')));
        s.on('error', reject);
    });
}
