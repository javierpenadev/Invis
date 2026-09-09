# Т/З: Порт InviZible Pro (Android) на Windows (Electron)

Версия документа: 1.0 · Дата: 2026-09-09
Исходный артефакт: `apk/Invizible_Pro__beta_ver.2.7.3.apk`
База UI: каркас `app/` (Electron, frameless-окно, тёмная тема)
Результат разбора APK: распакованная копия в `apk_extracted/` (служебная, в порт не входит)

---

## 1. Общие сведения

### 1.1. Что за приложение

**InviZible Pro** (package `pan.alexander.tordnscrypt`, versionName 2.7.3, versionCode 2273,
minSdk 21 / targetSdk 36) — комплекс анонимизации и шифрования трафика для Android,
объединяющий три модуля под одним UI:

| Модуль | Демон | Назначение |
|---|---|---|
| Tor | `libtor.so` (Tor 0.4.9.11-dev) | Анонимизация TCP через луковую маршрутизацию; SOCKS 9050, Trans 9040, DNS 5400, Control 9051 |
| DNSCrypt | `libdnscrypt-proxy.so` (2.1.x) | Шифрование/фильтрация DNS: DNSCrypt, DoH, DoH3, ODoH; локальный порт 53/9053 |
| Purple I2P | `libi2pd.so` (i2pd 2.x) | Доступ к сети I2P (eepsites, outproxies); HTTP 4444, HTTPS 4447, консоль 7070 |

Плюс подключаемые транспорты Tor для обхода блокировок: **obfs4proxy**, **snowflake**
(варианты amazon / amp / cdn77 / свой STUN), **conjure** (Go-бинарники, go 1.24–1.25).

Приложение с открытым кодом (GPLv3, репозиторий Gedsh/InviZible), код Java/Kotlin
обфусцирован R8, но архитектура восстанавливается по манифесту, нативным библиотекам
и строкам. Мы **не копируем исходники**, а повторяем функциональное ядро на другой платформе.

### 1.2. Цель порта

Настольное приложение для Windows 10/11 x64 на Electron, дающее те же ключевые
возможности: запуск/остановка Tor + DNSCrypt + I2Pd с генерацией их конфигов из UI,
шифрование DNS системы, анонимизация приложений через прокси/Tor, обход блокировок
(мосты), правила фильтрации DNS, мониторинг логов и статусов, tray-управление.

### 1.3. Лицензии

Порт наследует GPL-3.0 (совместимость обязана быть сохранена). В экране «О программе»
перечислить лицензии: Tor (BSD-3-clause), dnscrypt-proxy (ISC), i2pd (BSD-3), obfs4proxy (GPLv3),
snowflake/conjure (Tor Project / GPLv3-совместимые), Electron (MIT). При дистрибуции —
предложить исходники/ссылки (п. 8.4).

---

## 2. Как устроено Android-приложение (результаты разбора)

### 2.1. Компоненты (из AndroidManifest)

- `MainActivity` — главный экран (TopFragment): кнопки Start/Stop каждого модуля, текущий IP, статистика.
- `ModulesService` — foreground-сервис: запускает демонов (exec нативных бинарников из `lib/`),
  читает их stdout в логи, рассылает broadcast'ы статуса, держит уведомление.
- `ServiceVPN` — режим **VPN**: локальный TUN-интерфейс 10.191.0.x (шлюз .0.1, DNS .0.2),
  перехват всего трафика устройства. JNI (`libinvizible.so`) разбирает пакеты TUN:
  классы `Packet`, `ResourceRecord`, `Allowed`, `Forward`, `Usage` (подсчёт трафика по приложениям).
- `RootExecService` — режим **Root**: применение iptables-правил через `su`:
  цепочки `tordnscrypt*` в filter/nat; DNAT udp/tcp:53 → 127.0.0.1:<DNSCrypt/Tor>,
  TCP → 9040 (Tor TransPort); owner-match по UID для per-app правил; поддержка
  тетеринга и multi-user; определение busybox/iptables.
- `UpdateService` — проверка обновлений приложения (GitHub releases), скачивание APK.
- `AppExitDetectService` — детект аварийного завершения.
- `BootCompleteReceiver` — автозапуск модулей (с задержкой, `pref_fast_autostart_delay`).
- Quick Settings tiles: Tor / DNSCrypt / Purple I2P / «Сменить IP Tor» (NEWNYM через ControlPort).

### 2.2. Карта настроек (из ресурсов, ключи `pref_*`)

- **Common/Root**: запуск модулей с root; kill switch (блокировать интернет при падении модулей);
  block HTTP (80); prevent DNS leak; fix TTL (root/VPN); ARP-spoof защита («block internet»);
  режим совместимости; wait iptables; multi-user; wakelock; ручной прокси для модулей
  (SOCKS/HTTP, `socks5://127.0.0.1:1080` виден в dex); SHELL_SCRIPT_CONTROL broadcast;
  логирование root-команд; темы, язык, автозапуск, задержка автозапуска.
- **Tor**: use bridges (obfs4 / snowflake×3 / свои bridges, IPv6, парсер bridges.torproject.org);
  route all through Tor / route только избранное; excludes от Tor; bypass LAN; узлы
  (Entry/Exit/Exclude/StrictNodes); изоляция потоков (dest/порт/uid); TransPort; VirtualAddrNetwork;
  TrackHostExits; dormant client timeout; padding; HTTP-tunnel proxy; редактор torrc.
- **DNSCrypt**: выбор серверов (DNSCrypt/DoH/ODoH/DNSSEC, IPv4/IPv6, non-logging/no-filter,
  локальный порт, refresh delay); источники списков (public-resolvers/relays/ODoH-servers,
  minisign, remote+static); правила: blacklist / whitelist / IP-blacklist / forwarding / cloaking
  (+ «remote» обновляемые списки с задержкой); force TCP; HTTP/3; block IPv6; block unqualified /
  undelegated; DNS64 + prefix; ignored qtypes; fallback resolver; query log / NX log;
  редактор dnscrypt-proxy.toml.
- **I2P**: интерфейс/порт, bandwidth (вх/исх), share, floodfill, NTCP2/SSU2 (+прокси),
  IPv4/IPv6, transit tunnels, coresize/openfiles, reseeding, addressbook (hosts.txt),
  HTTP outproxy, редакторы i2pd.conf и tunnels.conf.
- **Firewall**: per-app белый/чёрный список приложений (в VPN-режиме — allowlist TUN;
  в root — iptables по UID), уведомления об обращениях новых приложений.

### 2.3. Ключевые константы

| Параметр | Значение |
|---|---|
| Tor SOCKS / Control / Trans / DNS | 9050 / 9051 / 9040 / 5400 |
| DNSCrypt listen | 127.0.0.1:53 (перехват) / 9053 (как сервис) |
| i2pd HTTP / HTTPS / консоль | 4444 / 4447 / 7070 |
| VPN-подсеть Android | 10.191.0.0/16 (шлюз .0.1, DNS .0.2) |
| HOTSPOT-режим | прокси 10.1.10.1 |
| Звуки готовности модулей | assets/*.mp3 (tor, dnscrypt, itpd, busyb) |

### 2.4. Данные

Настройки — SharedPreferences (`pref_*`); DNS-правила и кэш списков — Room (SQLite);
рабочие списки резолверов — скачиваются самим dnscrypt-proxy по `sources` с проверкой minisign;
бэкап/восстановление настроек — отдельный экран (`BackupActivity`, zip+пароль).

---

## 3. Целевая платформа: что меняется на Windows

### 3.1. Таблица соответствия

| Android | Windows (наш порт) | Комментарий |
|---|---|---|
| `ModulesService` (foreground) | `DaemonSupervisor` в main-процессе Electron: `spawn` exe-шников, парсинг stdout | Бинарники — официальные сборки в `resources/bin` |
| VpnService + TUN (JNI) | **Этап 1: прокси-режим**; **Этап 2 (R&D): wintun.dll + WinDivert** | См. 3.2 |
| iptables (root) | `netsh advfirewall` (kill switch), смена DNS адаптера (`netsh interface ip set dns`), маршруты (`route add`) | Права администратора |
| Per-app firewall по UID | v1 — **нет** (принципиальное отличие ОС); v2 — только в TUN-режиме по PID соединений (WinDivert) | Честно фиксируем в ограничениях |
| TileService | Tray-иконка + контекстное меню (старт/стоп модулей, «Сменить IP») | |
| BootCompleteReceiver | Автозапуск: реестр `HKCU\...\Run` или Task Scheduler | |
| WorkManager (workers списков) | Планировщик внутри main (интервал refresh_delay) | |
| SharedPreferences | JSON-файл настроек в `app.getPath('userData')` | zod-валидация схемы |
| Room (правила) | Текстовые файлы правил + JSON-индекс (dnscrypt сам читает файлы) | SQLite не нужен |
| Уведомления+звуки mp3 | Нативные уведомления Windows + `Sound.play` из assets | |
| GitHub UpdateService | electron-updater / проверка GitHub API | |
| HelpActivity/AboutActivity | Экраны справки/о программе | |
| BackupActivity | Экспорт/импорт zip настроек | |

### 3.2. Сетевые режимы (ключевое архитектурное решение)

Android-версия перехватывает весь трафик (VPN/root). На Windows честных эквивалентов три уровня:

**Режим P1 — «Прокси» (v1, обязателен):**
- Tor SOCKS5 `127.0.0.1:9050`, I2P HTTP(S) `127.0.0.1:4444/4447`.
- Опция «системный прокси»: прописать HTTP/HTTPS-прокси Windows (WinINET) на локальный
  прокси-агент (или напрямую, где поддерживается), исключения по подсетям (bypass LAN).
- DNS системы: смена DNS адаптеров на `127.0.0.1` (dnscrypt) при наличии прав администратора;
  автоматическое восстановление прежних значений при выходе/падении (аналог prevent DNS leak).
- Приложения, умеющие SOCKS (браузеры, мессенджеры), настраиваются вручную — как на десктопе
  исторически принято.

**Режим P2 — «Перехват DNS + kill switch» (v1.5):**
- dnscrypt на :53 системно (админ), блокировка DoH/DoT обхода через `netsh advfirewall`
  (правило блокировки известных DoH-адресов — опционально).
- Kill switch: firewall-правило «запретить весь исходящий, кроме доверенных exe» включается
  при падении модулей и выключается при их работе (`netsh advfirewall firewall ...`).

**Режим P3 — «TUN» (v2, R&D, отдельно оценивается):**
- `wintun.dll` (пользовательский TUN от WireGuard) + перехват/редирект TCP→SOCKS
  через WinDivert (или готовый редиректор, напр. tun2socks). Даёт «маршрутизировать всё
  через Tor» как на Android. Риски: драйверы, антивирусы, стабильность — выделить в отдельный
  spike перед обязательством.

Права администратора: установщик ставит пер-юзер; для P1-«смена DNS»/P2/P3 приложение
запрашивает elevation (запуск от админа или отдельный helper-процесс `runas`).

---

## 4. Архитектура Windows-приложения

```
Electron main (Node)                                Renderer (app/)
├─ DaemonSupervisor ─ spawn: tor.exe,               ├─ Dashboard: статусы/кнопки модулей
│   dnscrypt-proxy.exe, i2pd.exe (+ obfs4proxy,      ├─ Logs: 3 канала stdout (фильтр, экспорт)
│   snowflake-client, conjure-client при мостах)     ├─ Settings: Tor / DNSCrypt / I2Pd / Common
│   рестарт, backoff, «зомби»-очистка при выходе     ├─ DNS Rules: списки, редакторы правил
├─ ConfigService ─ генерация torrc /                 ├─ Help / About / Backup
│   dnscrypt-proxy.toml / i2pd.conf+tunnels.conf     └─ (v2) Firewall / TUN
│   из prefs (шаблоны + подстановка)
├─ StoreService ─ JSON-настройки в userData
├─ NetModeService ─ системный прокси, DNS адаптера, kill switch, маршруты (P1–P2)
├─ RulesService ─ файлы blacklist/whitelist/cloaking/forwarding, remote sources
├─ UpdateService ─ проверка релизов (GitHub)
├─ TrayService ─ иконка, меню, уведомления, звуки
├─ IpcApi ─ конечный набор каналов ipcMain.handle/on
└─ LogService ─ кольцевые буферы логов, экспорт
```

Принципы:
- **Один демон = один child process**, lifetime под контролем `DaemonSupervisor`; при закрытии
  приложения — корректный `taskkill /T` по pid-дереву (защита от «висящих» tor.exe).
- **Рендерер не имеет прямого доступа к системе** — только через фиксированный IpcApi.
- **Конфиги генерируются**, а не редактируются как попало: «продвинутый» редактор сырого
  конфига (как в Android) доступен, но изменения валидируются и сохраняются в prefs.
- Пути: все бинарники/данные — без запуска через shell (`shell: false`), аргументы массивом.
- Портабельность: режим portable (данные рядом с exe) и обычная установка (userData) —
  как в шаблоне builder-конфиг (nsis + portable).

### 4.1. Компоненты для бандлинга (официальные Windows-сборки)

| Компонент | Артефакт | Источник (официальный) |
|---|---|---|
| Tor | `tor.exe` Expert Bundle (Windows Expert Bundle) | torproject.org |
| obfs4proxy | `obfs4proxy.exe` | релизы Tor Project / сборка из исходников |
| snowflake | `snowflake-client.exe` | релизы Tor Project |
| conjure | `conjure-client.exe` | релизы Tor Project |
| DNSCrypt | `dnscrypt-proxy.exe` (+ .toml, списки) | github.com/DNSCrypt/dnscrypt-proxy/releases |
| i2pd | `i2pd.exe` | github.com/PurpleI2P/i2pd/releases |

Расположение в пакете: `resources/bin/{tor,dnscrypt,i2pd}/…` (electron-builder `extraResources`).
Версии зафиксировать в About; обновление бинарей — ручное (в рамках v1).

---

## 5. Экраны UI (по шаблону)

Область A/B контрол-бара шаблона = «Dashboard» / «Логи». Левая панель — параметры выбранного
модуля. Кнопка действия = Start/Stop выбранных модулей (или «Все»).

1. **Dashboard**: карточки Tor/DNSCrypt/I2Pd: состояние (stopped/starting/bootstrap %/ready/error),
   внешние IP (Tor-IP и прямой), uptime, счётчики трафика (v2). Кнопки: ▶/⏹ каждый, ⏹ все, «Сменить IP» (NEWNYM).
2. **Логи**: три вкладки каналов + общий; фильтр по подстроке, пауза, экспорт в файл;
   цветовые классы (log-info/warn/error из шаблона).
3. **Настройки → Tor**: эквивалент `pref_tor_*` (мосты: тип/подробности/свои; узлы; изоляция;
   транспорт; редактор torrc «продвинутый»).
4. **Настройки → DNSCrypt**: эквивалент `pref_dnscrypt_*` (серверы по категориям, источники,
   фильтры/правила, кэш, force_tcp, HTTP/3, логи запросов; редактор toml).
5. **Настройки → I2Pd**: эквивалент `pref_itpd_*` (лимиты, транспорт, reseed, outproxy, tunnels).
6. **Настройки → Общие**: язык, тема, автозапуск (с задержкой), системный прокси вкл/выкл,
   режим DNS (off / dnscrypt), kill switch, запуск от админа, лог root/netsh-команд, звук.
7. **DNS-правила**: списки источников (remote: public-resolvers/relays/odoh-servers; refresh),
   редакторы blacklist/whitelist/ip-blacklist/forwarding/cloaking (по одному правилу в строке,
   как в Android).
8. **Help / About / Backup**: справка (что/how-to), лицензии и версии, экспорт/импорт настроек.

Термины и статусы синхронизированы с Android-версией (bootstrap-проценты Tor и т.п.).

---

## 6. Нефункциональные требования

- **ОС**: Windows 10 1809+ / 11, x64. Языки UI: ru, en (каркас i18n).
- **Стек**: Electron 44 (как в шаблоне), electron-builder 26, Node 20+. Без тяжёлых зависимостей
  в v1 (нативные модули — по необходимости и только с пересборкой под Electron ABI).
- **Надёжность**: демоны переживают рестарт UI; «хвосты» процессов чистятся; обрыв сети —
  backoff-рестарт; падение модуля при kill switch — firewall остаётся активным до явного «стоп».
- **Безопасность**: конфиги с паролями (ControlPort hash) — в userData с ограничением прав;
  пароль ControlPort генерируется автоматически; никаких `eval`/remote-контента (CSP уже в шаблоне).
- **Производительность**: старт модулей не блокирует UI; логи — кольцевой буфер (N строк),
  порционная отрисовка.
- **Упаковка**: NSIS (пер-юзер) + portable, как в шаблоне; иконка/продуктовое имя — новые
  (не InviZible, чтобы не нарушать товарный знак; рабочее имя проекта — решить до фазы сборки).
- **Телеметрия**: отсутствует (как в оригинале). Краш-репорты — только ручной экспорт.

## 7. Ограничения v1 (честные отличия от Android)

1. Нет per-app firewall по всем приложениям ОС (в Windows невозможно без драйвера; в TUN-режиме v2 — частично).
2. Нет «fix TTL» (актуально только для мобильных операторов), ARP-защиты и тетеринга.
3. Прокси-режим (P1) не перехватывает произвольные приложения — только системный прокси/ручная настройка.
4. Нет VPN-статистики по приложениям (в P1 нечего считать); в TUN — на этапе v2.
5. I2P-доступ — через прокси 4444/4447 (как и в Android) + опционально системный прокси.

## 8. Риски и их обработка

| Риск | Обработка |
|---|---|
| Антивирусы ругаются на WinDivert/TUN, spawn бинарников | В v1 не использовать WinDivert; для spawn — только официальные подписанные сборки; README с рекомендациями исключений |
| Порт 53 занят (ICS/сторонние) | Проверка занятости перед включением DNS-режима, понятная ошибка, запасной порт 9053 |
| Падение/зависание демона | DaemonSupervisor: backoff-рестарт, обнаружение «зомби»-процессов по pid-файлам |
| Tor-блокировки | Мосты (obfs4/snowflake/conjure) — как в оригинале; актуализация списков мостов |
| UAC/права | Все привилегированные операции — одной кнопкой с понятным explain-диалогом; single instance |
| Товарный знак/лицензия | Собственное имя продукта; GPL-3.0; ссылки на исходники сторонних бинарников в About |

## 9. Порядок работ

Поэтапный план с DoD и оценками — в файле `тасклист-порт-Windows.md`.
Нумерация фаз там соответствует порядку внедрения; фазы 1–4 дают работающий MVP
(модули + настройки + логи + DNS-режим), фазы 5–7 — паритет с Android-версией,
фаза 8 — R&D TUN-режима, фаза 9 — релизная упаковка.
