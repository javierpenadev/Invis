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
    autoUpdate: true,
    autostart: { dnscrypt: true, tor: true, i2p: false },
    dnscrypt: {
        autoMode: true, servers: [], requireDnssec: false, requireNolog: true,
        requireNofilter: true, dnscryptProto: true, dohProto: true, cache: true,
        blockIpv6: false, forceTcp: false, lanAccess: false,
        bootstrap: ['9.9.9.9:53', '8.8.8.8:53'], queryLog: false,
        blockBrowserDoh: true, presets: { ads: false, malware: false },
    },
    tor: { newIpMinutes: 0, useBridges: false, bridgesText: '', exitCountries: [] },
}));
ipcMain.handle('modules:status', () => ({
    dnscrypt: { state: 'on', status: 'работает (:53)' },
    tor: { state: 'busy', status: '45%' },
    i2p: { state: 'error', status: 'порт не открылся' },
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
let winRef = null;
ipcMain.handle('diag:run', async () => {
    const res = {
        dns: { ok: true, detail: 'ответ: 3 запис(ей) · порт 53' },
        tor: { ok: false, detail: 'проверяю…' },
        i2p: { ok: true, detail: 'прокси 4444' },
        realIp: { ok: false, detail: 'проверяю…' },
        torIp: { ok: false, detail: 'проверяю…' },
    };
    setTimeout(() => {
        winRef?.webContents.send('diag:result', {
            ...res,
            tor: { ok: true, detail: 'цепочка установлена' },
            realIp: { ok: true, detail: '93.170.44.76' },
            torIp: { ok: true, detail: '185.220.101.57 (выход Tor)' },
        });
    }, 2200);
    return res;
});
ipcMain.handle('update:state', () => ({
    available: true, version: '1.3.1', downloading: false, percent: 0,
    readyToInstall: false, currentVersion: '1.3.0', autoUpdate: true, installSupported: true,
}));
/* Каналы, которые рендерер дёргает сразу при загрузке окна */
ipcMain.handle('net:speed', () => 42.5);
ipcMain.handle('tor:exitinfo', () => ({
    ok: true, cc: 'DE', city: 'Frankfurt am Main', country: 'Германия',
    ip: '185.220.101.57', pingMs: 3300,
}));
ipcMain.handle('tor:countries', () => ({
    ok: true, fresh: true, ts: Date.now(),
    countries: {
        US: { count: 210, mbps: 1500 }, DE: { count: 120, mbps: 950 },
        NL: { count: 85, mbps: 720 }, SE: { count: 60, mbps: 500 },
        CH: { count: 48, mbps: 430 }, FI: { count: 35, mbps: 380 },
        FR: { count: 40, mbps: 350 }, GB: { count: 30, mbps: 300 },
    },
}));

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 820, height: 560, frame: false, show: true,
        backgroundColor: '#1e1e2f',
        /* та же модель изоляции, что и в приложении (SEC-1): UI через preload-мост */
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    win.webContents.executeJavaScript("document.querySelector('#diagBtn').click()").catch(() => {});
    setTimeout(async () => {
        const img = win.webContents.capturePage();
        require('fs').writeFileSync(OUT, (await img).toPNG());
        console.log('saved:', OUT);
        app.quit();
    }, WAIT);
});
