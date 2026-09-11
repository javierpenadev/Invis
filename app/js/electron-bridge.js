/*
 * UIBridge: обёртка над preload-мостом (window.nativeBridge из preload.js).
 * В обычном браузере (вне Electron) — no-op заглушки, чтобы верстать UI
 * без демонов. Прямого доступа к ipcRenderer у рендерера больше нет (SEC-1).
 */
(function () {
    const native = window.nativeBridge;

    window.UIBridge = native
        ? {
            available: true,
            /* one-way сообщение в main */
            send: (channel, data) => native.send(channel, data),
            /* запрос-ответ через ipcMain.handle */
            invoke: (channel, data) => native.invoke(channel, data),
            /* подписка на события из main; возвращает функцию отписки */
            on: (channel, callback) => native.on(channel, callback),
        }
        : {
            available: false,
            send: (channel, data) => console.info('[UIBridge] electron not detected, channel:', channel, data || ''),
            invoke: async (channel) => { console.info('[UIBridge] invoke unavailable:', channel); return null; },
            on: () => { /* вне Electron событий нет */ },
        };

    console.log(native
        ? '[UIBridge] Electron IPC доступен (preload)'
        : '[UIBridge] Electron не обнаружен — заглушки');
})();
