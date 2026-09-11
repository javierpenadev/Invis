/*
 * NetMode: перехват системного DNS на 127.0.0.1 (порт 53 у dnscrypt-proxy).
 * Все привилегированные операции требуют прав администратора (isElevated).
 * Не зависит от Electron — тестируется из node.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';

export interface DnsBackupEntry {
    alias: string;
    addresses: string[];
}

export type DnsBackup = DnsBackupEntry[];

const PS_PREFIX = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;';

function ps(script: string, timeout = 20000): string {
    return execFileSync('powershell',
        ['-NoProfile', '-NonInteractive', '-Command', PS_PREFIX + script],
        { encoding: 'utf8', windowsHide: true, timeout });
}

/* Права администратора: 'net session' доступен только админам */
export function isElevated(): boolean {
    try {
        execFileSync('net', ['session'], { windowsHide: true, stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
}

const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;

/* Строгая проверка DNS-адреса: значения попадают в PowerShell-команды
 * (в т.ч. читаемые из dns-backup.json) — пропускаем только символы,
 * из которых состоит IP: цифры, hex, точки и двоеточия. */
const IPV_RE = /^[0-9a-fA-F.:]{2,45}$/;
export const isValidIp = (a: unknown): a is string => typeof a === 'string' && IPV_RE.test(a);

/* Активные физические адаптеры (виртуальные Hyper-V/WSL исключаются) */
export function getUpPhysicalAdapters(): string[] {
    const out = ps("Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | ForEach-Object { $_.Name }");
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/* DNS-серверы адаптера (IPv4+IPv6) */
export function getDnsServers(alias: string): string[] {
    const out = ps(`Get-DnsClientServerAddress -InterfaceAlias ${q(alias)} | ` +
        'Where-Object ServerAddresses | ForEach-Object { $_.ServerAddresses }');
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

export function setDnsLoopback(alias: string): void {
    ps(`Set-DnsClientServerAddress -InterfaceAlias ${q(alias)} -ServerAddresses '127.0.0.1'`);
}

export function setDnsList(alias: string, addresses: string[]): void {
    const valid = addresses.filter(isValidIp);
    if (!valid.length) throw new Error('нет валидных DNS-адресов для восстановления');
    const list = valid.map((a) => `'${a}'`).join(',');
    ps(`Set-DnsClientServerAddress -InterfaceAlias ${q(alias)} -ServerAddresses ${list}`);
}

export function resetDns(alias: string): void {
    ps(`Set-DnsClientServerAddress -InterfaceAlias ${q(alias)} -ResetServerAddresses`);
}

/* Кто слушает локальный порт 53 (UDP+TCP). Возвращает имя процесса или null. */
export function port53Owner(): string | null {
    const pids = new Set<string>();
    for (const proto of ['udp', 'tcp']) {
        let lines = '';
        try {
            lines = execFileSync('netstat', ['-ano', '-p', proto], { encoding: 'utf8', windowsHide: true });
        } catch (e) { continue; }
        for (const line of lines.split(/\r?\n/)) {
            const tok = line.trim().split(/\s+/);
            /* UDP:  Proto Local Foreign PID
               TCP:  Proto Local Foreign State PID */
            if (tok.length >= 4 && /:53$/i.test(tok[1])) pids.add(tok[tok.length - 1]);
        }
    }
    if (!pids.size) return null;
    try {
        const out = execFileSync('tasklist', ['/fi', `PID eq ${[...pids][0]}`, '/fo', 'csv', '/nh'],
            { encoding: 'utf8', windowsHide: true });
        const name = out.split(',')[0]?.replace(/^"/, '').replace(/"$/, '').trim();
        return name || 'неизвестный процесс';
    } catch (e) {
        return 'неизвестный процесс';
    }
}

/* Бэкап/восстановление состояния DNS */
export function writeBackup(file: string, data: DnsBackup): void {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

export function readBackup(file: string): DnsBackup | null {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

export function removeBackup(file: string): void {
    try { fs.unlinkSync(file); } catch (e) { /* нет файла */ }
}
