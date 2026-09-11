/*
 * Хранилище настроек Invis: JSON-файл.
 * Обычная установка — %APPDATA%/Invis/settings.json (app.getPath('userData')),
 * портативный режим (INVIS_PORTABLE=1) — settings.json рядом с exe.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { Settings, SettingsPatch } from './types';

export const DEFAULTS: Settings = {
    launchWithWindows: false,          // запускать вместе с Windows
    closeToTray: true,                 // при закрытии сворачивать в трей
    systemDns: false,                  // перехват системного DNS (порт 53, нужен админ)
    systemProxy: false,                // системный прокси -> Tor SOCKS5
    autoUpdate: true,                  // автоматически проверять обновления
    systemDnsAdapters: [],             // имена адаптеров; пусто = все физические
    windowBounds: { x: 0, y: 0, width: 0, height: 0, maximized: false }, // 0 = первый запуск
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
        bridgesText: '',               // строки мостов, по одной на строку.
                                       // Чувствительно (SEC-11): хранятся в
                                       // settings.json ОТКРЫТО — не выкладывай
                                       // settings.json и не синхронизируй его
        exitCountries: [],             // страны выхода (ISO-коды), пусто = любая
    },
};

let filePath: string | null = null;

/* Базовый каталог данных: userData или каталог exe в портативном режиме.
 * Портативность определяет либо INVIS_PORTABLE (вручную), либо
 * PORTABLE_EXECUTABLE_DIR — её задаёт electron-builder в portable-сборке. */
export function baseDir(): string {
    return app.isPackaged && (process.env.INVIS_PORTABLE || process.env.PORTABLE_EXECUTABLE_DIR)
        ? path.dirname(process.execPath)
        : app.getPath('userData');
}

function storeFile(): string {
    if (!filePath) filePath = path.join(baseDir(), 'settings.json');
    return filePath;
}

/* Внутри — структурный merge над unknown: рекурсия с отбрасыванием
 * неизвестных ключей и несовпадающих типов; снаружи — типобезопасно. */
function deepMergeImpl(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
    for (const [key, value] of Object.entries(patch)) {
        /* hasOwn, а не 'in': 'in' истинен и для __proto__/toString —
         * рекурсия ушла бы в прототип (SEC-10) */
        if (!Object.hasOwn(base, key)) continue;           // неизвестные ключи отбрасываем
        const cur = base[key];
        if (value && typeof value === 'object' && !Array.isArray(value)
                && cur && typeof cur === 'object' && !Array.isArray(cur)) {
            deepMergeImpl(cur as Record<string, unknown>, value as Record<string, unknown>); // объекты — глубоко
        } else if (typeof value === typeof cur) {          // скаляры — только при совпадении типов
            base[key] = value;
        }
    }
    return base;
}

export function deepMerge(base: Settings, patch: SettingsPatch): Settings {
    return deepMergeImpl(base as unknown as Record<string, unknown>,
        patch as Record<string, unknown>) as unknown as Settings;
}

/* Возвращает настройки, объединённые с дефолтами (неизвестные ключи игнорируются). */
export function load(): Settings {
    let parsed: SettingsPatch = {};
    try {
        parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    } catch (e) { /* нет файла / битый JSON — используем дефолты */ }
    return deepMerge(JSON.parse(JSON.stringify(DEFAULTS)) as Settings, parsed);
}

export function save(settings: Settings): void {
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
    /* Атомарная запись через tmp+rename: прямая перезапись могла ловить
     * блокировку (антивирус) и настройка «не сохранялась» */
    const tmp = storeFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(tmp, storeFile());
}
