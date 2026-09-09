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

const TITLE = 'Invis';
const DAEMON_VERSIONS = { tor: '0.4.9.12', dnscrypt: '2.1.18', i2pd: '2.61.0' };
const dnsBackupFile = () => path.join(store.baseDir(), 'dns-backup.json');

/* ---------- единственный экземпляр ---------- */
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => showWindow());
    app.whenReady().then(onReady);
}

function onReady() {
    /* Применяем автозапуск с Windows (синхронизирует реестр с настройкой) */
    applyLaunchWithWindows();

    const base = store.baseDir();
    configDirGlobal = path.join(base, 'configs');

    /* Восстановление системного DNS, если прошлый сеанс завершился некорректно */
    recoverSystemDnsIfNeeded();

    /* Перехват системного DNS, включённый в настройках */
    if (settings.systemDns) {
        if (netmode.isElevated()) {
            const r = applySystemDns();
            if (!r.ok) {
                settings.systemDns = false;
                store.save(settings);
                console.warn('[Invis] Системный DNS не включён:', r.error);
            }
        } else {
            settings.systemDns = false;
            store.save(settings);
            console.warn('[Invis] systemDns включён, но запуск выполнен без прав администратора — режим отключён');
        }
    }

    /* Конфиги и супервизор демонов (bin/ — npm run fetch-bins, см. README) */
    buildConfigs({
        configDir: configDirGlobal,
        torDataDir: path.join(base, 'data', 'tor'),
        i2pDataDir: path.join(base, 'data', 'i2pd'),
        geoipDir: path.join(binDir(), 'tor', 'data'),
        i2pdContribDir: path.join(binDir(), 'i2pd', 'contrib'),
        dnscryptListen: dnsApplied ? 53 : PORTS.dnscrypt,
        dnscryptCfg: settings.dnscrypt,
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
        },
    });

    createWindow();
    initTrayIcons();
    createTray();

    /* Автозапуск модулей согласно настройкам */
    if (!process.env.INVIS_NO_AUTOSTART) {
        const started = supervisor.startEnabled(settings.autostart);
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
            if (addresses && addresses.length) netmode.setDnsList(alias, addresses);
            else netmode.resetDns(alias);
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

/* Перегенерация конфигов (порт dnscrypt зависит от режима DNS) + мягкий рестарт */
function rebuildConfigsAndRestartDnscrypt() {
    const listen = dnsApplied ? 53 : PORTS.dnscrypt;
    const base = store.baseDir();
    buildConfigs({
        configDir: configDirGlobal,
        torDataDir: path.join(base, 'data', 'tor'),
        i2pDataDir: path.join(base, 'data', 'i2pd'),
        geoipDir: path.join(binDir(), 'tor', 'data'),
        i2pdContribDir: path.join(binDir(), 'i2pd', 'contrib'),
        dnscryptListen: listen,
        dnscryptCfg: settings.dnscrypt,
    });
    supervisor?.setDnscryptPort(listen);
    if (supervisor?.isRunning('dnscrypt')) {
        supervisor.stop('dnscrypt').then(() => supervisor.start('dnscrypt'));
    }
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

/* Нельзя загасить dnscrypt, пока он обслуживает системный DNS */
function guardDnscryptStop(name) {
    if (name === 'dnscrypt' && dnsApplied && supervisor?.isRunning('dnscrypt')) {
        sendToRenderer('modules:event', {
            text: 'DNSCrypt обслуживает системный DNS — сначала отключите «Перехват системного DNS».',
        });
        return true;
    }
    return false;
}

function stopAllModules() {
    if (!supervisor) return;
    const names = supervisor.list.filter((n) => !(dnsApplied && n === 'dnscrypt'));
    if (dnsApplied) sendToRenderer('modules:event', { text: 'DNSCrypt оставлен активным: обслуживает системный DNS' });
    names.forEach((n) => supervisor.stop(n));
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
        { label: 'Запустить всё', click: () => supervisor?.startEnabled(settings.autostart) },
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
    store.save(settings);
    if (patch.launchWithWindows !== undefined) applyLaunchWithWindows();

    /* Изменились параметры dnscrypt — перегенерировать toml и мягко перезапустить */
    if (patch.dnscrypt !== undefined) {
        rebuildConfigsAndRestartDnscrypt();
        if (lanChanged) syncLanFirewall(Boolean(settings.dnscrypt?.lanAccess));
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
ipcMain.on('modules:start-all', () => supervisor?.startEnabled(settings.autostart));
ipcMain.on('modules:stop-all', () => stopAllModules());
ipcMain.on('modules:toggle', (_e, name) => {
    if (!supervisor || !supervisor.specs[name]) return;
    if (supervisor.isRunning(name)) {
        if (guardDnscryptStop(name)) return;
        supervisor.stop(name);
    } else {
        supervisor.start(name);
    }
});
ipcMain.on('modules:start', (_e, name) => supervisor?.start(name));
ipcMain.on('modules:stop', (_e, name) => {
    if (guardDnscryptStop(name)) return;
    supervisor?.stop(name);
});

/* ---------- IPC: резольверы, лог запросов, адаптеры ---------- */
ipcMain.handle('resolvers:list', () => {
    if (!configDirGlobal) return { ok: false, error: 'Приложение ещё инициализируется' };
    return readResolvers(configDirGlobal);
});

ipcMain.handle('querylog:get', (_e, { filter } = {}) => {
    const file = path.join(configDirGlobal || '', 'query.log');
    let content = '';
    try {
        const fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        const start = Math.max(0, size - 128 * 1024);
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        content = buf.toString('utf8');
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
    try { fs.writeFileSync(path.join(configDirGlobal || '', 'query.log'), '', 'utf8'); } catch (e) {}
});

ipcMain.handle('adapters:list', () => {
    try { return { ok: true, list: netmode.getUpPhysicalAdapters() }; }
    catch (e) { return { ok: false, error: e.message }; }
});

/* ---------- нативные диалоги (общие) ---------- */
ipcMain.handle('dialog:save', async (_e, { defaultName, extensions, label }) => {
    const res = await dialog.showSaveDialog(win, {
        title: 'Сохранить',
        defaultPath: defaultName,
        filters: [{ name: label || extensions[0].toUpperCase(), extensions }],
    });
    return res.canceled ? null : res.filePath;
});

app.on('before-quit', () => {
    quitting = true;
    /* Гасим демоны и возвращаем системный DNS, чтобы не оставлять поломок */
    supervisor?.stopAll();
    if (dnsApplied) restoreSystemDns();
});

app.on('window-all-closed', () => {
    /* Окно закрывается «насмерть» только когда quitting (иначе close уходит в трей) */
    app.quit();
});
