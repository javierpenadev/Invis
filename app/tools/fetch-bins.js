/*
 * Скачивает официальные Windows-сборки демонов в bin/ (dev) — версии зафиксированы.
 * Запуск: node tools/fetch-bins.js
 * Извлечение: системный bsdtar (C:\Windows\System32\tar.exe) понимает и .zip, и .tar.gz.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const DOWNLOADS = path.join(ROOT, 'downloads');
const BIN = path.join(ROOT, 'bin');
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

const BINS = {
    tor: {
        version: '15.0.22',
        url: 'https://dist.torproject.org/torbrowser/15.0.22/tor-expert-bundle-windows-x86_64-15.0.22.tar.gz',
        file: 'tor.tar.gz',
        dir: path.join(BIN, 'tor'),
        check: path.join(BIN, 'tor', 'tor', 'tor.exe'),
    },
    dnscrypt: {
        version: '2.1.18',
        url: 'https://github.com/DNSCrypt/dnscrypt-proxy/releases/download/2.1.18/dnscrypt-proxy-win64-2.1.18.zip',
        file: 'dnscrypt.zip',
        dir: path.join(BIN, 'dnscrypt'),
        check: path.join(BIN, 'dnscrypt', 'win64', 'dnscrypt-proxy.exe'),
    },
    i2pd: {
        version: '2.61.0',
        url: 'https://github.com/PurpleI2P/i2pd/releases/download/2.61.0/i2pd_2.61.0_win64_mingw.zip',
        file: 'i2pd.zip',
        dir: path.join(BIN, 'i2pd'),
        check: path.join(BIN, 'i2pd', 'i2pd.exe'),
    },
};

function download(url, dest, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) return reject(new Error('слишком много редиректов'));
        https.get(url, { headers: { 'User-Agent': 'invis-fetch-bins' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(download(new URL(res.headers.location, url).href, dest, redirects + 1));
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} для ${url}`)); }
            const out = fs.createWriteStream(dest);
            res.pipe(out);
            out.on('finish', () => out.close(resolve));
            out.on('error', reject);
        }).on('error', reject);
    });
}

(async () => {
    fs.mkdirSync(DOWNLOADS, { recursive: true });
    for (const [name, bin] of Object.entries(BINS)) {
        if (fs.existsSync(bin.check)) {
            console.log(`[${name}] уже установлен (${bin.version})`);
            continue;
        }
        const archive = path.join(DOWNLOADS, bin.file);
        if (!fs.existsSync(archive)) {
            console.log(`[${name}] скачиваю ${bin.version}…`);
            await download(bin.url, archive);
        }
        console.log(`[${name}] распаковываю…`);
        fs.mkdirSync(bin.dir, { recursive: true });
        execFileSync(TAR, ['-xf', archive, '-C', bin.dir], { stdio: 'inherit' });
        if (!fs.existsSync(bin.check)) throw new Error(`${name}: не найден ${bin.check}`);
        console.log(`[${name}] готово: ${bin.check}`);
    }
    console.log('Все бинарники на месте.');
})().catch((e) => { console.error(e.message); process.exit(1); });
