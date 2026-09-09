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
    autostart: { dnscrypt: true, tor: true, i2p: false },
}));
ipcMain.handle('modules:status', () => ({
    dnscrypt: { state: 'on', status: 'работает' },
    tor: { state: 'busy', status: '45%' },
    i2p: { state: 'off', status: 'остановлен' },
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
