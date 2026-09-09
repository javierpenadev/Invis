/*
 * Хранилище настроек Invis: JSON-файл.
 * Обычная установка — %APPDATA%/Invis/settings.json (app.getPath('userData')),
 * портативный режим (INVIS_PORTABLE=1) — settings.json рядом с exe.
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
    launchWithWindows: false,          // запускать вместе с Windows
    closeToTray: true,                 // при закрытии сворачивать в трей
    autostart: {                       // автозапуск модулей при старте Invis
        dnscrypt: true,
        tor: true,
        i2p: false,
    },
};

let filePath = null;

/* Базовый каталог данных: userData или каталог exe в портативном режиме */
function baseDir() {
    return app.isPackaged && process.env.INVIS_PORTABLE
        ? path.dirname(process.execPath)
        : app.getPath('userData');
}

function storeFile() {
    if (!filePath) filePath = path.join(baseDir(), 'settings.json');
    return filePath;
}

function deepMerge(base, patch) {
    for (const [key, value] of Object.entries(patch || {})) {
        if (value && typeof value === 'object' && !Array.isArray(value)
                && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
            deepMerge(base[key], value);
        } else if (key in base) {
            base[key] = value;
        }
    }
    return base;
}

/* Возвращает настройки, объединённые с дефолтами (неизвестные ключи игнорируются). */
function load() {
    let parsed = {};
    try {
        parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    } catch (e) { /* нет файла / битый JSON — используем дефолты */ }
    return deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), parsed);
}

function save(settings) {
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
    fs.writeFileSync(storeFile(), JSON.stringify(settings, null, 2), 'utf8');
}

module.exports = { DEFAULTS, load, save, deepMerge, baseDir, getPath: storeFile };
