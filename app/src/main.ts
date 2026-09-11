/*
 * Invis — Electron-оболочка tray-приложения.
 * Окно маленькое, закрывается в трей; настройки — JSON (store).
 * Точки расширения помечены «Точка расширения:» (демоны, IPC-каналы и т.п.).
 */
import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, clipboard, shell, screen } from 'electron';
import { spawn, execFileSync, execFile } from 'child_process';
import { pathToFileURL } from 'url';
import * as fs from 'fs';
import * as path from 'path';

import * as store from './store';
import { buildAll as buildConfigs, PORTS } from './lib/configs';
import { DaemonSupervisor, DaemonState, ModuleStatus } from './lib/daemons';
import * as netmode from './lib/netmode';
import { readResolvers } from './lib/resolvers';
import * as torctl from './lib/torctl';
import * as diag from './lib/diag';
import * as blocklists from './lib/blocklists';
import * as bridges from './lib/bridges';
import * as updater from './lib/updater';
import * as proxy from './lib/proxy';
import * as ipinfo from './lib/ipinfo';
import * as onionoo from './lib/onionoo';
import * as torspeed from './lib/torspeed';
import * as netspeed from './lib/netspeed';
import { Settings, SettingsPatch, DaemonName } from './types';
import type { DnsBackupEntry } from './lib/netmode';
import type { ExitInfoResult } from './lib/torspeed';

/* Тестовый изолированный профиль: INVIS_USERDATA=<каталог> — настройки и
 * данные живут там, реальные настройки пользователя не затрагиваются.
 * До загрузки store (settings грузятся на инициализации модуля). */
if (process.env.INVIS_USERDATA) {
    app.setPath('userData', process.env.INVIS_USERDATA);
}

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayState: string | null = null;
const trayIcons: Record<string, Electron.NativeImage> = {};
let quitting = false;          // true — выходим по-настоящему, а не сворачиваемся
interface TraySpeed { mbps: number; viaTor: boolean; }
const trayInfo: { exit: ExitInfoResult | null; speed: TraySpeed | null } = { exit: null, speed: null };   // кэш для меню трея
let balloonShown = false;      // подсказка «работает в трее» — один раз за сессию
let settings: Settings = store.load();
let supervisor: DaemonSupervisor | null = null;
let configDirGlobal: string | null = null;
let dnsApplied = false;        // системный DNS направлен на 127.0.0.1
let dnsAppliedAdapters: string[] = []; // адаптеры, реально перехваченные сейчас
let newIpTimer: NodeJS.Timeout | null = null;         // авто-смена IP Tor
let cleanupDone = false;       // очистка перед выходом выполнена
const startupWarnings: string[] = [];   // предупреждения для UI после создания окна
let proxyApplied = false;      // системный прокси направлен на Tor

const TITLE = 'Invis';
/* Корень приложения: исходники живут в src/, компилируются в dist/ —
 * __dirname указывает на dist, все статические файлы (index.html, assets,
 * preload, bin в dev) — на уровень выше. В сборке это корень asar. */
const APP_ROOT = path.join(__dirname, '..');
const DAEMON_VERSIONS = { tor: '0.4.9.12', dnscrypt: '2.1.18', i2pd: '2.61.0' };
const dnsBackupFile = () => path.join(store.baseDir(), 'dns-backup.json');

/* dns-backup.json попадает в PowerShell-команды (в т.ч. запускаемые под UAC) —
 * принимаем только строгую схему [{alias, addresses[]}], адреса — только
 * символы IP. Всё остальное отбрасываем: файл в userData может быть подменён
 * малварью того же пользователя (см. таск-лист аудита SEC-2). */
const IPV_RE = /^[0-9a-fA-F.:]{2,45}$/;
function sanitizeDnsBackup(raw: unknown): DnsBackupEntry[] | null {
    if (!Array.isArray(raw)) return null;
    const out: DnsBackupEntry[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object'
                || typeof (item as { alias?: unknown }).alias !== 'string'
                || !(item as { alias: string }).alias.trim()
                || !Array.isArray((item as { addresses?: unknown }).addresses)) continue;
        const rec = item as { alias: string; addresses: unknown[] };
        const addresses = rec.addresses.filter((a): a is string => typeof a === 'string' && IPV_RE.test(a));
        out.push({ alias: rec.alias.trim(), addresses });
    }
    return out.length ? out : null;
}

/* ---------- единственный экземпляр ---------- */
/* relaunchElevated стартует новый процесс, пока старый ещё завершается
 * (блокирующая очистка демонов занимает секунды) — lock бывает занят.
 * Даём новому экземпляру до 10 с на его освобождение. */
function run(): void {
    app.on('second-instance', () => showWindow());
    app.whenReady().then(onReady);
}
if (app.requestSingleInstanceLock()) {
    run();
} else {
    const startedAt = Date.now();
    const retry = setInterval(() => {
        if (app.requestSingleInstanceLock()) {
            clearInterval(retry);
            run();
        } else if (Date.now() - startedAt > 10000) {
            clearInterval(retry);
            app.quit();
        }
    }, 250);
}

function onReady(): void {
    /* Применяем автозапуск с Windows (синхронизирует реестр с настройкой) */
    applyLaunchWithWindows();

    const base = store.baseDir();
    configDirGlobal = path.join(base, 'configs');

    /* Восстановление системного DNS, если прошлый сеанс завершился некорректно */
    recoverSystemDnsIfNeeded();

    /* Восстановление системного прокси после некорректного завершения */
    if (fs.existsSync(proxyBackupFile())) {
        restoreSystemProxy();
        console.warn('[Invis] Системный прокси восстановлен после сбоя');
    } else if (proxy.isOursActive()) {
        /* Бэкапа нет, а наш прокси в реестре висит (процесс убили) — снимаем,
         * иначе весь трафик системы упирается в мёртвый SOCKS 9050 */
        proxy.restore(null, app.getPath('temp'));
        netmodeLog('Обнаружен включённый прокси Invis без бэкапа — сброшен');
    }

    /* Перехват системного DNS, включённый в настройках.
     * Настройку не сбрасываем — пользовательское решение сохраняется,
     * проблемы сообщаем предупреждением. */
    if (settings.systemDns) {
        if (netmode.isElevated()) {
            const r = applySystemDns();
            if (!r.ok) startupWarnings.push(`Перехват DNS не применён: ${r.error}`);
        } else {
            startupWarnings.push('Перехват DNS включён в настройках, но Invis запущен без прав администратора — запустите от администратора или выключите галку.');
        }
    }

    /* Конфиги и супервизор демонов (bin/ — npm run fetch-bins, см. README) */
    buildConfigs({
        configDir: configDirGlobal,
        torDataDir: path.join(base, 'data', 'tor'),
        i2pDataDir: path.join(base, 'data', 'i2pd'),
        geoipDir: path.join(binDir(), 'tor', 'data'),
        torPluginDir: path.join(binDir(), 'tor', 'tor', 'pluggable_transports'),
        i2pdContribDir: path.join(binDir(), 'i2pd', 'contrib'),
        dnscryptListen: dnsApplied ? 53 : PORTS.dnscrypt,
        dnscryptCfg: settings.dnscrypt,
        torCfg: settings.tor,
    });
    supervisor = new DaemonSupervisor({
        binDir: binDir(),
        configDir: configDirGlobal,
        logDir: path.join(base, 'logs'),
        i2pdDataDir: path.join(base, 'data', 'i2pd'),
        dnscryptPort: dnsApplied ? 53 : PORTS.dnscrypt,
        onState: (payload) => {
            sendToRenderer('modules:state', payload);
            setTrayState(aggregateTrayState());
            tray?.setContextMenu(trayMenu());
            /* Системный прокси живёт вместе с Tor: галка-настройка сохраняется,
             * снимается/возвращается только эффект */
            if (payload.name === 'tor') {
                if ((payload.state === 'off' || payload.state === 'error') && proxyEffectActive()) {
                    restoreSystemProxy();
                    sendToRenderer('modules:event', { text: 'Tor остановлен — системный прокси снят (галка сохранена)' });
                } else if (payload.state === 'on' && settings.systemProxy && !proxyApplied) {
                    const r = applySystemProxy();
                    if (r.ok) sendToRenderer('modules:event', { text: 'Системный прокси направлен на Tor' });
                }
            } else if (payload.name === 'i2p' && payload.state === 'on') {
                /* mingw-сборка i2pd сама создаёт иконку в трее (compile-time
                 * USE_WIN32_APP) — в трее должен остаться только Invis */
                hideI2pdTrayIcon();
                setTimeout(hideI2pdTrayIcon, 3000); // страховка от гонки со стартом
            } else if (payload.name === 'dnscrypt'
                    && (payload.state === 'off' || payload.state === 'error') && dnsApplied) {
                /* dnscrypt остановился/упал сам — адаптеры нельзя оставлять на 127.0.0.1 */
                void disableSystemDns(false);
                sendToRenderer('modules:event', { text: 'DNSCrypt остановлен — системный DNS восстановлен (галка сохранена)' });
            }
        },
    });

    createWindow();
    initTrayIcons();
    createTray();
    scheduleNewIp();
    void refreshTrayInfo();
    setInterval(() => { void refreshTrayInfo(); }, 5 * 60 * 1000);

    /* Авто-обновление: первая проверка через 20 с, далее раз в 4 часа */
    if (!process.env.INVIS_NO_UPDATE) {
        /* Проверка обновлений при запуске — если включено автообновление */
        if (settings.autoUpdate) setTimeout(() => { void checkForUpdates(true); }, 20000);
        setInterval(() => { void checkForUpdates(); }, 4 * 60 * 60 * 1000);
    }
    /* мусор от прошлых обновлений portable-версии: настоящий лаунчер лежит в
     * PORTABLE_EXECUTABLE_DIR, а не рядом с process.execPath (это temp-копия) */
    if (app.isPackaged && process.env.PORTABLE_EXECUTABLE_DIR) {
        try {
            fs.unlinkSync(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'Invis.exe.old'));
        } catch (e) { /* нет файла */ }
    }

    startupWarnings.forEach((w, i) => {
        setTimeout(() => sendToRenderer('modules:event', { text: w }), 1500 + i * 1200);
    });

    /* Автозапуск модулей согласно настройкам — ТОЛЬКО по галкам автозапуска.
     * Прокси-намерение (systemProxy) принудительно Tor НЕ запускает: при чистом
     * выходе прокси в реестре снят, а когда пользователь сам запустит Tor —
     * эффект прокси вернётся автоматически (onState tor 'on'). */
    const sup = supervisor;
    if (!process.env.INVIS_NO_AUTOSTART && sup) {
        const started = sup.startEnabled(settings.autostart);
        if (started.length) console.log(`[Invis] Автозапуск модулей: ${started.join(', ')}`);
    }

    /* Включённые блок-листы устаревают — раз в сутки перекачать в фоне (SIM-2) */
    const enabledPresets = Object.entries(settings.dnscrypt?.presets || {})
        .filter(([, v]) => v).map(([k]) => k);
    if (enabledPresets.length) {
        setTimeout(async () => {
            let refreshedAny = false;
            for (const name of enabledPresets) {
                try {
                    const { refreshed } = await blocklists.ensure(configDirGlobal as string, name);
                    if (refreshed) {
                        refreshedAny = true;
                        sendToRenderer('modules:event', {
                            text: `Блок-лист «${blocklists.PRESETS[name].label}» обновлён`,
                        });
                    }
                } catch (e) { /* фон: старый список остался */ }
            }
            if (refreshedAny) rebuildConfigsAndRestartDnscrypt();
        }, 5000);
    }

    /* Защита от утечки (дурак №2): перехват DNS нацелен на адаптеры, существовавшие
     * на момент включения. Подключился новый Wi-Fi / USB-модем — направляем и его
     * на 127.0.0.1, а исходные адреса добавляем в бэкап для восстановления. */
    setInterval(() => {
        if (!dnsApplied || !netmode.isElevated()) return;
        try {
            const fresh = netmode.getUpPhysicalAdapters().filter((a) => !dnsAppliedAdapters.includes(a));
            if (!fresh.length) return;
            const backup = netmode.readBackup(dnsBackupFile()) || [];
            for (const alias of fresh) {
                backup.push({ alias, addresses: netmode.getDnsServers(alias).filter(netmode.isValidIp) });
                netmode.setDnsLoopback(alias);
                dnsAppliedAdapters.push(alias);
                netmodeLog(`Новый адаптер «${alias}» — DNS направлен на 127.0.0.1`);
                sendToRenderer('modules:event', { text: `Новый адаптер «${alias}» — DNS также направлен на Invis` });
            }
            netmode.writeBackup(dnsBackupFile(), backup);
        } catch (e) { /* фон: попробуем в следующий раз */ }
    }, 60000);
}

/* Каталог бинарников: в сборке — resources/bin, в dev — <проект>/bin */
function binDir(): string {
    return app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(APP_ROOT, 'bin');
}

/* ---------- системный DNS (перехват на 127.0.0.1, порт 53 у dnscrypt) ---------- */
function netmodeLog(msg: string): void {
    try {
        fs.mkdirSync(path.join(store.baseDir(), 'logs'), { recursive: true });
        fs.appendFileSync(path.join(store.baseDir(), 'logs', 'netmode.log'),
            `${new Date().toISOString()} ${msg}\n`);
    } catch (e) { /* лог не критичен */ }
}

function applySystemDns(): { ok: boolean; error?: string } {
    if (dnsApplied) return { ok: true };
    const owner = netmode.port53Owner();
    if (owner) {
        return {
            ok: false,
            error: `Порт 53 уже занят процессом «${owner}» (вероятно, другой DNS-сервис). `
                 + 'Остановите его или настройте на использование Invis, затем повторите.',
        };
    }
    const up = netmode.getUpPhysicalAdapters();
    if (!up.length) return { ok: false, error: 'Не найдено активных сетевых адаптеров.' };
    /* Выбранные пользователем адаптеры (пустой выбор = все физические) */
    const selected = (settings.systemDnsAdapters || []).filter((a) => up.includes(a));
    const adapters = selected.length ? selected : up;
    const backup = adapters.map((a) => ({
        alias: a,
        addresses: netmode.getDnsServers(a).filter(netmode.isValidIp),
    }));
    netmode.writeBackup(dnsBackupFile(), backup);
    netmodeLog(`Перехват DNS включён. Адаптеры: [${adapters.join(', ')}]. Сохранено: `
        + JSON.stringify(backup));
    for (const a of adapters) netmode.setDnsLoopback(a);
    dnsApplied = true;
    dnsAppliedAdapters = adapters;
    return { ok: true };
}

function restoreSystemDns(): void {
    const backup = sanitizeDnsBackup(netmode.readBackup(dnsBackupFile()));
    if (!backup) {
        /* Файла нет или он не прошёл валидацию: бэкап битого вида нельзя
         * «восстанавливать» — удаляем, чтобы не зациклить crash-recovery */
        if (fs.existsSync(dnsBackupFile())) {
            netmode.removeBackup(dnsBackupFile());
            netmodeLog('dns-backup.json не прошёл валидацию — удалён без восстановления');
        }
        dnsApplied = false;
        dnsAppliedAdapters = [];
        return;
    }
    for (const { alias, addresses } of backup) {
        try {
            /* Если в бэкапе только loopback — прежний локальный резольвер уже не
             * работает, восстановление вернёт нерабочий DNS. Ставим публичные. */
            const allLoopback = addresses.length
                && addresses.every((a) => /^(127\.|::1$)/.test(a));
            if (!addresses.length || allLoopback) netmode.resetDns(alias);
            else netmode.setDnsList(alias, addresses);
        } catch (e) {
            netmodeLog(`ОШИБКА восстановления DNS на «${alias}»: ${(e as Error).message}`);
        }
    }
    netmode.removeBackup(dnsBackupFile());
    netmodeLog('Системный DNS восстановлен');
    dnsApplied = false;
    dnsAppliedAdapters = [];
}

/* После сбоя: вернуть прежние настройки DNS */
function recoverSystemDnsIfNeeded(): void {
    if (!netmode.readBackup(dnsBackupFile())) return;
    netmodeLog('Обнаружен невосстановленный dns-backup при старте');
    if (netmode.isElevated()) {
        restoreSystemDns();
        return;
    }
    /* ВАЖНО: showMessageBoxSync возвращает индекс кнопки (число), а не объект —
     * прежний код `const { response } = ...` давал undefined и обе кнопки
     * (DNS-восстановление, UAC-перезапуск) не срабатывали никогда */
    const response = dialog.showMessageBoxSync({
        type: 'warning',
        title: 'Invis',
        message: 'Invis не завершил работу корректно: системный DNS остался направлен на 127.0.0.1.',
        detail: 'Восстановить прежние настройки DNS сейчас? Потребуются права администратора.',
        buttons: ['Восстановить DNS', 'Позже'],
        defaultId: 0,
        cancelId: 1,
    });
    if (response === 0) restoreElevatedOneShot();
}

/* Разовое восстановление DNS через отдельный elevated-процесс */
function restoreElevatedOneShot(): void {
    const backup = sanitizeDnsBackup(netmode.readBackup(dnsBackupFile()));
    if (!backup) {
        netmode.removeBackup(dnsBackupFile());
        return;
    }
    const lines = backup.map(({ alias, addresses }) => {
        const qAlias = alias.replace(/'/g, "''");
        return addresses.length
            ? `Set-DnsClientServerAddress -InterfaceAlias '${qAlias}' -ServerAddresses ${addresses.map((a) => `'${a}'`).join(',')}`
            : `Set-DnsClientServerAddress -InterfaceAlias '${qAlias}' -ResetServerAddresses`;
    });
    /* Случайный каталог вместо предсказуемого имени в %TEMP% (TOCTOU-подмена) */
    const tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'invis-dns-'));
    const ps1 = path.join(tmpDir, 'restore.ps1');
    fs.writeFileSync(ps1, lines.join('\r\n'), 'utf8');
    try {
        execFileSync('powershell',
            ['-NoProfile', '-Command',
             `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1.replace(/'/g, "''")}'`],
            { windowsHide: true, timeout: 120000, stdio: 'ignore' });
        netmode.removeBackup(dnsBackupFile());
        netmodeLog('DNS восстановлен разовым elevated-скриптом');
    } catch (e) {
        netmodeLog('Разовое восстановление отменено (UAC/таймаут)');
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* не критично */ }
    }
}

/* Перезапуск приложения с правами администратора (UAC) */
function relaunchElevated(): void {
    const exe = process.execPath.replace(/'/g, "''");
    const args = app.isPackaged ? [] : [APP_ROOT.replace(/'/g, "''")];
    const ps = `Start-Process -FilePath '${exe}' ${args.length ? `-ArgumentList ${args.map((a) => `'${a}'`).join(',')}` : ''} -Verb RunAs`;
    spawn('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true, stdio: 'ignore', detached: true }).unref();
    quitting = true;
    setTimeout(() => app.quit(), 300);
}

/* Перегенерация конфигов (порт dnscrypt зависит от режима DNS) */
function rebuildConfigs(): void {
    const listen = dnsApplied ? 53 : PORTS.dnscrypt;
    const base = store.baseDir();
    buildConfigs({
        configDir: configDirGlobal as string,
        torDataDir: path.join(base, 'data', 'tor'),
        i2pDataDir: path.join(base, 'data', 'i2pd'),
        geoipDir: path.join(binDir(), 'tor', 'data'),
        torPluginDir: path.join(binDir(), 'tor', 'tor', 'pluggable_transports'),
        i2pdContribDir: path.join(binDir(), 'i2pd', 'contrib'),
        dnscryptListen: listen,
        dnscryptCfg: settings.dnscrypt,
        torCfg: settings.tor,
    });
    supervisor?.setDnscryptPort(listen);
}

function rebuildConfigsAndRestartDnscrypt(): void {
    rebuildConfigs();
    const sup = supervisor;
    if (sup?.isRunning('dnscrypt')) {
        sup.stop('dnscrypt').then(() => sup.start('dnscrypt')).catch(() => {});
    }
}

/* Родная иконка i2pd в трее создаётся безусловно (USE_WIN32_APP вшит на
 * уровне сборки, опции отключения нет). В трее должен быть только Invis —
 * находим скрытое окно i2pd и удаляем его иконку через Shell_NotifyIcon.
 * Вернётся она только после перезапуска explorer (TaskbarCreated). */
function hideI2pdTrayIcon(): void {
    if (process.platform !== 'win32') return;
    const ps = [
        "$sig = @'",
        '    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);',
        '    [DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern bool Shell_NotifyIcon(uint msg, ref NID nid);',
        '    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
        '    public struct NID {',
        '        public uint cbSize; public IntPtr hWnd; public uint uID; public uint uFlags; public IntPtr hIcon;',
        '        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string szTip;',
        '        public uint dwState; public uint dwStateMask;',
        '        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string szInfo;',
        '        public uint uVersion;',
        '        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string szInfoTitle;',
        '        public uint dwInfoFlags; public Guid guidItem; public IntPtr hBalloonIcon;',
        '    }',
        "'@",
        'Add-Type -MemberDefinition $sig -Name Win -Namespace Invis',
        /* class+title: поиск только по классу на части систем возвращает 0 */
        "$h = [Invis.Win]::FindWindowExW([IntPtr]::Zero, [IntPtr]::Zero, 'i2pd main window', 'i2pd')",
        'if ($h -ne [IntPtr]::Zero) {',
        '    $n = New-Object Invis.Win+NID',
        '    $n.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][Invis.Win+NID])',
        '    $n.hWnd = $h; $n.uID = 2050',
        '    [void][Invis.Win]::Shell_NotifyIcon(2, [ref]$n)',
        '}',
    ].join('\n');
    try {
        spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
            { windowsHide: true, stdio: 'ignore' });
    } catch (e) { netmodeLog(`Не удалось скрыть иконку i2pd: ${(e as Error).message}`); }
}

/* Firewall-правила для доступа к DNS из LAN (best-effort, нужен админ).
 * Правила узкие (SEC-6): только приватный профиль, только частные подсети,
 * только процесс dnscrypt и реально настроенный порт. Раньше — все профили,
 * любой источник, всегда порт 53 (даже когда dnscrypt слушает 9053). */
function syncLanFirewall(enabled: boolean): void {
    const port = dnsApplied ? 53 : PORTS.dnscrypt;
    const prog = path.join(binDir(), 'dnscrypt', 'win64', 'dnscrypt-proxy.exe');
    /* Легаси-имена из старых версий тоже подчищаем */
    const names = ['Invis DNS (UDP 53)', 'Invis DNS (TCP 53)',
        'Invis DNS (UDP 9053)', 'Invis DNS (TCP 9053)'];
    try {
        for (const name of names) {
            execFileSync('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`],
                { windowsHide: true, stdio: 'ignore' });
        }
        if (enabled && !netmode.isElevated()) {
            /* Дурак включил LAN без админа: без предупреждения он бы не понял,
             * почему LAN-клиенты не могут использовать DNS */
            netmodeLog('Firewall LAN DNS: нет прав администратора — правила не добавлены');
            sendToRenderer('modules:event', {
                text: 'Доступ из LAN: нет прав администратора — правила брандмауэра не добавлены, LAN-клиенты не смогут использовать DNS',
            });
        }
        if (enabled && netmode.isElevated()) {
            for (const proto of ['UDP', 'TCP']) {
                execFileSync('netsh', ['advfirewall', 'firewall', 'add', 'rule',
                    `name=Invis DNS (${proto} ${port})`, 'dir=in', 'action=allow',
                    `protocol=${proto}`, `localport=${String(port)}`,
                    'profile=private,domain',
                    'remoteip=192.168.0.0/16,10.0.0.0/8,172.16.0.0/12',
                    `program=${prog}`], { windowsHide: true, stdio: 'ignore' });
            }
        }
        netmodeLog(`Firewall LAN DNS (${port}): ${enabled
            ? 'правила добавлены (private, частные подсети, dnscrypt.exe)'
            : 'правила удалены'}`);
    } catch (e) {
        netmodeLog(`Firewall LAN DNS: не удалось (${(e as Error).message})`);
    }
}

/* Снять перехват DNS, сохранив галку как намерение: эффект вернётся при
 * следующем старте dnscrypt (см. prepareDnsInterceptBeforeStart) */
async function disableSystemDns(stopDnscryptAfter: boolean): Promise<void> {
    if (dnsApplied) restoreSystemDns();
    rebuildConfigs();
    if (stopDnscryptAfter && supervisor?.isRunning('dnscrypt')) {
        await supervisor.stop('dnscrypt');
    }
}

/* Перед стартом dnscrypt: галка перехвата включена, но эффект не применён —
 * применить (адаптеры → 127.0.0.1) и пересобрать конфиг на порт 53 */
function prepareDnsInterceptBeforeStart(): void {
    if (!settings.systemDns || dnsApplied) return;
    if (!netmode.isElevated()) {
        sendToRenderer('modules:event', {
            text: 'Перехват DNS включён в настройках, но нужны права администратора — dnscrypt запущен без перехвата',
        });
        return;
    }
    const r = applySystemDns();
    if (r.ok) rebuildConfigs();
    else sendToRenderer('modules:event', { text: `Перехват DNS не применён: ${r.error}` });
}

/* «Запустить всё» (UI и трей): перехват DNS по галке + Tor для системного прокси */
function startAllModules(): void {
    prepareDnsInterceptBeforeStart();
    supervisor?.startEnabled(settings.autostart);
    if (settings.systemProxy && supervisor) {
        /* Прокси живёт вместе с Tor. Раньше полагались только на событие
         * tor 'on' — при гонке «остановил всё → сразу запустил всё» оно
         * терялось и прокси не возвращался, хотя галка включена. */
        if (!supervisor.isRunning('tor')) supervisor.start('tor');
        if (supervisor.isRunning('tor')) {
            const r = applySystemProxy();
            if (r.ok) sendToRenderer('modules:event', { text: 'Системный прокси направлен на Tor' });
        }
    }
}

const proxyBackupFile = () => path.join(store.baseDir(), 'proxy-backup.json');

function applySystemProxy(): { ok: boolean; error?: string } {
    if (proxyApplied) return { ok: true };
    if (!supervisor?.isRunning('tor')) return { ok: false, error: 'Сначала запустите Tor — прокси указывает на него.' };
    /* Не бэкапим собственный отпечаток: если прошлый сеанс завершился без
     * восстановления и в реестре уже наш socks-прокси, «бэкап» такого
     * состояния при восстановлении возвращал прокси Invis вместо
     * пользовательских настроек. Бэкапим «прокси был выключен». */
    const ours = proxy.isOursActive();
    let backupValid = false;
    try {
        const saved = JSON.parse(fs.readFileSync(proxyBackupFile(), 'utf8'));
        backupValid = Boolean(saved) && saved.proxyServer !== 'socks=127.0.0.1:9050';
    } catch (e) { /* бэкапа нет или битый */ }
    const backup = ours && backupValid
        ? JSON.parse(fs.readFileSync(proxyBackupFile(), 'utf8'))
        : (ours
            ? { proxyEnable: '0x0', proxyServer: null, proxyOverride: null, autoConfigUrl: null }
            : proxy.readState());
    fs.writeFileSync(proxyBackupFile(), JSON.stringify(backup, null, 2), 'utf8');
    proxy.apply('127.0.0.1:9050', app.getPath('temp'));
    proxyApplied = true;
    netmodeLog('Системный прокси направлен на socks=127.0.0.1:9050. Прежние настройки: ' + JSON.stringify(backup));
    return { ok: true };
}

function restoreSystemProxy(): void {
    if (fs.existsSync(proxyBackupFile())) {
        try {
            const saved = JSON.parse(fs.readFileSync(proxyBackupFile(), 'utf8'));
            /* Отравленный бэкап (наш собственный socks) восстанавливать нельзя —
             * это вернуло бы прокси Invis; считаем, что до нас прокси был выключен */
            const poisoned = Boolean(saved) && saved.proxyServer === 'socks=127.0.0.1:9050';
            proxy.restore(poisoned ? null : saved, app.getPath('temp'));
            netmodeLog('Системный прокси восстановлен: ' + JSON.stringify(poisoned ? null : saved));
        } catch (e) {
            netmodeLog(`ОШИБКА восстановления прокси: ${(e as Error).message}`);
        }
        try { fs.unlinkSync(proxyBackupFile()); } catch (e) { /* нет файла */ }
    } else if (proxy.isOursActive()) {
        /* Бэкапа нет, а наш прокси в реестре висит — снимаем (bool-флаг в памяти
         * мог разойтись с реальностью после сбоя/перезапуска) */
        proxy.restore(null, app.getPath('temp'));
        netmodeLog('Системный прокси снят (бэкапа не было, эффект был активен)');
    }
    proxyApplied = false;
}

/* Реален ли наш прокси прямо сейчас: флаг в памяти недостаточен — после
 * сбоя/перезапуска/гонки сохранения он расходится с реестром */
const proxyEffectActive = () => proxyApplied || proxy.isOursActive();

function stopAllModules(): Promise<void> {
    if (!supervisor) return Promise.resolve();
    return (async () => {
        if (dnsApplied) await disableSystemDns(false); // вернуть адаптеры, затем гасить всё
        if (proxyEffectActive()) restoreSystemProxy();        // вернуть системный прокси
        await Promise.all(supervisor.list.map((n) => supervisor!.stop(n)));
    })();
}

/* ---------- окно ---------- */
/* ---------- окно ---------- */
/* Геометрия: первый запуск — минимальный размер (320×568, iPhone SE);
 * дальше положение/размер/развёрнутость запоминаются в настройках. */
let boundsSaveTimer: NodeJS.Timeout | null = null;

function saveWindowBounds(): void {
    if (!win || win.isDestroyed()) return;
    const b = win.getNormalBounds();
    settings.windowBounds = {
        x: b.x, y: b.y, width: b.width, height: b.height,
        maximized: win.isMaximized(),
    };
    try { store.save(settings); } catch (e) { /* геометрия не критична */ }
}

function scheduleSaveBounds(): void {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(saveWindowBounds, 500);
}

function restoreBounds(): { x?: number; y?: number; width: number; height: number } {
    const saved = settings.windowBounds;
    if (!saved || !saved.width || !saved.height) {
        return { width: 320, height: 568 }; // первый запуск — минимальный размер
    }
    const b = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
    /* Сменился монитор/разрешение — не теряем окно за экраном */
    const wa = screen.getDisplayMatching(b).workArea;
    const intersects = b.x < wa.x + wa.width && b.x + b.width > wa.x
        && b.y < wa.y + wa.height && b.y + b.height > wa.y;
    if (!intersects) return { width: Math.min(saved.width, wa.width), height: Math.min(saved.height, wa.height) };
    return b;
}

function createWindow(): void {
    const bounds = restoreBounds();
    win = new BrowserWindow({
        ...bounds,
        minWidth: 320,      // экран iPhone SE (320×568) — нижняя граница адаптива
        minHeight: 568,
        frame: false,
        backgroundColor: '#1e1e2f',
        title: TITLE,
        icon: path.join(APP_ROOT, 'assets', 'img', 'icon.ico'),
        webPreferences: {
            /* SEC-1: у рендерера нет Node; весь IPC — через preload-мост
             * с allowlist каналов (preload.js). Любая HTML-инъекция в UI
             * больше не даёт доступ к файловой системе и процессам. */
            preload: path.join(APP_ROOT, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });
    win.setMenuBarVisibility(false);
    void win.loadFile(path.join(APP_ROOT, 'index.html'));

    /* SEC-1: никаких открытий окон и навигаций из рендерера — только своя страница */
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const ownUrl = pathToFileURL(path.join(APP_ROOT, 'index.html')).href;
    win.webContents.on('will-navigate', (e, url) => {
        if (url === ownUrl || url.startsWith(ownUrl + '#')) return;
        e.preventDefault();
    });

    win.on('close', (e) => {
        saveWindowBounds();
        if (!quitting && settings.closeToTray) {
            e.preventDefault();
            hideToTray();
        }
    });
    win.on('closed', () => { win = null; });
    /* Память геометрии: положение/размер/развёрнутость — в настройки (с дебаунсом) */
    win.on('resize', scheduleSaveBounds);
    win.on('move', scheduleSaveBounds);
    if (settings.windowBounds.maximized) win.maximize();

    /* Смоук-тест: APP_SMOKE=<мс> — вывести консоль рендерера и закрыться */
    if (process.env.APP_SMOKE) {
        win.webContents.on('console-message', (_e, a, b) => {
            const msg = typeof a === 'object' && a ? (a as { message?: string }).message : (b ?? a);
            console.log('[renderer]', msg);
        });
        win.webContents.on('render-process-gone', (_e, details) => {
            console.error('[smoke] renderer gone:', details.reason);
        });
        setTimeout(() => app.quit(), Number(process.env.APP_SMOKE) || 8000);
    }
}

function showWindow(): void {
    if (!win) { createWindow(); return; }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
}

function hideToTray(): void {
    if (!win) return;
    win.hide();
    if (!balloonShown) {
        balloonShown = true;
        try {
            tray?.displayBalloon({
                title: TITLE,
                content: 'Приложение продолжает работать в трее.',
                icon: nativeImage.createFromPath(path.join(APP_ROOT, 'assets', 'img', 'icon.ico')),
            });
        } catch (e) { /* balloon не критичен */ }
    }
}

/* ---------- трей ---------- */
const TRAY_LABELS: Record<string, string> = { on: 'работает', off: 'выключен', busy: 'проблема / переходный процесс' };

function initTrayIcons(): void {
    for (const s of ['on', 'off', 'busy']) {
        trayIcons[s] = nativeImage.createFromPath(path.join(APP_ROOT, 'assets', 'img', `tray-${s}.png`));
    }
}

/* Агрегированный статус: жёлтый — ошибка или переход, зелёный — хоть один модуль
 * работает, красный — всё выключено (по ТЗ пользователя: green/red/yellow) */
function aggregateTrayState(): 'on' | 'off' | 'busy' {
    const states = Object.values(supervisor ? supervisor.status() : {}).map((v) => v.state);
    if (states.some((s) => s === 'error' || s === 'busy')) return 'busy';
    if (states.some((s) => s === 'on')) return 'on';
    return 'off';
}

function setTrayState(state: 'on' | 'off' | 'busy'): void {
    if (!tray || !trayIcons[state] || state === trayState) return;
    trayState = state;
    tray.setImage(trayIcons[state]);
    tray.setToolTip(`Invis — ${TRAY_LABELS[state]}`);
}

/* Лёгкий замер для трея: скорость раз в 5 минут, IP выхода — при живом Tor.
 * Это ЕДИНСТВЕННЫЙ таймер замера в приложении: результат пушится рендереру
 * в шапку (раньше рендерер качал свой 1 МБ параллельно — двойной трафик). */
async function refreshTrayInfo(manual = false): Promise<void> {
    const viaTor = supervisor?.isRunning('tor') ?? false;
    try {
        const mbps = await netspeed.measure({ viaTor });
        trayInfo.speed = { mbps, viaTor };
    } catch (e) { /* оставим прошлое значение */ }
    if (viaTor) {
        try { trayInfo.exit = await torspeed.exitInfo(); } catch (e) { /* старое */ }
    }
    if (trayInfo.speed) {
        sendToRenderer('net:speed:result', trayInfo.speed);
    }
    if (manual) sendToRenderer('modules:event', { text: 'Данные трея обновлены' });
    tray?.setContextMenu(trayMenu());
}

function createTray(): void {
    tray = new Tray(trayIcons.off);
    trayState = 'off';
    tray.setToolTip(`Invis — ${TRAY_LABELS.off}`);
    tray.setContextMenu(trayMenu());

    /* Клик по иконке — показать/спрятать окно */
    tray.on('click', () => {
        if (win && win.isVisible() && !win.isMinimized()) hideToTray();
        else showWindow();
    });
}

function trayMenu(): Electron.Menu {
    const st: Record<DaemonName, { state: DaemonState; status: string }> = supervisor
        ? supervisor.status()
        : {} as Record<DaemonName, { state: DaemonState; status: string }>;
    const mark = (n: DaemonName) => (st[n] ? (st[n].state === 'on' ? '✓' : (st[n].state === 'busy' ? '…' : '×')) : '×');
    const e = trayInfo.exit;
    const exitLine = supervisor?.isRunning('tor')
        ? (e ? ('Выход: ' + (e.cc || '??') + ' ' + [e.city, e.country].filter(Boolean).join(', ')
              + ' · ' + e.ip + (e.pingMs != null
                 ? ' · ' + (e.pingMs >= 1000 ? (e.pingMs / 1000).toFixed(1) + ' с' : e.pingMs + ' мс') : ''))
          : 'Выход: проверяю…')
        : 'Выход: — (Tor выключен)';
    const sp = trayInfo.speed;
    const speedLine = sp ? ('Скорость: ↓ ' + sp.mbps + ' Мбит/с (' + (sp.viaTor ? 'через Tor' : 'напрямую') + ')') : 'Скорость: —';
    return Menu.buildFromTemplate([
        { label: 'Tor ' + mark('tor') + '    DNSCrypt ' + mark('dnscrypt') + '    I2P ' + mark('i2p'), enabled: false },
        { label: exitLine, enabled: false },
        { label: speedLine, enabled: false },
        { label: 'Обновить данные', click: () => { trayInfo.speed = null; void refreshTrayInfo(true); } },
        { type: 'separator' },
        { label: 'Открыть Invis', click: () => showWindow() },
        { type: 'separator' },
        /* Точка расширения: управление модулями через супервизор */
        { label: 'Запустить всё', click: () => startAllModules() },
        { label: 'Остановить всё', click: () => { void stopAllModules(); } },
        { type: 'separator' },
        {
            label: 'Запускать с Windows',
            type: 'checkbox',
            checked: settings.launchWithWindows,
            click: (item) => setSetting({ launchWithWindows: item.checked }),
        },
        { type: 'separator' },
        {
            label: 'Выход',
            click: () => { quitting = true; app.quit(); },
        },
    ]);
}

/* ---------- автозапуск с Windows (per-user, реестр Run) ----------
 * В dev-режиме регистрируется electron.exe — норма для шаблона;
 * в собранном приложении регистрируется сам exe. */
function applyLaunchWithWindows(): void {
    app.setLoginItemSettings({ openAtLogin: Boolean(settings.launchWithWindows) });
}

/* ---------- изменения настроек (общая точка: IPC и меню трея) ---------- */
function setSetting(patch: SettingsPatch): Settings {
    const lanChanged = patch.dnscrypt && patch.dnscrypt.lanAccess !== undefined
        && patch.dnscrypt.lanAccess !== Boolean(settings.dnscrypt?.lanAccess);
    const adaptersChanged = patch.systemDnsAdapters !== undefined
        && JSON.stringify(patch.systemDnsAdapters) !== JSON.stringify(settings.systemDnsAdapters);

    /* Особый случай: системный прокси на Tor */
    if (patch.systemProxy !== undefined && patch.systemProxy !== Boolean(settings.systemProxy)) {
        const want = patch.systemProxy;
        if (want) {
            let startedTor = false;
            let r = applySystemProxy();
            if (!r.ok && supervisor) {
                /* Tor не запущен — не запрещаем, а стартуем его сами: прокси без него бессмыслен */
                try { supervisor.start('tor'); startedTor = true; } catch (e) { /* ошибка будет в r */ }
                r = applySystemProxy();
            }
            if (!r.ok) {
                dialog.showMessageBox(win!, {
                    type: 'error', title: 'Invis',
                    message: 'Не удалось включить системный прокси', detail: r.error,
                });
                /* Галку не сбрасываем — это намерение: прокси применится сам,
                 * когда Tor поднимется (onState tor 'on'). Раньше здесь
                 * сохранялся systemProxy:false и галка «снималась сама». */
            } else if (startedTor) {
                sendToRenderer('modules:event', {
                    text: 'Прокси включён, Tor запускается — трафик пойдёт через него, как только Tor подключится',
                });
            }
        } else {
            restoreSystemProxy();
        }
    }

    /* Особый случай: перехват системного DNS */
    if (patch.systemDns !== undefined && patch.systemDns !== Boolean(settings.systemDns)) {
        const want = patch.systemDns;
        if (want && !netmode.isElevated()) {
            const response = dialog.showMessageBoxSync(win!, {
                type: 'question',
                title: 'Invis',
                message: 'Перехват системного DNS требует прав администратора.',
                detail: 'Invis перезапустится от имени администратора и направит DNS системы '
                      + 'на локальный защищённый резолвер. При выходе настройки DNS будут восстановлены.',
                buttons: ['Перезапустить от администратора', 'Отмена'],
                defaultId: 0,
                cancelId: 1,
            });
            if (response === 0) {
                settings = store.deepMerge(store.load(), { systemDns: true });
                store.save(settings);
                relaunchElevated();
            }
            sendToRenderer('settings:changed', settings);
            return settings;
        }
        if (want) {
            const r = applySystemDns();
            if (!r.ok) {
                dialog.showMessageBox(win!, {
                    type: 'error',
                    title: 'Invis',
                    message: 'Не удалось включить системный DNS',
                    detail: r.error,
                });
                patch = { ...patch, systemDns: false };
            } else {
                rebuildConfigsAndRestartDnscrypt();
            }
        } else if (dnsApplied) {
            restoreSystemDns();
            rebuildConfigsAndRestartDnscrypt();
        }
    }

    /* Глубокий merge в дефолты — неизвестные ключи отбрасываются, вложенные
     * объекты (autostart, dnscrypt) не теряют соседние флаги при частичном патче */
    settings = store.deepMerge(store.load(), patch);
    try {
        store.save(settings);
    } catch (e) {
        /* Раньше ошибка записи тонула и выглядела как «настройки сбросились» */
        sendToRenderer('modules:event', { text: `Не удалось сохранить настройки: ${(e as Error).message}` });
        throw e; // рендерер покажет ошибку в статус-баре
    }
    if (patch.launchWithWindows !== undefined) applyLaunchWithWindows();
    if (patch.autoUpdate) void checkForUpdates(true);

    /* Изменились параметры dnscrypt — перегенерировать toml и мягко перезапустить */
    if (patch.dnscrypt !== undefined) {
        rebuildConfigsAndRestartDnscrypt();
        if (lanChanged) syncLanFirewall(Boolean(settings.dnscrypt?.lanAccess));
    }

    /* Галку «Лог DNS» сняли — файл с историей запросов не должен переживать
     * выключение (dnscrypt отпускает файл после рестарта — даём 5 с) */
    if (patch.dnscrypt?.queryLog === false) {
        setTimeout(() => {
            try {
                fs.unlinkSync(path.join(configDirGlobal || '', 'query.log'));
                queryLogOffset = 0;
                netmodeLog('query.log удалён (логирование выключено)');
            } catch (e) { /* занят или не было */ }
        }, 5000);
    }

    /* Изменились параметры Tor — bridges требуют пересборки torrc и рестарта */
    if (patch.tor !== undefined) {
        scheduleNewIp();
        rebuildConfigs(); /* новый torrc до рестарта Tor */
        if ((patch.tor.useBridges !== undefined || patch.tor.bridgesText !== undefined
                || patch.tor.exitCountries !== undefined)
                && supervisor?.isRunning('tor')) {
            const sup = supervisor;
            sup.stop('tor').then(() => sup.start('tor')).catch(() => {});
        }
    }

    /* Включённые пресеты блок-листов — докачать файлы и пересобрать */
    const enabledPresets = patch.dnscrypt?.presets
        ? Object.entries(patch.dnscrypt.presets).filter(([, v]) => v).map(([k]) => k)
        : [];
    for (const name of enabledPresets) {
        (async () => {
            try {
                sendToRenderer('modules:event', { text: `Загрузка блок-листа «${blocklists.PRESETS[name].label}»…` });
                const { refreshed } = await blocklists.ensure(configDirGlobal as string, name);
                sendToRenderer('modules:event', {
                    text: refreshed
                        ? `Блок-лист «${blocklists.PRESETS[name].label}» загружен`
                        : `Блок-лист «${blocklists.PRESETS[name].label}» уже актуален (обновляется раз в сутки)`,
                });
                rebuildConfigsAndRestartDnscrypt();
            } catch (e) {
                sendToRenderer('modules:event', { text: `Блок-лист «${name}»: ${(e as Error).message}` });
            }
        })();
    }

    /* Изменился выбор адаптеров перехвата — пере-применить DNS */
    if (adaptersChanged && dnsApplied) {
        restoreSystemDns();
        const r = applySystemDns();
        if (!r.ok) netmodeLog(`Повторное применение после смены адаптеров: ${r.error}`);
    }

    tray?.setContextMenu(trayMenu());
    sendToRenderer('settings:changed', settings);
    return settings;
}

/* ---------- Tor: NEWNYM (смена IP) ---------- */
function scheduleNewIp(): void {
    if (newIpTimer) { clearInterval(newIpTimer); newIpTimer = null; }
    const minutes = Number(settings.tor?.newIpMinutes) || 0;
    if (minutes <= 0) return;
    newIpTimer = setInterval(async () => {
        if (!supervisor?.isRunning('tor')) return;
        const r = await torctl.newIp(path.join(store.baseDir(), 'data', 'tor'));
        sendToRenderer('modules:event', { text: r.ok ? 'Tor: запрошена новая цепочка — новый IP получат НОВЫЕ соединения; открытые вкладки могут показывать старый IP до обновления страницы (F5)' : `Tor NEWNYM: ${r.detail}` });
    }, minutes * 60000);
}

function sendToRenderer(channel: string, payload: unknown): void {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ---------- IPC: тайтлбар ---------- */
ipcMain.on('window-minimize', () => win?.minimize());
ipcMain.on('window-maximize', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
ipcMain.on('window-close', () => win?.close());

/* ---------- IPC: настройки ---------- */
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => setSetting(patch || {}));
ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    daemons: DAEMON_VERSIONS,
    systemDnsActive: dnsApplied,
}));

/* ---------- IPC: модули (реальный супервизор демонов) ---------- */
ipcMain.handle('modules:status', () => supervisor?.status() || {});
ipcMain.on('modules:start-all', () => startAllModules());
ipcMain.on('modules:stop-all', () => { void stopAllModules(); });
ipcMain.on('modules:toggle', (_e, name: DaemonName) => {
    if (!supervisor || !supervisor.specs[name]) return;
    if (supervisor.isRunning(name)) {
        /* Остановка dnscrypt при перехвате: сначала вернуть системный DNS */
        if (name === 'dnscrypt' && dnsApplied) { void disableSystemDns(true); return; }
        supervisor.stop(name);
    } else {
        if (name === 'dnscrypt') prepareDnsInterceptBeforeStart();
        supervisor.start(name);
    }
});
ipcMain.on('modules:start', (_e, name: DaemonName) => {
    if (!supervisor || !supervisor.specs[name]) return;   // SEC-13: как в toggle
    if (name === 'dnscrypt') prepareDnsInterceptBeforeStart();
    supervisor.start(name);
});
ipcMain.on('modules:stop', (_e, name: DaemonName) => {
    if (!supervisor || !supervisor.specs[name]) return;   // SEC-13: крошивший main
    if (name === 'dnscrypt' && dnsApplied) { void disableSystemDns(true); return; }
    supervisor.stop(name);
});

/* ---------- IPC: резольверы, лог запросов, адаптеры ---------- */
ipcMain.handle('resolvers:list', () => {
    if (!configDirGlobal) return { ok: false, error: 'Приложение ещё инициализируется' };
    return readResolvers(configDirGlobal);
});

/* «Очистка» лога: query.log держит открытым dnscrypt, перезапись файла на
 * Windows падает с EBUSY/EPERM — вместо этого помечаем смещение и не
 * показываем байты до него. Файл не трогаем вовсе. */
let queryLogOffset = 0;

ipcMain.handle('querylog:get', (_e, { filter }: { filter?: string } = {}) => {
    const file = path.join(configDirGlobal || '', 'query.log');
    let content = '';
    let start = 0;
    try {
        const fd = fs.openSync(file, 'r');
        try {
            const size = fs.fstatSync(fd).size;
            if (size < queryLogOffset) queryLogOffset = 0; // файл пересоздан/усох
            start = Math.max(queryLogOffset, size - 128 * 1024);
            const buf = Buffer.alloc(size - start);
            fs.readSync(fd, buf, 0, buf.length, start);
            content = buf.toString('utf8');
        } finally {
            fs.closeSync(fd);
        }
    } catch (e) {
        return { lines: [], total: 0 };
    }
    let lines = content.split(/\r?\n/).filter(Boolean);
    if (start) lines = lines.slice(1); // обрезать возможную половинную строку
    if (filter) lines = lines.filter((l) => l.toLowerCase().includes(String(filter).toLowerCase()));
    const total = lines.length;
    return { lines: lines.slice(-200), total };
});

ipcMain.on('querylog:clear', () => {
    try {
        queryLogOffset = fs.statSync(path.join(configDirGlobal || '', 'query.log')).size;
    } catch (e) {
        queryLogOffset = 0;
    }
});

ipcMain.handle('adapters:list', () => {
    try { return { ok: true, list: netmode.getUpPhysicalAdapters() }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
});

/* ---------- авто-обновление (GitHub Releases) ---------- */
const REPO_RELEASES = `https://github.com/${updater.REPO}/releases/latest`;
interface UpdateState {
    available: boolean;
    version: string | null;
    downloading: boolean;
    percent: number;
    setupUrl: string | null;
    portableUrl: string | null;
    sumsUrl: string | null;
    sizeMb: number | null;   // размер подходящего артефакта — для подтверждения в UI
}
const updateState: UpdateState = {
    available: false, version: null,
    downloading: false, percent: 0,
    setupUrl: null, portableUrl: null, sumsUrl: null, sizeMb: null,
};

async function checkForUpdates(manual = false): Promise<void> {
    if (!settings.autoUpdate && !manual) return;
    try {
        const rel = await updater.latestRelease();
        if (updater.isNewer(rel.version, app.getVersion())) {
            updateState.available = true;
            updateState.version = rel.version;
            updateState.setupUrl = rel.setupUrl;
            updateState.portableUrl = rel.portableUrl;
            updateState.sumsUrl = rel.sumsUrl;
            const sizeMb = (process.env.PORTABLE_EXECUTABLE_DIR ? rel.portableSizeMb : rel.setupSizeMb) ?? null;
            updateState.sizeMb = sizeMb;
            sendToRenderer('update:available', { version: rel.version, sizeMb });
        } else if (manual) {
            sendToRenderer('modules:event', { text: `У вас последняя версия (v${app.getVersion()})` });
        }
    } catch (e) {
        if (manual) sendToRenderer('modules:event', { text: `Проверка обновлений не удалась: ${(e as Error).message}` });
    }
}

/* Установка: скачиваем файл релиза, сверяем SHA-256 с SHA256SUMS.txt релиза
 * (без sums-файла или при несовпадении тихая установка НЕ запускается) и
 * перезапускаемся через cmd-сценарий.
 * NSIS: ждём выхода Invis -> тихая установка (/S) -> автозапуск.
 * Portable: переименовываем запущенный exe (Windows это разрешает), подкладываем новый. */
async function startUpdate(): Promise<void> {
    if (!updateState.available || updateState.downloading) return;
    if (!app.isPackaged) {
        shell.openExternal(REPO_RELEASES);
        return;
    }
    const portable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
    const assetUrl = portable ? updateState.portableUrl : updateState.setupUrl;
    if (!assetUrl) { sendToRenderer('modules:event', { text: 'В релизе нет подходящего файла' }); return; }
    if (!updateState.sumsUrl) {
        sendToRenderer('modules:event', {
            text: 'В релизе нет SHA256SUMS.txt — авто-установка отменена. Скачайте вручную: ' + REPO_RELEASES,
        });
        return;
    }

    updateState.downloading = true;
    updateState.percent = 0;
    sendToRenderer('update:progress', { percent: 0 });

    const dest = path.join(app.getPath('temp'), path.basename(assetUrl));
    try {
        await updater.download(assetUrl, dest, {
            onProgress: (p) => {
                updateState.percent = p;
                sendToRenderer('update:progress', { percent: p });
            },
        });
    } catch (e) {
        updateState.downloading = false;
        try { fs.unlinkSync(dest); } catch (_e) { /* не создан */ }
        sendToRenderer('update:progress', { error: (e as Error).message });
        return;
    }

    /* Проверка целостности перед запуском скачанного exe */
    try {
        const sums = updater.parseSums(await updater.getText(updateState.sumsUrl));
        const expected = sums[path.basename(assetUrl)];
        const actual = await updater.sha256File(dest);
        if (!expected) throw new Error('нет суммы для файла в SHA256SUMS.txt');
        if (expected !== actual) throw new Error('сумма не совпала');
        netmodeLog(`Обновление v${updateState.version}: SHA-256 сверен`);
    } catch (e) {
        updateState.downloading = false;
        try { fs.unlinkSync(dest); } catch (_e) { /* уже нет */ }
        netmodeLog(`Обновление v${updateState.version}: проверка целостности не пройдена (${(e as Error).message})`);
        sendToRenderer('update:progress', {
            error: `Проверка целостности не пройдена (${(e as Error).message}) — установка отменена`,
        });
        return;
    }
    updateState.downloading = false;
    sendToRenderer('update:downloaded', {});

    /* Portable: process.execPath — временный распакованный exe, настоящий
     * лаунчер лежит в PORTABLE_EXECUTABLE_DIR (раньше обновляли не тот файл) */
    let exe = process.execPath;
    if (portable) {
        exe = path.join(process.env.PORTABLE_EXECUTABLE_DIR as string,
            process.env.PORTABLE_EXECUTABLE_FILENAME || 'Invis.exe');
    }
    const dir = path.dirname(exe);
    const q = (s: string) => `"${s}"`;
    let cmdLines: string[];
    if (portable) {
        cmdLines = [
            '@echo off',
            'timeout /t 3 /nobreak >nul',
            `if exist ${q(path.join(dir, 'Invis.exe.old'))} del /q ${q(path.join(dir, 'Invis.exe.old'))}`,
            `ren ${q(exe)} "Invis.exe.old"`,
            `move /y ${q(dest)} ${q(exe)}`,
            `start "" ${q(exe)}`,
            'exit',
        ];
    } else {
        cmdLines = [
            '@echo off',
            ':waitclose',
            'timeout /t 1 /nobreak >nul',
            `tasklist /fi "imagename eq ${path.basename(exe)}" | find /i "${path.basename(exe)}" >nul && goto waitclose`,
            `start /wait "" ${q(dest)} /S`,
            `start "" ${q(exe)}`,
            'exit',
        ];
    }
    /* Случайный каталог в %TEMP% вместо предсказуемых имён (подмена между
     * записью и запуском) */
    const tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'invis-update-'));
    const cmdPath = path.join(tmpDir, 'update.cmd');
    fs.writeFileSync(cmdPath, cmdLines.join(String.fromCharCode(13, 10)), 'utf8');
    /* Тихий запуск: прямой spawn cmd моргал консольными окнами. wscript —
     * GUI-процесс без консоли, а сам cmd выполняется со скрытым окном (стиль 0) */
    const vbsPath = path.join(tmpDir, 'update.vbs');
    const vbs = 'CreateObject("WScript.Shell").Run """' + cmdPath.replace(/"/g, '""') + '""", 0, False';
    fs.writeFileSync(vbsPath, '\ufeff' + vbs, 'utf16le'); // UTF-16 + BOM: temp может содержать не-ASCII
    spawn('wscript', ['//B', vbsPath], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
    quitting = true;
    netmodeLog(`Обновление на v${updateState.version}: файл скачан и сверен, приложение перезапустится через установку`);
    setTimeout(() => app.quit(), 300);
}

/* ---------- IPC: диагностика, Tor NEWNYM, мосты, ярлыки ---------- */
ipcMain.handle('diag:run', async () => {
    const listen = dnsApplied ? 53 : PORTS.dnscrypt;
    const pending = 'проверяю…';
    const res: Record<string, { ok: boolean; detail: string }> = {
        dns: { ok: false, detail: supervisor?.isRunning('dnscrypt') ? pending : 'не запущен' },
        tor: { ok: false, detail: supervisor?.isRunning('tor') ? pending : 'не запущен' },
        i2p: { ok: false, detail: supervisor?.isRunning('i2p') ? pending : 'не запущен' },
        realIp: { ok: false, detail: pending },
        torIp: { ok: false, detail: supervisor?.isRunning('tor') ? pending : 'Tor не запущен' },
    };
    const push = () => sendToRenderer('diag:result', res);
    push(); // первый кадр — сразу видно, что проверка идёт

    const jobs: Array<Promise<unknown>> = [];
    if (supervisor?.isRunning('dnscrypt')) {
        jobs.push(diag.dnsQueryTcp(listen).then((v) => {
            res.dns = { ...v, detail: `${v.detail} · порт ${listen}` };
            push();
        }));
    }
    if (supervisor?.isRunning('tor')) {
        jobs.push(torctl.circuitEstablished(path.join(store.baseDir(), 'data', 'tor')).then((est) => {
            res.tor = { ok: est, detail: est ? 'цепочка установлена' : 'цепочка ещё строится' };
            push();
        }));
        jobs.push(ipinfo.getTorIp(PORTS.torSocks).then((v) => {
            res.torIp = { ok: v.isTor, detail: `${v.ip} (выход Tor)` };
            push();
        }).catch((e) => {
            res.torIp = { ok: false, detail: e.message };
            push();
        }));
    }
    if (supervisor?.isRunning('i2p')) {
        jobs.push(diag.probeTcp(PORTS.i2pHttp).then((ok) => {
            res.i2p = { ok, detail: 'прокси 4444' };
            push();
        }));
    }
    jobs.push(ipinfo.getDirectIp().then((ip) => {
        res.realIp = { ok: true, detail: ip };
        push();
    }).catch((e) => {
        res.realIp = { ok: false, detail: e.message };
        push();
    }));
    await Promise.allSettled(jobs);
    push();
    return res;
});

ipcMain.on('tor:newip', () => {
    if (!supervisor?.isRunning('tor')) {
        sendToRenderer('modules:event', { text: 'Tor не запущен — IP менять нечего' });
        return;
    }
    void torctl.newIp(path.join(store.baseDir(), 'data', 'tor')).then((r) => {
        sendToRenderer('modules:event', { text: r.ok ? 'Tor: запрошена новая цепочка — новый IP получат НОВЫЕ соединения; открытые вкладки могут показывать старый IP до обновления страницы (F5)' : `Tor NEWNYM: ${r.detail}` });
    });
});

ipcMain.handle('bridges:fetch', async (_e, transport: string) => bridges.fetchBridges(transport || 'obfs4'));

/* ---------- Tor: страны выхода (Onionoo) и тест скорости ---------- */
ipcMain.handle('tor:countries', async (_e, { force }: { force?: boolean } = {}) =>
    onionoo.exitCountries(store.baseDir(), { force }));

ipcMain.on('proxy:copy', () => {
    clipboard.writeText('socks5://127.0.0.1:9050');
    sendToRenderer('modules:event', { text: 'Скопировано: socks5://127.0.0.1:9050' });
});

ipcMain.handle('net:speed', (_e, { viaTor }: { viaTor?: boolean } = {}) => netspeed.measure({ viaTor: Boolean(viaTor) }));

ipcMain.handle('tor:exitinfo', async () => {
    if (!supervisor?.isRunning('tor')) return { ok: false, error: 'Tor не запущен' };
    try { return await torspeed.exitInfo(); }
    catch (e) { return { ok: false, error: (e as Error).message }; }
});

ipcMain.handle('tor:speedtest', async () => {
    if (!supervisor?.isRunning('tor')) {
        return { ok: false, error: 'Сначала запустите Tor' };
    }
    try {
        const r = await torspeed.fullTest();
        return { ok: r.isTor !== false, ...r };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
});

ipcMain.handle('update:state', () => ({ ...updateState, currentVersion: app.getVersion(), autoUpdate: Boolean(settings.autoUpdate), installSupported: app.isPackaged }));
ipcMain.on('update:check', () => { void checkForUpdates(true); });
ipcMain.on('update:install', () => { void startUpdate(); });

ipcMain.on('open:console-i2p', () => shell.openExternal('http://127.0.0.1:7070'));
ipcMain.on('open:logs', () => shell.openPath(path.join(store.baseDir(), 'logs')));
ipcMain.on('open:github', () => shell.openExternal('https://github.com/javierpenadev/Invis'));

app.on('before-quit', (e) => {
    quitting = true;
    saveWindowBounds(); // app.exit(0) минует 'close' — геометрию сохраняем здесь
    if (cleanupDone) return;
    /* Блокирующая очистка: гасим демоны и возвращаем системный DNS,
     * и только затем выходим (иначе процессы-«зомби» и сломанный DNS) */
    e.preventDefault();
    const forceExit = setTimeout(() => { cleanupDone = true; app.exit(0); }, 8000);
    (async () => {
        try { await supervisor?.stopAll(); } catch (err) { /* гасим любой ценой */ }
        if (dnsApplied) restoreSystemDns();
        if (proxyEffectActive()) restoreSystemProxy();
        clearTimeout(forceExit);
        cleanupDone = true;
        app.exit(0);
    })();
});

app.on('window-all-closed', () => {
    /* Окно закрывается «насмерть» только когда quitting (иначе close уходит в трей) */
    app.quit();
});
