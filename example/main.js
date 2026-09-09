/*
 * Invis — Electron-оболочка tray-приложения.
 * Окно маленькое, закрывается в трей; настройки — JSON (store.js).
 * Точки расширения помечены «Точка расширения:» (демоны, IPC-каналы и т.п.).
 */
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const store = require('./store');
const { buildAll: buildConfigs, PORTS } = require('./lib/configs');
const { DaemonSupervisor } = require('./lib/daemons');

let win = null;
let tray = null;
let trayState = null;
const trayIcons = {};
let quitting = false;          // true — выходим по-настоящему, а не сворачиваемся
let balloonShown = false;      // подсказка «работает в трее» — один раз за сессию
let settings = store.load();
let supervisor = null;

const TITLE = 'Invis';

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

    /* Конфиги и супервизор демонов (bin/ — npm run fetch-bins, см. README) */
    const base = store.baseDir();
    const configDir = path.join(base, 'configs');
    buildConfigs({
        configDir,
        torDataDir: path.join(base, 'data', 'tor'),
        i2pDataDir: path.join(base, 'data', 'i2pd'),
        geoipDir: path.join(binDir(), 'tor', 'data'),
        i2pdContribDir: path.join(binDir(), 'i2pd', 'contrib'),
    });
    supervisor = new DaemonSupervisor({
        binDir: binDir(),
        configDir,
        logDir: path.join(base, 'logs'),
        i2pdDataDir: path.join(base, 'data', 'i2pd'),
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
        { label: 'Остановить всё', click: () => supervisor?.stopAll() },
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
    /* Глубокий merge в дефолты — неизвестные ключи отбрасываются, вложенный
     * autostart не теряет соседние флаги при частичном патче */
    settings = store.deepMerge(store.load(), patch);
    store.save(settings);
    if (patch.launchWithWindows !== undefined) applyLaunchWithWindows();
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

/* ---------- IPC: модули (реальный супервизор демонов) ---------- */
ipcMain.handle('modules:status', () => supervisor?.status() || {});
ipcMain.on('modules:start-all', () => supervisor?.startEnabled(settings.autostart));
ipcMain.on('modules:stop-all', () => supervisor?.stopAll());
ipcMain.on('modules:toggle', (_e, name) => {
    if (!supervisor || !supervisor.specs[name]) return;
    supervisor.isRunning(name) ? supervisor.stop(name) : supervisor.start(name);
});
ipcMain.on('modules:start', (_e, name) => supervisor?.start(name));
ipcMain.on('modules:stop', (_e, name) => supervisor?.stop(name));

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
    /* Гасим демоны, чтобы не оставлять «зомби»-процессы */
    supervisor?.stopAll();
});

app.on('window-all-closed', () => {
    /* Окно закрывается «насмерть» только когда quitting (иначе close уходит в трей) */
    app.quit();
});
