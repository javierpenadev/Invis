/*
 * Системный прокси Windows (WinINET, HKCU): направление на локальный Tor SOCKS.
 * Бэкап прежних настроек + восстановление. Без прав администратора.
 * Не зависит от Electron (tempPath передаётся параметром).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function ps(script, timeout = 15000) {
    return execFileSync('powershell',
        ['-NoProfile', '-NonInteractive', '-Command',
         `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`],
        { encoding: 'utf8', windowsHide: true, timeout });
}

/* Уведомить систему об изменении настроек прокси (InternetSetOption 39 + 37).
 * Скрипт — в случайном mkdtemp-каталоге (SEC-8): предсказуемое имя в %TEMP%
 * позволяло тому же пользователю подменить файл между записью и запуском. */
function refreshWininet(tempPath) {
    const dir = fs.mkdtempSync(path.join(tempPath, 'invis-proxy-'));
    const ps1 = path.join(dir, 'refresh.ps1');
    fs.writeFileSync(ps1, [
        "Add-Type -Namespace W -Name I -MemberDefinition '[DllImport(\"wininet.dll\", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);'",
        '[W.I]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)',
        '[W.I]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)',
    ].join('\r\n'), 'utf8');
    try {
        execFileSync('powershell',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
            { windowsHide: true, timeout: 15000, stdio: 'ignore' });
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* не критично */ }
    }
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
        proxyOverride: regQueryValue('ProxyOverride'),
        autoConfigUrl: regQueryValue('AutoConfigURL'),
    };
}

/* localhost и частные подсети — мимо Tor: иначе из браузера недоступны
 * консоль I2P (127.0.0.1:7070) и админки локальной сети */
const BYPASS_LIST = 'localhost;127.*;10.*;172.*;192.168.*;<local>';

/* Направить системный прокси на SOCKS Tor */
function apply(socksAddr, tempPath) {
    const backup = readState();
    regSet('ProxyEnable', 'REG_DWORD', '1');
    regSet('ProxyServer', 'REG_SZ', `socks=${socksAddr}`);
    regSet('ProxyOverride', 'REG_SZ', BYPASS_LIST);
    regDelete('AutoConfigURL'); // PAC перекрыл бы наши настройки
    const refreshed = refreshWininet(tempPath);
    return { backup, refreshed };
}

/* Вернуть сохранённые значения */
function restore(backup, tempPath) {
    if (backup && backup.proxyServer) {
        regSet('ProxyEnable', 'REG_DWORD', backup.proxyEnable === '0x1' ? '1' : '0');
        regSet('ProxyServer', 'REG_SZ', backup.proxyServer);
        if (backup.proxyOverride) regSet('ProxyOverride', 'REG_SZ', backup.proxyOverride);
        else regDelete('ProxyOverride');
        if (backup.autoConfigUrl) regSet('AutoConfigURL', 'REG_SZ', backup.autoConfigUrl);
        else regDelete('AutoConfigURL');
    } else {
        regSet('ProxyEnable', 'REG_DWORD', '0');
        regDelete('ProxyServer');
        regDelete('ProxyOverride');
    }
    try { refreshWininet(tempPath); } catch (e) { /* best effort */ }
}

/* Включён ли системный прокси, выставленный Invis (наш отпечаток в реестре) */
function isOursActive() {
    const s = readState();
    return s.proxyEnable === '0x1' && (s.proxyServer || '') === 'socks=127.0.0.1:9050';
}

module.exports = { readState, isOursActive, apply, restore };
