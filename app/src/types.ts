/*
 * Схема настроек Invis — единственный источник истины для store.js DEFAULTS,
 * патчей settings:set и IPC-типов. Соответствует store.DEFAULTS 1:1.
 */

export interface AutostartSettings {
    dnscrypt: boolean;
    tor: boolean;
    i2p: boolean;
}

export interface DnscryptPresets {
    ads: boolean;
    malware: boolean;
}

export interface DnscryptSettings {
    autoMode: boolean;
    servers: string[];
    requireDnssec: boolean;
    requireNolog: boolean;
    requireNofilter: boolean;
    dnscryptProto: boolean;
    dohProto: boolean;
    cache: boolean;
    blockIpv6: boolean;
    forceTcp: boolean;
    lanAccess: boolean;
    bootstrap: string[];
    queryLog: boolean;
    blockBrowserDoh: boolean;
    presets: DnscryptPresets;
}

export interface TorSettings {
    newIpMinutes: number;
    useBridges: boolean;
    /** строки мостов; ЧУВСТВИТЕЛЬНО — хранятся в settings.json открыто (SEC-11) */
    bridgesText: string;
    exitCountries: string[];
}

export interface Settings {
    launchWithWindows: boolean;
    closeToTray: boolean;
    systemDns: boolean;
    systemProxy: boolean;
    autoUpdate: boolean;
    systemDnsAdapters: string[];
    autostart: AutostartSettings;
    dnscrypt: DnscryptSettings;
    tor: TorSettings;
    windowBounds: WindowBounds;
}

/* Частичный патч произвольной глубины (как его шлёт рендерер в settings:set).
 * Массивы заменяются целиком, объекты мерджатся глубоко — как deepMerge. */
export type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends readonly (infer U)[]
        ? T[K]
        : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type SettingsPatch = DeepPartial<Settings>;

/* Имена модулей-демонов (ключи супервизора) */
export type DaemonName = 'tor' | 'dnscrypt' | 'i2p';

/* Последняя геометрия окна (width/height 0 = ещё не сохранялось — первый запуск) */
export interface WindowBounds {
    x: number;
    y: number;
    width: number;
    height: number;
    maximized: boolean;
}
