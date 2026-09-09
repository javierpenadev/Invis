/*
 * Авто-обновление: проверка релизов GitHub, сравнение версий, скачивание.
 * Без внешних зависимостей. Публикуемые артефакты:
 *   Invis-Setup-<ver>.exe    — NSIS-установщик
 *   Invis-Portable-<ver>.exe — портативный
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

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

/* Последний стабильный релиз: {version, tag, setupUrl, portableUrl} */
async function latestRelease() {
    const res = await httpsGet(`https://api.github.com/repos/${REPO}/releases/latest`);
    let data = '';
    for await (const c of res) data += c;
    const rel = JSON.parse(data);
    if (!rel.tag_name) throw new Error('нет данных о релизе');
    let setupUrl = null;
    let portableUrl = null;
    for (const a of rel.assets || []) {
        if (/^Invis-Setup-.*\.exe$/.test(a.name)) setupUrl = a.browser_download_url;
        if (/^Invis-Portable-.*\.exe$/.test(a.name)) portableUrl = a.browser_download_url;
    }
    return {
        version: rel.tag_name.replace(/^v/, ''),
        tag: rel.tag_name,
        setupUrl,
        portableUrl,
        htmlUrl: rel.html_url,
    };
}

/* Скачивание файла с прогрессом (percent 0–100) */
async function download(url, dest, { onProgress } = {}) {
    const res = await httpsGet(url);
    const total = Number(res.headers['content-length']) || 0;
    const out = fs.createWriteStream(dest);
    let done = 0;
    let lastPct = -1;
    res.on('data', (c) => {
        done += c.length;
        if (total && onProgress) {
            const pct = Math.floor((done / total) * 100);
            if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
        }
    });
    res.pipe(out);
    await new Promise((resolve, reject) => {
        out.on('finish', resolve);
        out.on('error', reject);
        res.on('error', reject);
    });
    return dest;
}

module.exports = { REPO, isNewer, latestRelease, download };
