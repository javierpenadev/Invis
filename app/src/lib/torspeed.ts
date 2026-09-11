/*
 * Пинг и скорость канала через Tor SOCKS (порт 9050) системным curl.exe.
 * Не зависит от Electron. SOCKS5-hostname: резолвинг имён тоже через Tor.
 */
import { spawn } from 'child_process';
import * as path from 'path';

const CURL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');

/* curl через Tor; resolve(err) — код выхода, resolve(out) — вывод -w */
function curl(args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const p = spawn(CURL, ['-s', '-o', 'NUL', '--socks5-hostname', '127.0.0.1:9050',
            '-m', String(Math.ceil(timeoutMs / 1000)), ...args],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        p.stdout.on('data', (c: Buffer) => { out += c; });
        p.on('error', reject);
        p.on('close', (code) => {
            if (code !== 0) { reject(new Error(`curl завершился с кодом ${code}`)); return; }
            resolve(out.trim());
        });
        setTimeout(() => { try { p.kill(); } catch (e) { /* уже вышел */ } }, timeoutMs + 2000);
    });
}

/* GET JSON через Tor с телом ответа */
function curlJson(url: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const p = spawn(CURL, ['-s', '--socks5-hostname', '127.0.0.1:9050',
            '-m', String(Math.ceil(timeoutMs / 1000)), url],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        p.stdout.on('data', (c: Buffer) => { out += c; });
        p.on('error', reject);
        p.on('close', (code) => {
            if (code !== 0) { reject(new Error(`Tor не отвечает (curl код ${code})`)); return; }
            try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('нечитаемый ответ')); }
        });
    });
}

export interface FullTestResult {
    ip: string | null;
    country: string | null;
    isTor: boolean;
    medianMs: number | null;
    mbps: number;
}

/* Полный тест: IP/страна выхода, медианная задержка (3 запроса), скорость */
export async function fullTest(): Promise<FullTestResult> {
    const info = await curlJson('https://check.torproject.org/api/ip', 20000) as { IP?: string; Country?: string; IsTor?: boolean };
    const times: number[] = [];
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

export interface ExitInfoResult {
    ok: true;
    ip: string;
    city: string;
    country: string;
    cc: string;
    pingMs: number | null;
}

/* IP/город/страна выхода через Tor + медианный пинг (3 замера).
 * HTTPS обязателен (SEC-7): exit-узел мог бы подменять http-ответ
 * и подсовывать ложную «текущую страну» — подрыв собственного индикатора. */
export async function exitInfo(): Promise<ExitInfoResult> {
    const URL_ = 'https://free.freeipapi.com/api/json';
    const curlOut = (args: string[], timeoutMs: number): Promise<string> => new Promise((resolve, reject) => {
        const p = spawn(CURL, ['-s', '--socks5-hostname', '127.0.0.1:9050',
            '-m', String(Math.ceil(timeoutMs / 1000)), ...args],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        p.stdout.on('data', (c: Buffer) => { out += c; });
        p.on('error', reject);
        p.on('close', (code) => {
            if (code !== 0) { reject(new Error('Tor не отвечает (curl код ' + code + ')')); return; }
            resolve(out);
        });
    });
    const raw = await curlOut([URL_], 15000);
    let data: { ipAddress?: string; cityName?: string; countryName?: string; countryCode?: string };
    try { data = JSON.parse(raw); } catch (e) { throw new Error('нечитаемый ответ geoip'); }
    if (!data.ipAddress) throw new Error('geoip: нет IP в ответе');
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
        const t = await curlOut(['-o', 'NUL', '-w', '%{time_starttransfer}', URL_], 15000);
        const v = parseFloat(t);
        if (isFinite(v)) times.push(v);
    }
    times.sort((a, b) => a - b);
    const pingMs = times.length ? Math.round(times[Math.floor(times.length / 2)] * 1000) : null;
    return {
        ok: true,
        ip: data.ipAddress,
        city: data.cityName || '',
        country: data.countryName || '',
        cc: (data.countryCode || '').toUpperCase(),
        pingMs,
    };
}
