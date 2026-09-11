/*
 * Лёгкое измерение скорости канала системным curl.exe: напрямую или через
 * Tor SOCKS. Небольшой файл раз в несколько минут — нагрузку на сеть
 * и систему держим минимальной. Не зависит от Electron.
 */
import { spawn } from 'child_process';
import * as path from 'path';

const CURL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');

export function measure({ viaTor = false, bytes = 1048576, timeoutMs = 25000 }: {
    viaTor?: boolean;
    bytes?: number;
    timeoutMs?: number;
} = {}): Promise<number> {
    return new Promise((resolve, reject) => {
        const args = ['-s', '-o', 'NUL', '-w', '%{speed_download}',
            '-m', String(Math.ceil(timeoutMs / 1000)),
            ...(viaTor ? ['--socks5-hostname', '127.0.0.1:9050'] : []),
            `https://speed.cloudflare.com/__down?bytes=${bytes}`];
        const p = spawn(CURL, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        p.stdout.on('data', (c: Buffer) => { out += c; });
        p.on('error', reject);
        p.on('close', (code) => {
            const bps = parseFloat(out);
            if (code !== 0 || !isFinite(bps) || bps <= 0) { reject(new Error('замер не удался')); return; }
            resolve(Math.round(bps * 8 / 1e5) / 10); /* Мбит/с, 1 знак */
        });
    });
}
