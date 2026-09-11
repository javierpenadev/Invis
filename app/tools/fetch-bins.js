/*
 * Скачивает официальные Windows-сборки демонов в bin/ (dev) — версии и
 * SHA-256 зафиксированы (SEC-5: supply chain). Запуск: node tools/fetch-bins.js
 * Извлечение: системный bsdtar (C:\Windows\System32\tar.exe) понимает и .zip, и .tar.gz.
 * При смене версии: обнови url/version и ПЕРЕСЧИТАЙ sha256 (sha256sum downloads/<file>)
 * с официального архива, иначе скрипт откажется упаковывать.
 */
const { execFileSync } = require('child_process');
const crypto = require('crypto');
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
        sha256: '231dad6b9cb401a54c260db7046965ef04e4f72ff071b140d423fb5da281ab1e',
    },
    dnscrypt: {
        version: '2.1.18',
        url: 'https://github.com/DNSCrypt/dnscrypt-proxy/releases/download/2.1.18/dnscrypt-proxy-win64-2.1.18.zip',
        file: 'dnscrypt.zip',
        dir: path.join(BIN, 'dnscrypt'),
        check: path.join(BIN, 'dnscrypt', 'win64', 'dnscrypt-proxy.exe'),
        sha256: '15f0c8f1f40620a54ddfd8752c327dabe1146f84618d68874f79c4f52490b396',
    },
    i2pd: {
        version: '2.61.0',
        url: 'https://github.com/PurpleI2P/i2pd/releases/download/2.61.0/i2pd_2.61.0_win64_mingw.zip',
        file: 'i2pd.zip',
        dir: path.join(BIN, 'i2pd'),
        check: path.join(BIN, 'i2pd', 'i2pd.exe'),
        sha256: 'a0a8fb199a6bc5b487df71567791de6997050b921d65622ef9e936ffa88bc83f',
    },
};

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

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
        /* Кэшированный архив сверяем с эталоном: битый/подменённый — перекачиваем */
        if (fs.existsSync(archive) && sha256File(archive) !== bin.sha256) {
            console.log(`[${name}] архив в downloads не совпал с SHA-256 — перекачиваю`);
            fs.unlinkSync(archive);
        }
        if (!fs.existsSync(archive)) {
            console.log(`[${name}] скачиваю ${bin.version}…`);
            await download(bin.url, archive);
        }
        /* Распаковываем ТОЛЬКО сверенный архив */
        const hex = sha256File(archive);
        if (hex !== bin.sha256) {
            throw new Error(`${name}: SHA-256 архива не совпал (${hex.slice(0, 12)}…, ожидался ${bin.sha256.slice(0, 12)}…)`);
        }
        console.log(`[${name}] SHA-256 сверен, распаковываю…`);
        fs.mkdirSync(bin.dir, { recursive: true });
        execFileSync(TAR, ['-xf', archive, '-C', bin.dir], { stdio: 'inherit' });
        if (!fs.existsSync(bin.check)) throw new Error(`${name}: не найден ${bin.check}`);
        /* Проверенный архив больше не нужен — не держим 30 МБ мусора */
        fs.unlinkSync(archive);
        console.log(`[${name}] готово: ${bin.check}`);
    }
    console.log('Все бинарники на месте.');
})().catch((e) => { console.error(e.message); process.exit(1); });
