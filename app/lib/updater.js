/*
 * Авто-обновление: проверка релизов GitHub, сравнение версий, скачивание,
 * сверка SHA-256 с SHA256SUMS.txt из релиза (тихая установка ставится только
 * после сверки целостности). Без внешних зависимостей. Публикуемые артефакты:
 *   Invis-Setup-<ver>.exe    — NSIS-установщик
 *   Invis-Portable-<ver>.exe — портативный
 *   SHA256SUMS.txt           — контрольные суммы (npm run checksums)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const REPO = 'javierpenadev/Invis';

/* 1.2.0 → [1,2,0]; сравнение по сегментам */
function isNewer(remote, local) {
    const r = String(remote).split('.').map((n) => parseInt(n, 10) || 0);
    const l = String(local).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
        if ((r[i] || 0) > (l[i] || 0)) return true;
        if ((r[i] || 0) < (l[i] || 0)) return false;
    }
    return false;
}

function httpsGet(url, { headers = {}, redirects = 0, onProgress } = {}) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) return reject(new Error('слишком много редиректов'));
        https.get(url, { headers: { 'User-Agent': 'Invis-updater', ...headers } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(httpsGet(new URL(res.headers.location, url).href, { headers, redirects: redirects + 1, onProgress }));
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
            resolve(res);
        }).on('error', reject);
    });
}

/* Последний стабильный релиз: {version, tag, setupUrl, portableUrl, sumsUrl} */
async function latestRelease() {
    const res = await httpsGet(`https://api.github.com/repos/${REPO}/releases/latest`);
    let data = '';
    for await (const c of res) data += c;
    const rel = JSON.parse(data);
    if (!rel.tag_name) throw new Error('нет данных о релизе');
    let setupUrl = null;
    let portableUrl = null;
    let sumsUrl = null;
    for (const a of rel.assets || []) {
        if (/^Invis-Setup-.*\.exe$/.test(a.name)) setupUrl = a.browser_download_url;
        if (/^Invis-Portable-.*\.exe$/.test(a.name)) portableUrl = a.browser_download_url;
        if (a.name === 'SHA256SUMS.txt') sumsUrl = a.browser_download_url;
    }
    return {
        version: rel.tag_name.replace(/^v/, ''),
        tag: rel.tag_name,
        setupUrl,
        portableUrl,
        sumsUrl,
        htmlUrl: rel.html_url,
    };
}

/* Текстовый GET (SHA256SUMS.txt и т.п.) */
async function getText(url) {
    const res = await httpsGet(url);
    let data = '';
    for await (const c of res) data += c;
    return data;
}

/* Скачивание файла с прогрессом (percent 0–100) и таймаутом неактивности:
 * зависший CDN раньше навсегда оставлял updateState.downloading = true */
async function download(url, dest, { onProgress, idleTimeoutMs = 30000 } = {}) {
    const res = await httpsGet(url);
    const total = Number(res.headers['content-length']) || 0;
    const out = fs.createWriteStream(dest);
    let done = 0;
    let lastPct = -1;
    let idle = null;
    const armIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => res.destroy(new Error(`загрузка остановилась (${idleTimeoutMs / 1000} с без данных)`)), idleTimeoutMs);
    };
    armIdle();
    res.on('data', (c) => {
        armIdle();
        done += c.length;
        if (total && onProgress) {
            const pct = Math.floor((done / total) * 100);
            if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
        }
    });
    try {
        res.pipe(out);
        await new Promise((resolve, reject) => {
            out.on('finish', resolve);
            out.on('error', reject);
            res.on('error', reject);
        });
    } finally {
        clearTimeout(idle);
    }
    return dest;
}

/* SHA256SUMS.txt: "<hex>  <name>" → { name: hex } */
function parseSums(text) {
    const map = {};
    for (const line of String(text).split(/\r?\n/)) {
        const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
        if (m) map[m[2].trim()] = m[1].toLowerCase();
    }
    return map;
}

function sha256File(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const s = fs.createReadStream(file);
        s.on('data', (c) => h.update(c));
        s.on('end', () => resolve(h.digest('hex')));
        s.on('error', reject);
    });
}

module.exports = { REPO, isNewer, latestRelease, download, getText, parseSums, sha256File };
