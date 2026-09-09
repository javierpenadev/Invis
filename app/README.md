# Invis — Electron-каркас tray-приложения

Каркас клона InviZible Pro для Windows: маленькое окно + постоянная иконка в трее.
Логика демонов (Tor / DNSCrypt / I2Pd) подключается позже — по `../ТЗ-порт-Windows.md`
и `../тасклист-порт-Windows.md`, кнопки и IPC-каналы-заглушки уже на месте.

## Запуск

```bash
npm install
npm run fetch-bins   # один раз: скачать tor/dnscrypt-proxy/i2pd в bin\ (~30 МБ)
npm start
```

Сборка: `npm run dist` (NSIS) / `npm run dist:portable` (bin\ кладётся в resources).
Смоук-тест GUI без демонов: `APP_SMOKE=5000 INVIS_NO_AUTOSTART=1 npm start`.
Headless-проверка демонов (без GUI): `npm run check`.

## Модули работают

`lib/daemons.js` (DaemonSupervisor) запускает официальные бинарники с конфигами,
которые генерирует `lib/configs.js` в `%APPDATA%/Invis/configs`:

| Модуль | Бинарник (bin\) | Готовность | Порты |
|---|---|---|---|
| Tor | `tor\tor\tor.exe` (0.4.9.12, Expert Bundle 15.0.22) | по `Bootstrapped 100%` | SOCKS 9050, Control 9051, DNS 5400 |
| DNSCrypt | `dnscrypt\win64\dnscrypt-proxy.exe` (2.1.18) | проба порта + лог | DNS 127.0.0.1:9053 |
| I2P | `i2pd\i2pd.exe` (2.61.0) | проба порта | HTTP 4444, SOCKS 4447, консоль 7070 |

Состояния: `off → busy → on / error`; логи сессии — `%APPDATA%/Invis/logs/*.log`.
При выходе из приложения всё дерево процессов гасится (taskkill /T).
В комплекте Tor уже есть транспорты lyrebird (obfs4) и conjure — для будущей поддержки мостов.

## Поведение tray-приложения

- Один экземпляр приложения (второй запуск открывает окно первого).
- Закрытие окна (крестик) сворачивает в трей; при первом сворачивании — подсказка-балун.
  Настраивается галкой «При закрытии сворачивать в трей» (выкл = закрытие завершает приложение).
- Клик по иконке трея — показать/спрятать окно; в меню трея: открыть, «Запустить/Остановить всё»
  (заглушки), галка «Запускать с Windows», выход.
- «Запускать с Windows» — `app.setLoginItemSettings` (per-user, работает и в dev, и в сборке).

## Настройки

Хранятся в JSON: `%APPDATA%/Invis/settings.json` (или рядом с exe при `INVIS_PORTABLE=1`).
Дефолты — в `store.js` (`DEFAULTS`). Изменяются из UI и из меню трея, обе точки идут через
`setSetting()` в `main.js` (единое применение side-эффектов + рассылка `settings:changed` в UI).

```json
{
  "launchWithWindows": false,
  "closeToTray": true,
  "systemDns": false,
  "systemDnsAdapters": [],
  "autostart": { "dnscrypt": true, "tor": true, "i2p": false },
  "dnscrypt": {
    "autoMode": true, "servers": [],
    "requireDnssec": false, "requireNolog": true, "requireNofilter": true,
    "dnscryptProto": true, "dohProto": true,
    "cache": true, "blockIpv6": false, "forceTcp": false, "lanAccess": false,
    "bootstrap": ["9.9.9.9:53", "8.8.8.8:53"],
    "queryLog": false
  }
}

`systemDns: true` — перехват системного DNS: адаптеры переводятся на 127.0.0.1,
dnscrypt слушает порт 53 вместо 9053 (нужен запуск от администратора — Invis
предложит перезапуск через UAC). Прежние DNS сохраняются в `dns-backup.json`
и восстанавливаются при выходе; если сеанс упал — восстановление предлагается
при следующем старте. Порт 53 занят другим сервисом (например, сторонним
dnscrypt) — включение блокируется с понятной ошибкой. Журнал переключений:
`logs/netmode.log`. Выбор адаптеров — `systemDnsAdapters` (пусто = все физические).

Раздел «DNS-резольверы» в UI: авто-режим (самые быстрые) или ручной выбор из
списка (парсится из кэша `public-resolvers.md`, который обновляет сам dnscrypt);
фильтры DNSSEC/NOLOG/NOFILTER/протоколы; DNS-кэш, блокирование IPv6, принудительный
TCP, доступ из LAN (с firewall-правилом), резервные bootstrap-резольверы, лог
запросов с просмотрщиком.

v1.2.0: **мосты Tor** (obfs4/conjure, запрос строк с bridges.torproject.org),
**кнопка «Сменить IP» + автосмена по таймеру** (NEWNYM через ControlPort),
**анти-утечка браузерного DoH** (canary use-application-dns.net),
**пресеты блок-листов** (реклама/трекеры, фишинг/малварь),
**диагностика в один клик** (DNS/Tor/I2P), кнопки консоли I2P и папки логов.
```

## Структура

```
main.js               Electron main: окно (820×560), трей, close-to-tray, single instance,
                      генерация конфигов + запуск DaemonSupervisor, IPC
store.js              JSON-хранилище настроек (load/save/deepMerge, дефолты)
lib/configs.js        генераторы torrc / dnscrypt-proxy.toml / i2pd.conf (+ порты)
lib/daemons.js        супервизор демонов: spawn/stop/готовность/статусы/логи
tools/fetch-bins.js   скачивание официальных сборок демонов в bin\ (версии зафиксированы)
tools/dev-check.js    headless-проверка цикла демонов без GUI
index.html            каркас: titlebar + скроллящийся .content (модули, настройки)
                      + фиксированная .control-bar
style.css             базовая тема: сетка, тайтлбар, контрол-бар, прелоадер, курсор
app.css               виджеты: строки модулей, чипы, настройки, прогресс, лог-консоль
js/app.js             UI-логика: настройки↔форма, живые статусы модулей, кнопки
js/electron-bridge.js UIBridge.send / invoke / on — мост к main
js/cursor-fx.js       кастомный курсор (data-cursor-text на кнопках)
js/utils.js           StringUtils / DateUtils / UIHelpers
assets/img/           icon.ico (окно+трей), icon.svg, logo.svg
bin/                  бинарники демонов (не в git, ставится npm run fetch-bins)
```

## Точки расширения

- **Статусы из main** — `sendToRenderer('modules:state', { name, state, status })`;
  в UI есть `InvisUI.setStatus(text, { progress, error })` и
  `InvisUI.setModuleState(name, 'off'|'busy'|'on'|'error', 'текст')`.
- **Новые настройки** — добавить ключ в `DEFAULTS` (`store.js`), чекбокс в `index.html`
  и маппинг в `SETTINGS_IDS` (`js/app.js`) — применение и сохранение подхватятся сами.
- **Конфиги модулей** — правки в `lib/configs.js`; файлы перегенерируются при каждом старте.
- Следующие шаги по плану: системный DNS (смена адаптеров, админ), kill switch,
  мосты Tor (lyreberry/conjure уже в bin), экран логов, упаковка (`ТЗ-порт-Windows.md`).
