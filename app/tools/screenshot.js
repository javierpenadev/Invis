/*
 * Скриншот окна приложения без запуска демонов (для визуальной проверки UI).
 * Запуск: node tools/screenshot.js [файл.png] [мс]
 */
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const OUT = process.argv[2] || path.join(__dirname, 'screenshot.png');
const WAIT = Number(process.argv[3]) || 2500;

ipcMain.handle('settings:get', () => ({
    launchWithWindows: false,
    closeToTray: true,
    systemDns: false,
    systemDnsAdapters: [],
    autostart: { dnscrypt: true, tor: true, i2p: false },
    dnscrypt: {
        autoMode: true, servers: [], requireDnssec: false, requireNolog: true,
        requireNofilter: true, dnscryptProto: true, dohProto: true, cache: true,
        blockIpv6: false, forceTcp: false, lanAccess: false,
        bootstrap: ['9.9.9.9:53', '8.8.8.8:53'], queryLog: false,
    },
}));
ipcMain.handle('modules:status', () => ({
    dnscrypt: { state: 'on', status: 'работает' },
    tor: { state: 'busy', status: '45%' },
    i2p: { state: 'off', status: 'остановлен' },
}));
ipcMain.handle('app:info', () => ({
    version: '1.0.0',
    electron: process.versions.electron,
    daemons: { tor: '0.4.9.12', dnscrypt: '2.1.18', i2pd: '2.61.0' },
    systemDnsActive: false,
}));
ipcMain.handle('resolvers:list', () => ({ ok: false, error: 'демо' }));
ipcMain.handle('adapters:list', () => ({ ok: true, list: ['Беспроводная сеть'] }));
ipcMain.handle('querylog:get', () => ({ lines: [], total: 0 }));
ipcMain.handle('update:state', () => ({
    available: true, version: '1.3.1', downloading: false, percent: 0,
    readyToInstall: false, currentVersion: '1.3.0', autoUpdate: true, installSupported: true,
}));

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 820, height: 560, frame: false, show: true,
        backgroundColor: '#1e1e2f',
        webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
    });
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    setTimeout(async () => {
        const img = win.webContents.capturePage();
        require('fs').writeFileSync(OUT, (await img).toPNG());
        console.log('saved:', OUT);
        app.quit();
    }, WAIT);
});
