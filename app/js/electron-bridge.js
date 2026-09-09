/*
 * Мост к Electron (nodeIntegration включён в шаблоне).
 * В обычном браузере вызовы просто логируются / резолвятся в null.
 */
(function () {
    let ipc = null;
    try {
        if (typeof require !== 'undefined' && typeof process !== 'undefined' && process.versions && process.versions.electron) {
            ipc = require('electron').ipcRenderer;
        }
    } catch (e) { /* браузер — мост не нужен */ }

    window.UIBridge = {
        get available() { return Boolean(ipc); },
        /* one-way сообщение в main */
        send: (channel, data) => {
            if (ipc) ipc.send(channel, data);
            else console.info('[UIBridge] electron not detected, channel:', channel, data || '');
        },
        /* запрос-ответ через ipcMain.handle */
        invoke: async (channel, data) => {
            if (!ipc) { console.info('[UIBridge] invoke unavailable:', channel); return null; }
            return ipc.invoke(channel, data);
        },
        /* подписка на события из main */
        on: (channel, callback) => {
            if (!ipc) return;
            ipc.on(channel, (_e, data) => callback(data));
        },
    };
})();
