/*
 * Системный прокси Windows (WinINET, HKCU): направление на локальный Tor SOCKS.
 * Бэкап прежних настроек + восстановление. Без прав администратора.
 * Не зависит от Electron (tempPath передаётся параметром).
 */
const fs = require('fs');
const { execFileSync } = require('child_process');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function ps(script, timeout = 15000) {
    return execFileSync('powershell',
        ['-NoProfile', '-NonInteractive', '-Command',
         `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`],
        { encoding: 'utf8', windowsHide: true, timeout });
}

/* Уведомить систему об изменении настроек прокси (InternetSetOption 39 + 37) */
function refreshWininet(tempPath) {
    const ps1 = path.join(tempPath, 'invis-proxy-refresh.ps1');
    fs.writeFileSync(ps1, [
        "Add-Type -Namespace W -Name I -MemberDefinition '[DllImport(\"wininet.dll\", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);'",
        '[W.I]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)',
        '[W.I]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)',
    ].join('\r\n'), 'utf8');
    execFileSync('powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
        { windowsHide: true, timeout: 15000, stdio: 'ignore' });
    return true;
}

function regQueryValue(name) {
    try {
        const out = execFileSync('reg', ['query', KEY, '/v', name],
            { encoding: 'utf8', windowsHide: true });
        const m = out.match(new RegExp(name + '\\s+REG_\\S+\\s+(\\S+)'));
        return m ? m[1] : null;
    } catch (e) {
        return null; // значения нет
    }
}

function regSet(name, type, value) {
    execFileSync('reg', ['add', KEY, '/v', name, '/t', type, '/d', value, '/f'],
        { windowsHide: true, stdio: 'ignore' });
}

function regDelete(name) {
    try {
        execFileSync('reg', ['delete', KEY, '/v', name, '/f'], { windowsHide: true, stdio: 'ignore' });
    } catch (e) { /* значения не было */ }
}

/* Текущее состояние прокси WinINET */
function readState() {
    return {
        proxyEnable: regQueryValue('ProxyEnable'),
        proxyServer: regQueryValue('ProxyServer'),
        autoConfigUrl: regQueryValue('AutoConfigURL'),
    };
}

/* Направить системный прокси на SOCKS Tor */
function apply(socksAddr, tempPath) {
    const backup = readState();
    regSet('ProxyEnable', 'REG_DWORD', '1');
    regSet('ProxyServer', 'REG_SZ', `socks=${socksAddr}`);
    regDelete('AutoConfigURL'); // PAC перекрыл бы наши настройки
    const refreshed = refreshWininet(tempPath);
    return { backup, refreshed };
}

/* Вернуть сохранённые значения */
function restore(backup, tempPath) {
    if (backup && backup.proxyServer) {
        regSet('ProxyEnable', 'REG_DWORD', backup.proxyEnable === '0x1' ? '1' : '0');
        regSet('ProxyServer', 'REG_SZ', backup.proxyServer);
        if (backup.autoConfigUrl) regSet('AutoConfigURL', 'REG_SZ', backup.autoConfigUrl);
        else regDelete('AutoConfigURL');
    } else {
        regSet('ProxyEnable', 'REG_DWORD', '0');
        regDelete('ProxyServer');
    }
    try { refreshWininet(tempPath); } catch (e) { /* best effort */ }
}

module.exports = { readState, apply, restore };
