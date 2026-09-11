/*
 * NetMode: перехват системного DNS на 127.0.0.1 (порт 53 у dnscrypt-proxy).
 * Все привилегированные операции требуют прав администратора (isElevated).
 * Не зависит от Electron — тестируется из node.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');

const PS_PREFIX = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;';

function ps(script, timeout = 20000) {
    return execFileSync('powershell',
        ['-NoProfile', '-NonInteractive', '-Command', PS_PREFIX + script],
        { encoding: 'utf8', windowsHide: true, timeout });
}

/* Права администратора: 'net session' доступен только админам */
function isElevated() {
    try {
        execFileSync('net', ['session'], { windowsHide: true, stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/* Строгая проверка DNS-адреса: значения попадают в PowerShell-команды
 * (в т.ч. читаемые из dns-backup.json) — пропускаем только символы,
 * из которых состоит IP: цифры, hex, точки и двоеточия. */
const IPV_RE = /^[0-9a-fA-F.:]{2,45}$/;
const isValidIp = (a) => typeof a === 'string' && IPV_RE.test(a);

/* Активные физические адаптеры (виртуальные Hyper-V/WSL исключаются) */
function getUpPhysicalAdapters() {
    const out = ps("Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | ForEach-Object { $_.Name }");
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/* DNS-серверы адаптера (IPv4+IPv6) */
function getDnsServers(alias) {
    const out = ps(`Get-DnsClientServerAddress -InterfaceAlias ${q(alias)} | ` +
        'Where-Object ServerAddresses | ForEach-Object { $_.ServerAddresses }');
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function setDnsLoopback(alias) {
    ps(`Set-DnsClientServerAddress -InterfaceAlias ${q(alias)} -ServerAddresses '127.0.0.1'`);
}

function setDnsList(alias, addresses) {
    const valid = addresses.filter(isValidIp);
    if (!valid.length) throw new Error('нет валидных DNS-адресов для восстановления');
    const list = valid.map((a) => `'${a}'`).join(',');
    ps(`Set-DnsClientServerAddress -InterfaceAlias ${q(alias)} -ServerAddresses ${list}`);
}

function resetDns(alias) {
    ps(`Set-DnsClientServerAddress -InterfaceAlias ${q(alias)} -ResetServerAddresses`);
}

/* Кто слушает локальный порт 53 (UDP+TCP). Возвращает имя процесса или null. */
function port53Owner() {
    const pids = new Set();
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
function writeBackup(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); }
function readBackup(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function removeBackup(file) { try { fs.unlinkSync(file); } catch (e) { /* нет файла */ } }

module.exports = {
    isElevated,
    isValidIp,
    getUpPhysicalAdapters,
    getDnsServers,
    setDnsLoopback,
    setDnsList,
    resetDns,
    port53Owner,
    writeBackup,
    readBackup,
    removeBackup,
};
