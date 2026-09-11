/*
 * Preload — единственный мост рендерер ↔ main (SEC-1).
 * Рендерер работает с contextIsolation+sandbox и получает window.nativeBridge
 * с ЯВНЫМ allowlist каналов: что не разрешено здесь, для UI не существует.
 * Неизвестные каналы (удалённые, будущие, подсовутые инъекцией) отклоняются
 * до ipcRenderer.
 */
const { contextBridge, ipcRenderer } = require('electron');

/* one-way сообщения рендерер → main (ipcMain.on) */
const SEND = new Set([
    // тайтлбар
    'window-minimize', 'window-maximize', 'window-devtools', 'window-close',
    // модули
    'modules:start-all', 'modules:stop-all', 'modules:toggle',
    // лог запросов, Tor, ярлыки
    'querylog:clear', 'tor:newip', 'proxy:copy',
    'open:console-i2p', 'open:logs', 'open:github',
    // обновление
    'update:check', 'update:install',
]);

/* запрос-ответ (ipcMain.handle) */
const INVOKE = new Set([
    'app:info', 'settings:get', 'settings:set',
    'modules:status',
    'resolvers:list', 'querylog:get', 'adapters:list',
    'diag:run',
    'bridges:fetch', 'tor:countries', 'tor:exitinfo', 'tor:speedtest', 'net:speed',
    'update:state',
]);

/* подписки на события main → рендерер (webContents.send) */
const ON = new Set([
    'modules:state', 'modules:event', 'settings:changed',
    'diag:result',
    'update:available', 'update:progress', 'update:downloaded',
]);

contextBridge.exposeInMainWorld('nativeBridge', {
    send: (channel, payload) => {
        if (!SEND.has(channel)) throw new Error(`UIBridge.send: канал «${channel}» не разрешён`);
        ipcRenderer.send(channel, payload);
    },
    invoke: (channel, payload) => {
        if (!INVOKE.has(channel)) {
            return Promise.reject(new Error(`UIBridge.invoke: канал «${channel}» не разрешён`));
        }
        return ipcRenderer.invoke(channel, payload);
    },
    on: (channel, callback) => {
        if (!ON.has(channel)) throw new Error(`UIBridge.on: канал «${channel}» не разрешён`);
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
    },
});
