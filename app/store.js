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
    systemDns: false,                  // перехват системного DNS (порт 53, нужен админ)
    systemProxy: false,                // системный прокси -> Tor SOCKS5
    autoUpdate: true,                  // автоматически проверять обновления
    systemDnsAdapters: [],             // имена адаптеров; пусто = все физические
    autostart: {                       // автозапуск модулей при старте Invis
        dnscrypt: true,
        tor: true,
        i2p: false,
    },
    dnscrypt: {                        // параметры dnscrypt-proxy (gen. toml)
        autoMode: true,                // авто-выбор самых быстрых резольверов
        servers: [],                   // ручной выбор: имена резольверов
        requireDnssec: false,          // только серверы с DNSSEC
        requireNolog: true,            // только без логов
        requireNofilter: true,         // только без фильтрации
        dnscryptProto: true,           // разрешить протокол DNSCrypt
        dohProto: true,                // разрешить DoH
        cache: true,                   // DNS-кэш
        blockIpv6: false,              // пустой ответ на AAAA-запросы
        forceTcp: false,               // исходящие только по TCP
        lanAccess: false,              // слушать 0.0.0.0 (доступ из LAN) вместо 127.0.0.1
        bootstrap: ['9.9.9.9:53', '8.8.8.8:53'], // незашифрованные резольверы для bootstrap
        queryLog: false,               // писать лог запросов (query.log)
        blockBrowserDoh: true,         // canary use-application-dns.net (анти-утечка)
        presets: { ads: false, malware: false }, // блок-листы
    },
    tor: {                             // параметры Tor
        newIpMinutes: 0,               // авто-смена IP (NEWNYM), 0 = выкл
        useBridges: false,             // использовать мосты (обход блокировок)
        bridgesText: '',               // строки мостов, по одной на строку
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
        if (!(key in base)) continue;                      // неизвестные ключи отбрасываем
        if (value && typeof value === 'object' && !Array.isArray(value)
                && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
            deepMerge(base[key], value);                   // объекты — глубоко
        } else if (typeof value === typeof base[key]) {    // скаляры — только при совпадении типов
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
