/*
 * Пинг и скорость канала через Tor SOCKS (порт 9050) системным curl.exe.
 * Не зависит от Electron. SOCKS5-hostname: резолвинг имён тоже через Tor.
 */
const { spawn } = require('child_process');
const path = require('path');

const CURL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');

/* curl через Tor; resolve(err) — код выхода, resolve(out) — вывод -w */
function curl(args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const p = spawn(CURL, ['-s', '-o', 'NUL', '--socks5-hostname', '127.0.0.1:9050',
            '-m', String(Math.ceil(timeoutMs / 1000)), ...args],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        p.stdout.on('data', (c) => { out += c; });
        p.on('error', reject);
        p.on('close', (code) => {
            if (code !== 0) return reject(new Error(`curl завершился с кодом ${code}`));
            resolve(out.trim());
        });
        setTimeout(() => { try { p.kill(); } catch (e) { /* уже вышел */ } }, timeoutMs + 2000);
    });
}

/* GET JSON через Tor с телом ответа */
function curlJson(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const p = spawn(CURL, ['-s', '--socks5-hostname', '127.0.0.1:9050',
            '-m', String(Math.ceil(timeoutMs / 1000)), url],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        p.stdout.on('data', (c) => { out += c; });
        p.on('error', reject);
        p.on('close', (code) => {
            if (code !== 0) return reject(new Error(`Tor не отвечает (curl код ${code})`));
            try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('нечитаемый ответ')); }
        });
    });
}

/* Полный тест: IP/страна выхода, медианная задержка (3 запроса), скорость */
async function fullTest() {
    const info = await curlJson('https://check.torproject.org/api/ip', 20000);
    const times = [];
    for (let i = 0; i < 3; i++) {
        const t = await curl(['-w', '%{time_starttransfer}', 'https://check.torproject.org/api/ip'], 20000);
        const v = parseFloat(t);
        if (isFinite(v)) times.push(v);
    }
    times.sort((a, b) => a - b);
    const medianMs = times.length ? Math.round(times[Math.floor(times.length / 2)] * 1000) : null;
    const speedOut = await curl(['-w', '%{speed_download}', 'https://speed.cloudflare.com/__down?bytes=8000000'], 60000);
    const bytesPerSec = parseFloat(speedOut);
    if (!isFinite(bytesPerSec) || bytesPerSec <= 0) throw new Error('не удалось измерить скорость');
    const mbps = Math.round(bytesPerSec * 8 / 10000) / 100; /* Мбит/с, 2 знака */
    return {
        ip: info.IP || null,
        country: (info.Country || '').toUpperCase() || null,
        isTor: Boolean(info.IsTor),
        medianMs,
        mbps,
    };
}

module.exports = { fullTest };
