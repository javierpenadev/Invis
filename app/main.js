/*
 * Invis — Electron-оболочка tray-приложения.
 * Окно маленькое, закрывается в трей; настройки — JSON (store.js).
 * Точки расширения помечены «Точка расширения:» (демоны, IPC-каналы и т.п.).
 */
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { buildAll: buildConfigs, PORTS } = require('./lib/configs');
const { DaemonSupervisor } = require('./lib/daemons');
const netmode = require('./lib/netmode');
const { readResolvers } = require('./lib/resolvers');
const torctl = require('./lib/torctl');
const diag = require('./lib/diag');
const blocklists = require('./lib/blocklists');
const bridges = require('./lib/bridges');
const updater = require('./lib/updater');
const proxy = require('./lib/proxy');

let win = null;
let tray = null;
let trayState = null;
const trayIcons = {};
let quitting = false;          // true — выходим по-настоящему, а не сворачиваемся
let balloonShown = false;      // подсказка «работает в трее» — один раз за сессию
let settings = store.load();
let supervisor = null;
let configDirGlobal = null;
let dnsApplied = false;        // системный DNS направлен на 127.0.0.1
let newIpTimer = null;         // авто-смена IP Tor
let cleanupDone = false;       // очистка перед выходом выполнена
const startupWarnings = [];   // предупреждения для UI после создания окна
let proxyApplied = false;      // системный прокси направлен на Tor

const TITLE = 'Invis';
const DAEMON_VERSIONS = { tor: '0.4.9.12', dnscrypt: '2.1.18', i2pd: '2.61.0' };
const dnsBackupFile = () => path.join(store.baseDir(), 'dns-backup.json');

/* ---------- единственный экземпляр ---------- */
/* relaunchElevated стартует новый процесс, пока старый ещё завершается
 * (блокирующая очистка демонов занимает секунды) — lock бывает занят.
 * Даём новому экземпляру до 10 с на его освобождение. */
function run() {
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

function onReady() {
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
            /* Системный прокси живёт вместе с Tor: галка-настройка сохраняется,
             * снимается/возвращается только эффект */
            if (payload.name === 'tor') {
                if ((payload.state === 'off' || payload.state === 'error') && proxyApplied) {
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
                disableSystemDns(false);
                sendToRenderer('modules:event', { text: 'DNSCrypt остановлен — системный DNS восстановлен (галка сохранена)' });
            }
        },
    });

    createWindow();
    initTrayIcons();
    createTray();
    scheduleNewIp();

    /* Авто-обновление: первая проверка через 20 с, далее раз в 4 часа */
    if (!process.env.INVIS_NO_UPDATE) {
        setTimeout(() => checkForUpdates(), 20000);
        setInterval(() => checkForUpdates(), 4 * 60 * 60 * 1000);
    }
    /* мусор от прошлых обновлений portable-версии */
    if (app.isPackaged && process.env.PORTABLE_EXECUTABLE_DIR) {
        try { fs.unlinkSync(path.join(path.dirname(process.execPath), 'Invis.exe.old')); } catch (e) { /* нет файла */ }
    }

    startupWarnings.forEach((w, i) => {
        setTimeout(() => sendToRenderer('modules:event', { text: w }), 1500 + i * 1200);
    });

    /* Автозапуск модулей согласно настройкам */
    if (!process.env.INVIS_NO_AUTOSTART) {
        const started = supervisor.startEnabled(settings.autostart);
        /* Системный прокси живёт вместе с Tor: если галка включена, Tor нужен всегда */
        if (settings.systemProxy && !supervisor.isRunning('tor')) supervisor.start('tor');
        if (started.length) console.log(`[Invis] Автозапуск модулей: ${started.join(', ')}`);
    }
}

/* Каталог бинарников: в сборке — resources/bin, в dev — <проект>/bin */
function binDir() {
    return app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, 'bin');
}

/* ---------- системный DNS (перехват на 127.0.0.1, порт 53 у dnscrypt) ---------- */
function netmodeLog(msg) {
    try {
        fs.mkdirSync(path.join(store.baseDir(), 'logs'), { recursive: true });
        fs.appendFileSync(path.join(store.baseDir(), 'logs', 'netmode.log'),
            `${new Date().toISOString()} ${msg}\n`);
    } catch (e) { /* лог не критичен */ }
}

function applySystemDns() {
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
    const backup = adapters.map((a) => ({ alias: a, addresses: netmode.getDnsServers(a) }));
    netmode.writeBackup(dnsBackupFile(), backup);
    netmodeLog(`Перехват DNS включён. Адаптеры: [${adapters.join(', ')}]. Сохранено: `
        + JSON.stringify(backup));
    for (const a of adapters) netmode.setDnsLoopback(a);
    dnsApplied = true;
    return { ok: true };
}

function restoreSystemDns() {
    const backup = netmode.readBackup(dnsBackupFile());
    if (!backup) { dnsApplied = false; return; }
    for (const { alias, addresses } of backup) {
        try {
            /* Если в бэкапе только loopback — прежний локальный резольвер уже не
             * работает, восстановление вернёт нерабочий DNS. Ставим публичные. */
            const allLoopback = addresses.length
                && addresses.every((a) => /^(127\.|::1$)/.test(a));
            if (!addresses.length || allLoopback) netmode.resetDns(alias);
            else netmode.setDnsList(alias, addresses);
        } catch (e) {
            netmodeLog(`ОШИБКА восстановления DNS на «${alias}»: ${e.message}`);
        }
    }
    netmode.removeBackup(dnsBackupFile());
    netmodeLog('Системный DNS восстановлен');
    dnsApplied = false;
}

/* После сбоя: вернуть прежние настройки DNS */
function recoverSystemDnsIfNeeded() {
    if (!netmode.readBackup(dnsBackupFile())) return;
    netmodeLog('Обнаружен невосстановленный dns-backup при старте');
    if (netmode.isElevated()) {
        restoreSystemDns();
        return;
    }
    const { response } = dialog.showMessageBoxSync({
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
function restoreElevatedOneShot() {
    const backup = netmode.readBackup(dnsBackupFile());
    if (!backup) return;
    const lines = backup.map(({ alias, addresses }) => addresses && addresses.length
        ? `Set-DnsClientServerAddress -InterfaceAlias '${alias.replace(/'/g, "''")}' -ServerAddresses ${addresses.map((a) => `'${a}'`).join(',')}`
        : `Set-DnsClientServerAddress -InterfaceAlias '${alias.replace(/'/g, "''")}' -ResetServerAddresses`);
    const ps1 = path.join(app.getPath('temp'), 'invis-dns-restore.ps1');
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
    }
}

/* Перезапуск приложения с правами администратора (UAC) */
function relaunchElevated() {
    const exe = process.execPath.replace(/'/g, "''");
    const args = app.isPackaged ? [] : [__dirname.replace(/'/g, "''")];
    const ps = `Start-Process -FilePath '${exe}' ${args.length ? `-ArgumentList ${args.map((a) => `'${a}'`).join(',')}` : ''} -Verb RunAs`;
    spawn('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true, stdio: 'ignore', detached: true }).unref();
    quitting = true;
    setTimeout(() => app.quit(), 300);
}

/* Перегенерация конфигов (порт dnscrypt зависит от режима DNS) */
function rebuildConfigs() {
    const listen = dnsApplied ? 53 : PORTS.dnscrypt;
    const base = store.baseDir();
    buildConfigs({
        configDir: configDirGlobal,
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

function rebuildConfigsAndRestartDnscrypt() {
    rebuildConfigs();
    if (supervisor?.isRunning('dnscrypt')) {
        supervisor.stop('dnscrypt').then(() => supervisor.start('dnscrypt'));
    }
}

/* Родная иконка i2pd в трее создаётся безусловно (USE_WIN32_APP вшит на
 * уровне сборки, опции отключения нет). В трее должен быть только Invis —
 * находим скрытое окно i2pd и удаляем его иконку через Shell_NotifyIcon.
 * Вернётся она только после перезапуска explorer (TaskbarCreated). */
function hideI2pdTrayIcon() {
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
    } catch (e) { netmodeLog(`Не удалось скрыть иконку i2pd: ${e.message}`); }
}

/* Firewall-правило для доступа к DNS из LAN (best-effort, нужен админ) */
function syncLanFirewall(enabled) {
    try {
        if (enabled) {
            execFileSync('netsh', ['advfirewall', 'firewall', 'add', 'rule',
                'name=Invis DNS (UDP 53)', 'dir=in', 'action=allow', 'protocol=UDP', 'localport=53'],
                { windowsHide: true, stdio: 'ignore' });
            execFileSync('netsh', ['advfirewall', 'firewall', 'add', 'rule',
                'name=Invis DNS (TCP 53)', 'dir=in', 'action=allow', 'protocol=TCP', 'localport=53'],
                { windowsHide: true, stdio: 'ignore' });
        } else {
            execFileSync('netsh', ['advfirewall', 'firewall', 'delete', 'rule', 'name=Invis DNS (UDP 53)'],
                { windowsHide: true, stdio: 'ignore' });
            execFileSync('netsh', ['advfirewall', 'firewall', 'delete', 'rule', 'name=Invis DNS (TCP 53)'],
                { windowsHide: true, stdio: 'ignore' });
        }
        netmodeLog(`Firewall LAN DNS: ${enabled ? 'разрешён' : 'правила удалены'}`);
    } catch (e) {
        netmodeLog(`Firewall LAN DNS: не удалось (${e.message})`);
    }
}

/* Снять перехват DNS, сохранив галку как намерение: эффект вернётся при
 * следующем старте dnscrypt (см. prepareDnsInterceptBeforeStart) */
async function disableSystemDns(stopDnscryptAfter) {
    if (dnsApplied) restoreSystemDns();
    rebuildConfigs();
    if (stopDnscryptAfter && supervisor?.isRunning('dnscrypt')) {
        await supervisor.stop('dnscrypt');
    }
}

/* Перед стартом dnscrypt: галка перехвата включена, но эффект не применён —
 * применить (адаптеры → 127.0.0.1) и пересобрать конфиг на порт 53 */
function prepareDnsInterceptBeforeStart() {
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
function startAllModules() {
    prepareDnsInterceptBeforeStart();
    supervisor?.startEnabled(settings.autostart);
    if (settings.systemProxy && !supervisor.isRunning('tor')) supervisor.start('tor');
}

const proxyBackupFile = () => path.join(store.baseDir(), 'proxy-backup.json');

function applySystemProxy() {
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

function restoreSystemProxy() {
    if (fs.existsSync(proxyBackupFile())) {
        try {
            const saved = JSON.parse(fs.readFileSync(proxyBackupFile(), 'utf8'));
            /* Отравленный бэкап (наш собственный socks) восстанавливать нельзя —
             * это вернуло бы прокси Invis; считаем, что до нас прокси был выключен */
            const poisoned = Boolean(saved) && saved.proxyServer === 'socks=127.0.0.1:9050';
            proxy.restore(poisoned ? null : saved, app.getPath('temp'));
            netmodeLog('Системный прокси восстановлен: ' + JSON.stringify(poisoned ? null : saved));
        } catch (e) {
            netmodeLog(`ОШИБКА восстановления прокси: ${e.message}`);
        }
        try { fs.unlinkSync(proxyBackupFile()); } catch (e) { /* нет файла */ }
    }
    proxyApplied = false;
}

function stopAllModules() {
    if (!supervisor) return Promise.resolve();
    return (async () => {
        if (dnsApplied) await disableSystemDns(false); // вернуть адаптеры, затем гасить всё
        if (proxyApplied) restoreSystemProxy();        // вернуть системный прокси
        await Promise.all(supervisor.list.map((n) => supervisor.stop(n)));
    })();
}

/* ---------- окно ---------- */
function createWindow() {
    win = new BrowserWindow({
        width: 820,
        height: 560,
        minWidth: 660,
        minHeight: 440,
        frame: false,
        backgroundColor: '#1e1e2f',
        title: TITLE,
        icon: path.join(__dirname, 'assets', 'img', 'icon.ico'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
        },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'index.html'));

    win.on('close', (e) => {
        if (!quitting && settings.closeToTray) {
            e.preventDefault();
            hideToTray();
        }
    });
    win.on('closed', () => { win = null; });

    /* Смоук-тест: APP_SMOKE=<мс> — вывести консоль рендерера и закрыться */
    if (process.env.APP_SMOKE) {
        win.webContents.on('console-message', (_e, a, b) => {
            const msg = typeof a === 'object' && a ? a.message : (b ?? a);
            console.log('[renderer]', msg);
        });
        win.webContents.on('render-process-gone', (_e, details) => {
            console.error('[smoke] renderer gone:', details.reason);
        });
        setTimeout(() => app.quit(), Number(process.env.APP_SMOKE) || 8000);
    }
}

function showWindow() {
    if (!win) { createWindow(); return; }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
}

function hideToTray() {
    if (!win) return;
    win.hide();
    if (!balloonShown) {
        balloonShown = true;
        try {
            tray?.displayBalloon({
                title: TITLE,
                content: 'Приложение продолжает работать в трее.',
                icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'img', 'icon.ico')),
            });
        } catch (e) { /* balloon не критичен */ }
    }
}

/* ---------- трей ---------- */
const TRAY_LABELS = { on: 'работает', off: 'выключен', busy: 'проблема / переходный процесс' };

function initTrayIcons() {
    for (const s of ['on', 'off', 'busy']) {
        trayIcons[s] = nativeImage.createFromPath(path.join(__dirname, 'assets', 'img', `tray-${s}.png`));
    }
}

/* Агрегированный статус: жёлтый — ошибка или переход, зелёный — хоть один модуль
 * работает, красный — всё выключено (по ТЗ пользователя: green/red/yellow) */
function aggregateTrayState() {
    const states = Object.values(supervisor ? supervisor.status() : {}).map((v) => v.state);
    if (states.some((s) => s === 'error' || s === 'busy')) return 'busy';
    if (states.some((s) => s === 'on')) return 'on';
    return 'off';
}

function setTrayState(state) {
    if (!tray || !trayIcons[state] || state === trayState) return;
    trayState = state;
    tray.setImage(trayIcons[state]);
    tray.setToolTip(`Invis — ${TRAY_LABELS[state]}`);
}

function createTray() {
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

function trayMenu() {
    return Menu.buildFromTemplate([
        { label: 'Открыть Invis', click: () => showWindow() },
        { type: 'separator' },
        /* Точка расширения: управление модулями через супервизор */
        { label: 'Запустить всё', click: () => startAllModules() },
        { label: 'Остановить всё', click: () => stopAllModules() },
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
function applyLaunchWithWindows() {
    app.setLoginItemSettings({ openAtLogin: Boolean(settings.launchWithWindows) });
}

/* ---------- изменения настроек (общая точка: IPC и меню трея) ---------- */
function setSetting(patch) {
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
                dialog.showMessageBox(win, {
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
            const { response } = dialog.showMessageBoxSync(win, {
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
                dialog.showMessageBox(win, {
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
        sendToRenderer('modules:event', { text: `Не удалось сохранить настройки: ${e.message}` });
        throw e; // рендерер покажет ошибку в статус-баре
    }
    if (patch.launchWithWindows !== undefined) applyLaunchWithWindows();
    if (patch.autoUpdate) checkForUpdates(true);

    /* Изменились параметры dnscrypt — перегенерировать toml и мягко перезапустить */
    if (patch.dnscrypt !== undefined) {
        rebuildConfigsAndRestartDnscrypt();
        if (lanChanged) syncLanFirewall(Boolean(settings.dnscrypt?.lanAccess));
    }

    /* Изменились параметры Tor — bridges требуют пересборки torrc и рестарта */
    if (patch.tor !== undefined) {
        scheduleNewIp();
        if ((patch.tor.useBridges !== undefined || patch.tor.bridgesText !== undefined)
                && supervisor?.isRunning('tor')) {
            supervisor.stop('tor').then(() => supervisor.start('tor'));
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
                await blocklists.ensure(configDirGlobal, name);
                sendToRenderer('modules:event', { text: `Блок-лист «${blocklists.PRESETS[name].label}» загружен` });
                rebuildConfigsAndRestartDnscrypt();
            } catch (e) {
                sendToRenderer('modules:event', { text: `Блок-лист «${name}»: ${e.message}` });
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
function scheduleNewIp() {
    if (newIpTimer) { clearInterval(newIpTimer); newIpTimer = null; }
    const minutes = Number(settings.tor?.newIpMinutes) || 0;
    if (minutes <= 0) return;
    newIpTimer = setInterval(async () => {
        if (!supervisor?.isRunning('tor')) return;
        const r = await torctl.newIp(path.join(store.baseDir(), 'data', 'tor'));
        sendToRenderer('modules:event', { text: r.ok ? 'Tor: запрошена новая цепочка (новый IP)' : `Tor NEWNYM: ${r.detail}` });
    }, minutes * 60000);
}

function sendToRenderer(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ---------- IPC: тайтлбар ---------- */
ipcMain.on('window-minimize', () => win?.minimize());
ipcMain.on('window-maximize', () => {
    if (!win) return;
    win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('window-devtools', () => win?.webContents.toggleDevTools());
ipcMain.on('window-close', () => win?.close());
ipcMain.on('window-hide', () => hideToTray());
ipcMain.on('app:quit', () => { quitting = true; app.quit(); });

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
ipcMain.on('modules:stop-all', () => stopAllModules());
ipcMain.on('modules:toggle', (_e, name) => {
    if (!supervisor || !supervisor.specs[name]) return;
    if (supervisor.isRunning(name)) {
        /* Остановка dnscrypt при перехвате: сначала вернуть системный DNS */
        if (name === 'dnscrypt' && dnsApplied) { disableSystemDns(true); return; }
        supervisor.stop(name);
    } else {
        if (name === 'dnscrypt') prepareDnsInterceptBeforeStart();
        supervisor.start(name);
    }
});
ipcMain.on('modules:start', (_e, name) => {
    if (name === 'dnscrypt') prepareDnsInterceptBeforeStart();
    supervisor?.start(name);
});
ipcMain.on('modules:stop', (_e, name) => {
    if (name === 'dnscrypt' && dnsApplied) { disableSystemDns(true); return; }
    supervisor?.stop(name);
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

ipcMain.handle('querylog:get', (_e, { filter } = {}) => {
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
    catch (e) { return { ok: false, error: e.message }; }
});

/* ---------- авто-обновление (GitHub Releases) ---------- */
const REPO_RELEASES = `https://github.com/${updater.REPO}/releases/latest`;
const updateState = {
    available: false, version: null,
    downloading: false, percent: 0,
    setupUrl: null, portableUrl: null,
};

async function checkForUpdates(manual = false) {
    if (!settings.autoUpdate && !manual) return;
    try {
        const rel = await updater.latestRelease();
        if (updater.isNewer(rel.version, app.getVersion())) {
            updateState.available = true;
            updateState.version = rel.version;
            updateState.setupUrl = rel.setupUrl;
            updateState.portableUrl = rel.portableUrl;
            sendToRenderer('update:available', { version: rel.version });
        } else if (manual) {
            sendToRenderer('modules:event', { text: `У вас последняя версия (v${app.getVersion()})` });
        }
    } catch (e) {
        if (manual) sendToRenderer('modules:event', { text: `Проверка обновлений не удалась: ${e.message}` });
    }
}

/* Установка: скачиваем файл релиза и перезапускаемся через cmd-сценарий.
 * NSIS: ждём выхода Invis -> тихая установка (/S) -> автозапуск.
 * Portable: переименовываем запущенный exe (Windows это разрешает), подкладываем новый. */
async function startUpdate() {
    if (!updateState.available || updateState.downloading) return;
    if (!app.isPackaged) {
        shell.openExternal(REPO_RELEASES);
        return;
    }
    const portable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
    const assetUrl = portable ? updateState.portableUrl : updateState.setupUrl;
    if (!assetUrl) { sendToRenderer('modules:event', { text: 'В релизе нет подходящего файла' }); return; }

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
        sendToRenderer('update:progress', { error: e.message });
        return;
    }
    updateState.downloading = false;
    sendToRenderer('update:downloaded', {});

    const exe = process.execPath;
    const dir = path.dirname(exe);
    const q = (s) => `"${s}"`;
    let cmdLines;
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
    const cmdPath = path.join(app.getPath('temp'), 'invis-update.cmd');
    fs.writeFileSync(cmdPath, cmdLines.join(String.fromCharCode(13, 10)), 'utf8');
    /* Тихий запуск: прямой spawn cmd моргал консольными окнами. wscript —
     * GUI-процесс без консоли, а сам cmd выполняется со скрытым окном (стиль 0) */
    const vbsPath = path.join(app.getPath('temp'), 'invis-update.vbs');
    const vbs = 'CreateObject("WScript.Shell").Run """' + cmdPath.replace(/"/g, '""') + '""", 0, False';
    fs.writeFileSync(vbsPath, '\ufeff' + vbs, 'utf16le'); // UTF-16 + BOM: temp может содержать не-ASCII
    spawn('wscript', ['//B', vbsPath], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
    quitting = true;
    netmodeLog(`Обновление на v${updateState.version}: файл скачан, приложение перезапустится через установку`);
    setTimeout(() => app.quit(), 300);
}

/* ---------- IPC: диагностика, Tor NEWNYM, мосты, ярлыки ---------- */
const { shell } = require('electron');
const ipinfo = require('./lib/ipinfo');

ipcMain.handle('diag:run', async () => {
    const listen = dnsApplied ? 53 : PORTS.dnscrypt;
    const pending = 'проверяю…';
    const res = {
        dns: { ok: false, detail: supervisor?.isRunning('dnscrypt') ? pending : 'не запущен' },
        tor: { ok: false, detail: supervisor?.isRunning('tor') ? pending : 'не запущен' },
        i2p: { ok: false, detail: supervisor?.isRunning('i2p') ? pending : 'не запущен' },
        realIp: { ok: false, detail: pending },
        torIp: { ok: false, detail: supervisor?.isRunning('tor') ? pending : 'Tor не запущен' },
    };
    const push = () => sendToRenderer('diag:result', res);
    push(); // первый кадр — сразу видно, что проверка идёт

    const jobs = [];
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

ipcMain.on('tor:newip', async () => {
    if (!supervisor?.isRunning('tor')) {
        sendToRenderer('modules:event', { text: 'Tor не запущен — IP менять нечего' });
        return;
    }
    const r = await torctl.newIp(path.join(store.baseDir(), 'data', 'tor'));
    sendToRenderer('modules:event', { text: r.ok ? 'Tor: запрошена новая цепочка (новый IP)' : `Tor NEWNYM: ${r.detail}` });
});

ipcMain.handle('bridges:fetch', async (_e, transport) => bridges.fetchBridges(transport || 'obfs4'));

ipcMain.handle('update:state', () => ({ ...updateState, currentVersion: app.getVersion(), autoUpdate: Boolean(settings.autoUpdate), installSupported: app.isPackaged }));
ipcMain.on('update:check', () => checkForUpdates(true));
ipcMain.on('update:install', () => startUpdate());

ipcMain.on('open:console-i2p', () => shell.openExternal('http://127.0.0.1:7070'));
ipcMain.on('open:logs', () => shell.openPath(path.join(store.baseDir(), 'logs')));
ipcMain.on('open:github', () => shell.openExternal('https://github.com/javierpenadev/Invis'));

/* ---------- нативные диалоги (общие) ---------- */
ipcMain.handle('dialog:save', async (_e, { defaultName, extensions, label }) => {
    const res = await dialog.showSaveDialog(win, {
        title: 'Сохранить',
        defaultPath: defaultName,
        filters: [{ name: label || extensions[0].toUpperCase(), extensions }],
    });
    return res.canceled ? null : res.filePath;
});

app.on('before-quit', (e) => {
    quitting = true;
    if (cleanupDone) return;
    /* Блокирующая очистка: гасим демоны и возвращаем системный DNS,
     * и только затем выходим (иначе процессы-«зомби» и сломанный DNS) */
    e.preventDefault();
    const forceExit = setTimeout(() => { cleanupDone = true; app.exit(0); }, 8000);
    (async () => {
        try { await supervisor?.stopAll(); } catch (err) { /* гасим любой ценой */ }
        if (dnsApplied) restoreSystemDns();
        if (proxyApplied) restoreSystemProxy();
        clearTimeout(forceExit);
        cleanupDone = true;
        app.exit(0);
    })();
});

app.on('window-all-closed', () => {
    /* Окно закрывается «насмерть» только когда quitting (иначе close уходит в трей) */
    app.quit();
});
