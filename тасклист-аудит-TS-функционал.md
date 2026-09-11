# Таск-лист: аудит безопасности, баги, чистка функционала, миграция на TypeScript

Дата аудита: 2026-09-11 · База: v1.9.4 (HEAD `67868b5`, ветка `main`, чистое дерево)
Объём: ~4200 LOC JS, 25 файлов (main 1115, renderer 930+271+66, lib 14 модулей, 5 tools), 0 runtime-зависимостей, Electron 44, CJS.

> **Прогресс v1.9.5 (11.09.2026, не released):** выполнены SEC-1..SEC-4 (вариант Б), BUG-1..BUG-13 и P2 «комментарий-сирота»; частично SEC-8 (dns-restore и update-скрипты уже в mkdtemp, остался proxy-refresh). Решение по обновлятору: вариант Б. Новое правило релиза: к артефактам прикладывать `SHA256SUMS.txt` (`npm run checksums`) — без него авто-установка обновления блокируется.

Пути: `main.js` = `app/main.js`, `lib/*` = `app/lib/*`, `js/*` = `app/js/*` (если не указано иное).

---

## Резюме аудита

**Вердикт о полезности.** Программа решает реальную задачу: объединяет Tor + DNSCrypt + I2P в одном tray-приложении с автогенерацией конфигов, аккуратным (с бэкапом/восстановлением и защитой от «отравленных» бэкапов) переключением системного прокси/DNS и работой в цензурируемых сетях (мосты obfs4, выбор стран выхода). Прямых GUI-аналогов такого «всё в одном» под Windows мало; ценность подтверждена. Слабые места: режим только прокси (нет TUN/kill switch — приложение не перехватывает трафик «не-прокси»-программ), одноразовые блок-листы, задвоенные фоновые проверки скорости, мёртвый код OpenVPN и наукоёмкий косметический cursor-fx в приватном инструменте.

**Главный риск безопасности** — один архитектурный: рендерер с `nodeIntegration: true, contextIsolation: false, sandbox: false` и без `setWindowOpenHandler`/`will-navigate` (main.js:483-490). Любая HTML-инъекция в рендерере = полный RCE с правами Node. Цепочка реально собирается: Onionoo-данные попадают в `innerHTML` без экранирования по charset (lib/onionoo.js:62-63 → js/app.js:513-515, 659-660), а кэш `onionoo-exits.json` читается без валидации. Плюс отдельная эскалация: пути/адреса из `dns-backup.json` подставляются в PowerShell-строку, в одном сценарии — под UAC (lib/netmode.js:46-49, main.js:258-266). Обновлятор запускает скачанный exe без проверки подписи/хэша.

**Рекомендуемый порядок работ**: Сначала багфиксы+безопасность (маленькие диффы, живое тестирование) → затем чистка мёртвого кода (уменьшает объём миграции) → затем TypeScript по фазам.

---

## Часть 1. Функциональный анализ (сводка)

### 1.1 Что реально работает (инвентарь фич)

| Фича | Код |
|---|---|
| Жизненный цикл демонов tor/dnscrypt/i2pd (supervisor, readiness, логи, автостарт) | lib/daemons.js, main.js:116-173 |
| Трей: статус-иконка, меню (статусы, IP выхода, скорость, «всё запустить/остановить», автозапуск с Windows) | main.js:546-623 |
| Системный прокси → SOCKS 9050 (HKCU, InternetSetOption, бэкап/восстановление, crash-recovery, семантика «намерения») | lib/proxy.js, main.js:76-84, 410-466, 640-666 |
| Перехват системного DNS (адаптеры → 127.0.0.1, requires admin, бэкап, elevated restore, выбор адаптеров, порт-53 conflict check) | lib/netmode.js, main.js:182-283, 669-707 |
| Блок-листы (oisd small, phishing.army) → blocked-names.txt dnscrypt | lib/blocklists.js, configs.js:214-220 |
| Tor-мосты: чекбокс, textarea, запрос obfs4 с bridges.torproject.org, транспорт-плагины | lib/bridges.js, configs.js:24-75 |
| Выбор стран выхода (чекбоксы + пилюли + подсказки Onionoo «N узл. · X Мбит/с») | lib/onionoo.js, js/app.js:471-555, 652-688 |
| IP-инфо: реальный IP, Tor IP (SOCKS5+TLS), диагностика DNS/Tor/i2p | lib/ipinfo.js, lib/diag.js, main.js:983-1032 |
| Скорость: индикатор в шапке и трее (curl, 1 МБ/5 мин), полный Tor-тест (медиана 3 + 8 МБ) | lib/netspeed.js, lib/torspeed.js |
| Обновлятор: GitHub Releases, прогресс, тихая установка (cmd+vbs / portable-rename) | lib/updater.js, main.js:908-974 |
| Резольверы: авто/ручной выбор из public-resolvers.md (sdns-стемпы), фильтры DNSSEC/NOLOG/NOFILTER, bootstrap, query.log | lib/resolvers.js, main.js:830-872 |
| Прочее: кастомный тайтлбар, single instance, «Запускать с Windows», LAN-доступ к DNS (firewall), «О программе», smoke-режимы | main.js:46-63, 348-367, 473-510 |

### 1.2 Пробелы относительно ТЗ (честно не реализовано)

Kill switch (тасклист 3.3), просмотрщик логов демонов в UI, звуки/уведомления, Tor DNSPort (`PORTS.torDns` объявлен, никогда не используется — configs.js:14), настройки i2pd (конфиг полностью статический), TUN-режим (фаза 7), экспорт/бэкап настроек, snowflake/webtunnel в комплекте (маппинги в configs.js:26-27 указывают на несуществующие exe), i18n (всё захардкожено на русском, хотя ТЗ обещало ru/en).

### 1.3 Вердикт

- **Ядро (демоны + прокси + DNS-перехват + мосты/страны) — полезно, доведено до ума, не трогать, а укреплять.**
- **Обновлятор** — самая рискованная подсистема (без проверки подписи, хрупкий cmd+vbs, portable-ветка обновляет не тот exe). Либо укрепить (хэш/подпись), либо упростить до «открыть страницу релизов».
- **cursor-fx (271 строка), дублированные фоновые замеры, мёртвый OpenVPN-код** — кандидаты на удаление без потери ценности.
- **Блок-листы и updater** — недоработаны (скачиваются один раз / без верификации) — доделать или упростить.

---

## Часть 2. Безопасность

### P0 — критично (делать в первую очередь, отдельным релизом)

- [x] **SEC-1. Отключить Node в рендерере: preload + contextIsolation.** main.js:483-490 (`nodeIntegration:true, contextIsolation:false, sandbox:false`), мост — js/electron-bridge.js:8-11 (берёт ipcRenderer прямо из страницы, без allowlist). Нет `setWindowOpenHandler` и `will-navigate` — открытие/навигация на внешний URL наследует webPreferences.
  1. `nodeIntegration:false, contextIsolation:true, sandbox:true`.
  2. Создать `preload.js` (CJS): `contextBridge.exposeInMainWorld('invis', {...})` с явным allowlist-каналов (см. типы IPC в TS-фазе).
  3. `win.webContents.setWindowOpenHandler(() => ({action:'deny'}))`; `will-navigate` — только свой `file://`.
  4. Внешние ссылки (GitHub, консоль I2P) — только через `shell.openExternal` из main.
  5. Прогнать весь smoke (`APP_SMOKE=5000`) и живое тестирование: все ~35 IPC-каналов.
- [x] **SEC-2. PowerShell-инъекция через `dns-backup.json` → эскалация под UAC.** lib/netmode.js:46-49 (адреса интерполируются в PS-строку без экранирования), main.js:258-266 (elevated restore-скрипт из тех же данных), main.js:215-224 (`JSON.parse` бэкапа без валидации схемы). Эксплойт: малварь того же юзера пишет `%APPDATA%/Invis/dns-backup.json` → юзер принимает UAC «Invis» → код от админа.
  Фикс: строгая валидация адресов `/^[0-9a-fA-F:.]{2,45}$/` и схемы бэкапа (массив `{alias, addresses:string[]}`); передавать адреса аргументами (execFileSync), не строкой; temp-файл со случайным именем. ✅ Сделано (sanitizeDnsBackup, netmode.isValidIp, mkdtemp).
- [x] **SEC-3. Валидация/экранирование Onionoo-данных (XSS-цепочка к SEC-1).** lib/onionoo.js:62-63 (cc проверяется только по длине), :51-56,73 (кэш читается без валидации), js/app.js:513-515 и :659-660 (`${cc}`, `${p.cc}`, `${p.label}` без `StringUtils.escape`), :532 (`r.error` в innerHTML). Фикс: `/^[A-Z]{2}$/` на свежем **и** кэш-пути; `Number()` для count/mbps; экранировать всё в renderCountries/renderQuickCountries. ✅ Сделано (sanitizeCountries + escape в app.js).
### P1 — высокие

- [x] **SEC-4. Обновлятор исполняет непроверенный exe.** lib/updater.js:39-81 (URL из GitHub API, скачивание без хэша), main.js:922-974 (тихая установка через `invis-update.cmd`/`.vbs` с предсказуемыми именами в %TEMP%). ✅ Сделано, вариант Б: тихая установка только после сверки SHA-256 с `SHA256SUMS.txt` релиза (нет sums — установка блокируется, показывается ссылка на страницу релизов); temp-скрипты в mkdtemp-каталоге; `npm run checksums` генерирует суммы для публикации.
- [ ] **SEC-5. fetch-bins без проверки хэшей/подписей (supply chain).** tools/fetch-bins.js:16-38,57-75 — только HTTPS + проверка существования exe; тасклист 1.1 обещал «фиксацию версий и хэшей». Все три проекта публикуют SHA256SUMS/minisign — добавить проверку, валидировать bin/ перед упаковкой.
- [ ] **SEC-6. «Доступ из LAN» = открытый резолвер + слишком широкие firewall-правила.** configs.js:100-104 (бинд 0.0.0.0/[::]), main.js:348-367 (правила для UDP/TCP 53 на все профили без remoteip/program; и вообще порт 53 открыт даже когда dnscrypt слушает 9053). Фикс: `profile=private,domain`, `remoteip=192.168.0.0/16,10.0.0.0/8,172.16.0.0/12`, `program=<dnscrypt.exe>`, открывать реально настроенный порт, слушать LAN-IP вместо 0.0.0.0.
- [ ] **SEC-7. IP выхода по http://ip-api.com** (lib/torspeed.js:71,91) — вредоносный exit может подменить «текущую страну/IP» — подрыв собственного индикатора приватности. Перейти на HTTPS (check.torproject.org/api/ip + https-geoip) или явно пометить как декоративные данные.

### P2 — средние

- [ ] **SEC-8. Предсказуемые скрипты в %TEMP% с `-ExecutionPolicy Bypass`.** lib/proxy.js:20-31 (`invis-proxy-refresh.ps1`), main.js:261-267 (elevated), main.js:963-970 (cmd/vbs) — TOCTOU подмены тем же юзером. Фикс: `fs.mkdtemp`/случайные имена, удалять сразу после использования. 🔶 Частично: dns-restore и update cmd/vbs уже в mkdtemp (SEC-2/SEC-4), остался `invis-proxy-refresh.ps1`.
- [ ] **SEC-9. Неатомарная запись torrc/toml/i2pd.conf** (configs.js:205-221) — рестарт демона может прочитать полусконфиг. tmp+rename как в store.js:89-91.
- [ ] **SEC-10. `deepMerge` — форма прототипного загрязнения.** store.js:63-74: `key in base` истинно для `__proto__`; сейчас спасает строгая проверка типов, но это минус один рефакторинг до дыры. `Object.hasOwn(base, key)`.
- [ ] **SEC-11. `tor.bridgesText` (мосты — чувствительная инфа о цензурном обходе) в открытом settings.json**; в portable-режиме — рядом с exe. Минимум — задокументировать; в идеале — DPAPI для bridgesText.
- [ ] **SEC-12. Path traversal в транспорт-плагинах torrc (ограниченный).** configs.js:68-72: транспорт из пользовательского текста мостов попадает в `<transport>-client.exe`; валидировать `^[a-z0-9]+$`.
- [ ] **SEC-13. `modules:start/stop` без валидации имени.** main.js:820-827 — `stop('bogus')` кидает на daemons.js:204 (`st.proc` от undefined) — крах main из рендерера. Валидировать по `specs` как в `modules:toggle` (main.js:810).

### Сделано правильно (не ломать при миграции)

CSP `default-src 'self'` (index.html:5); Tor CookieAuthentication/ClientOnly/NoExec, control только на loopback (configs.js:50-58, torctl.js:24); все бинды по умолчанию на 127.0.0.1; спавны только массивами аргументов без `shell:true`; `deepMerge` отбрасывает неизвестные ключи; HTTPS везде в загрузках с лимитом редиректов; экранирование в рендерере в основном дисциплинированное (кроме п. SEC-3); атомарное сохранение настроек; crash-recovery DNS/прокси при старте и выходе; single instance.

---

## Часть 3. Баги и нелогичности

### P0 — ломает функциональность

- [x] **BUG-1. `'C:\Windows'` в netspeed.js:9** — `\W` не эскейпится, fallback-путь = `C:Windows\...` (ENOENT + примитив для подсовывания бинарника). Правильно в torspeed.js:8 — скопировать оттуда. Чинится одной строкой.
- [x] **BUG-2. Частичная выгрузка блок-листа кэшируется навсегда.** lib/blocklists.js:29-33,42 — `createWriteStream(dest)` создаёт файл сразу; обрыв = навсегда обрезанный `preset-*.txt` (нет timeout на https.get — зависший сервер вешает весь флоу включения пресета, main.js:743-754). Фикс: качать в `.part`, rename по успеху, удалять при ошибке, добавить timeout.
- [x] **BUG-3. Десинк чекбокса системного DNS при неудачном включении.** main.js:669-707 сохраняет `systemDns:false` и шлёт `settings:changed`, но `pendingKeys` в js/app.js:113-155 «съедает» апдейт — галка остаётся включённой до рестарта. Фикс: удалять ключ из pendingKeys **до** применения пришедших настроек.
- [x] **BUG-4. Модуль навсегда зависает в «остановка…» при неудачном kill.** lib/daemons.js:202-220 — 5-сек failsafe снимает `stopPromise`, но зомби `st.proc` остаётся; очередь стартов блокируется (`if (st.proc) return`, daemons.js:104). Фикс: после failsafe принудительно чистить `st.proc`/эмитить состояние.
- [x] **BUG-5. Portable-самообновление заменяет не тот exe.** main.js:942-951 — у portable-таргета `process.execPath` = временный распакованный exe; обновление кладётся в temp, лаунчер остаётся старым. То же в очистке `Invis.exe.old` (main.js:159-161). Использовать `PORTABLE_EXECUTABLE_DIR`/`PORTABLE_EXECUTABLE_FILENAME`.

### P1 — заметные дефекты

- [x] **BUG-6. Утечка сокета при успешной DNS-диагностике.** lib/diag.js:36-47 — success-путь не вызывает `sock.destroy()`. Завернуть через `finish()`.
- [x] **BUG-7. `getTorIp` может подвесить диагностику.** lib/ipinfo.js:69-87 — не слушается `'close'` (RST не даёт `'end'`), единственный бэкстоп — 20-сек таймер; зависший `diag:run` навсегда блокирует кнопку (js/app.js:829-840). Слушать `'close'` и завершать промис.
- [x] **BUG-8. Tor может вечно висеть в `busy`.** lib/daemons.js:158-164 — bootstrap никогда не достигший 100% (мёртвые мосты) не имеет таймаута → вечное «подключается…». Хард-таймаут 3-5 мин → `error`.
- [x] **BUG-9. Скачивание обновления без таймаута.** lib/updater.js:61-80 — зависший CDN навсегда оставляет `updateState.downloading=true` и блокирует повторные установки (main.js:909). Таймаут неактивности + сброс флага.
- [x] **BUG-10. Двойная проверка обновлений при включении autoUpdate.** js/app.js:156 шлёт `update:check`, main.js:720 делает то же внутри setSetting. Убрать одну.
- [x] **BUG-11. Задвоенный rebuild трей-меню.** main.js:119-120 — `tray?.setContextMenu(trayMenu())` дважды подряд (copy-paste).
- [ ] **BUG-12. `npm run make-icons` сломан на чистом клоне.** tools/make-icons.js:15-16 требуют `sharp`/`png-to-ico`, которых нет в package.json. Объявить devDeps или пометить скрипт как опциональный.
- [x] **BUG-13. tools/screenshot.js: стабы отстали от схемы.** Нет стаба `tor:countries` (app.js:527 вызовет unhandled rejection, пустая страна на всех скриншотах), в стабе настроек нет `tor`-секции и `dnscrypt.presets`/`blockBrowserDoh`. Переписать на общий тип Settings (см. TS-фазу) — исчезнет как класс.

### P2 — мелочи и мусор

- [ ] Мёртвые IPC-каналы main: `window-hide`, `app:quit`, `modules:start`, `modules:stop` (main.js:792-827), `dialog:save` (main.js:1086) — рендерер их не зовёт. Удалить или подключить (кнопки выхода в UI нет вообще — только трей).
- [ ] Мёртвое: `PORTS.torDns` (configs.js:14), `store.getPath` (store.js:94), `logTimer` (daemons.js:79), первый `module.exports` в torspeed.js:67, `let isMax` + блок `.maximize` (js/app.js:6, 69-81 — кнопки в HTML нет), неиспользуемая `line` (js/app.js:756).
- [ ] `#qlInfo` используется в js/app.js:358,371-372,380, но элемента нет в index.html — «N записей» никогда не показывается. Добавить элемент или выпилить код.
- [ ] Двойной вызов `composeBlockedNames` (configs.js:216,218) — читать мегабайтные пресеты один раз за rebuild.
- [ ] `port53Owner` показывает только первый PID из слушающих :53 (lib/netmode.js:70-75).
- [ ] Бессмысленный rethrow (main.js:1054-1056) — теряет стек.
- [x] Комментарий-сирота на main.js:27 (от `quitting` прилип к `trayInfo`).
- [ ] Вводящий в заблуждение статус «Tor перезапускается с новым torrc…», когда Tor не запущен (js/app.js:519, 667-669; main перезапускает только если isRunning, main.js:732-736).
- [ ] Стартовая подсказка «Запусти Tor — и здесь появится IP» (index.html:78) мгновенно затирается «проверяю…» (js/app.js:730).
- [ ] Задвоенный magic number 300 лимита резольверов (js/app.js:266, 291).
- [ ] favicon `type="image/png"`, но файл `.ico` (index.html:10); перекрытия style.css ↔ app.css (`.fields-section h3`, `.content`, `.check-row input`).
- [ ] Фоновые таймеры рендерера (замер скорости 1 МБ / 5 мин js/app.js:706; опрос query.log каждые 2 с js/app.js:367) работают при скрытом окне; плюс дублирующий замер в main (main.js:150) — итого 2 пробы × 1 МБ каждые 5 минут. См. CLEAN-3.
- [ ] 8-сек watchdog выхода (main.js:1101) делает `app.exit(0)` без восстановления DNS/прокси — чинится при следующем старте, но добавить запись в лог.
- [ ] Stale-доки: root README «Статус (v1.6.0)» и «IPC-каналы-заглушки»; app README «~30 МБ» (реально 93 МБ), «заглушки» запуска/остановки; DAEMON_VERSIONS дрейфует от fetch-bins молча (main.js:39).

---

## Часть 4. Упрощения / удаления / улучшения

### Удалить (без потери ценности)

- [ ] **CLEAN-1. Мёртвый блок OpenVPN/VPNGate в рендерере** (~175 строк, js/app.js:577-751): `initModeSwitch`, `initOpenvpn`, `renderVpngate`, `loadVpngate`, `modeState`, `ovpnState`… Зовут 7 несуществующих IPC-каналов (`mode:set`, `vpngate:*`, `openvpn:*`), читают несуществующий сеттинг `privacyMode`, ссылаются на ~12 отсутствующих DOM-элементов. Сейчас неактивны (не вызываются из `init()`), но оживут при случайной проводке; `renderVpngate` к тому же неэкранированный innerHTML. Остаток отката v1.8.0→v1.9.0.
- [ ] **CLEAN-2. cursor-fx.js** (271 строка косметики + `data-cursor-text` на большинстве кнопок index.html, init js/app.js:903) — в приватном сетевом инструменте: лишний DOM- work, расширяет поверхность (лезет в `elementFromPoint`/DOM всего UI). Решение за тобой: удалить или оставить осознанно.
- [ ] **CLEAN-3. Одна проба скорости вместо двух.** main.js:150 (трей) и js/app.js:704-710 (шапка) независимо качают 1 МБ каждые 5 мин. Оставить одну (в main), рендереру — пушить результат событием. Минус фоновый трафик (для Tor это ещё и отпечаток).
- [ ] **CLEAN-4. Лишние файлы/вес:** 30 МБ архивов в `downloads/` (удалять после распаковки в fetch-bins.js:64-71 или не коммитить); обрезать bin/tor (доки, tor-gencert.exe, torrc-defaults — минус ~8 МБ из 93); снежинка/webtunnel в BRIDGE_PLUGINS (configs.js:26-27) без exe — убрать маппинги, пока нет бандла.

### Упростить / доделать

- [ ] **SIM-1. Обновлятор:** либо хэш/подпись (SEC-4а), либо упрощение до «открыть страницу релизов» (SEC-4б). Текущий cmd+vbs-конвейер — самый сложный и наименее проверяемый код в приложении.
- [ ] **SIM-2. Блок-листы: история обновлений.** Скачиваются один раз навсегда (blocklists.js:42 — `if exists return`). TTL как у onionoo (24 ч, onionoo.js:11) или ре-скачивание при старте + показывать «обновлено <дата>».
- [ ] **SIM-3. i2pd tray-icon hack** (main.js:314-345 — Win32 P/Invoke через PowerShell для удаления чужой иконки): хрупко и завязано на сборку i2pd. Либо документировать как known issue, либо искать сборку без `USE_WIN32_APP`.
- [ ] **SIM-4. i18n:** либо реализовать ru/en (обещано в ТЗ §6), либо снять обещание. Все строки сейчас захардкожены в main.js и app.js.
- [ ] **SIM-5. Синхронизировать доки** (см. P2 stale-доки) — дёшево, повышает доверие.

### Улучшения (по желанию, из невыполненного ТЗ/дорожной карты)

- [ ] «Сменить IP» (NEWNYM) в трей-меню (обещано в тасклисте 1.5; сейчас только кнопка в окне, torNewIpBtn).
- [ ] Просмотрщик логов демонов в UI (логи уже пишутся в `%APPDATA%/Invis/logs/`).
- [ ] Kill switch (тасклист 3.3) — главная заявленная ценность, которой нет: при падении Tor трафик «не-прокси»-программ идёт напрямую.
- [ ] Tor DNSPort 5400: константа есть (configs.js:14), в torrc не пишется — дёшево добавить как опцию.
- [ ] Настройки i2pd (полоса, туннели) — i2pd.conf статический (configs.js:158-184).
- [ ] Экспорт/импорт настроек (ТЗ 4.3).

---

## Часть 5. Миграция на TypeScript

### Стратегия

- **CJS остаётся** (без «type» в package.json): ESM в Electron 44 возможен, но выгода нулевая, риск (все require, `__dirname`, tools, sandboxed-preload-только-CJS) — неоправданный.
- **Main+lib — чистый `tsc`** (`tsconfig.main.json`: `module: commonjs, target: ES2022, outDir: dist, rootDir: src, strict: true, sourceMap: true`), без esbuild/electron-vite — 2.4k LOC, emit tsc уже деплоибелен.
- **Renderer — два шага:** (1) сразу `jsconfig.json` с `checkJs+strict` + `js/globals.d.ts` (типы UIBridge/StringUtils/InvisUI/IPC-пейлоады) — типизация без изменения рантайма; (2) позже перевод в `.ts` + esbuild-бандл в IIFE, script-теги в index.html не меняются.
- **tools/*.js — остаются JS**, кроме dev-check (либо `npm run build` перед ним, либо tsx). **tools/check-settings.js — удалить**, заменить компайл-тайп проверкой (`SETTINGS_IDS` типизируется как `Record<keyof Settings, string>` — паритет DEFAULTS↔UI станет ошибкой компиляции вместо eval+regex-скрейпера).
- **package.json:** `"main": "dist/main.js"`, `"files"`: `["dist/**", "index.html", "style.css", "app.css", "js/**"(пока рендерер не забандлён), "assets/**", "THIRD-PARTY-LICENSES.md"]`; скрипты `build`/`start: build && electron .`/`watch`/`dist: build && electron-builder`. ⚠️ Проверить `npm run dist:portable` сразу после фазы 0 — `files`-allowlist молча исключит `dist/`, если забыть.
- **devDeps минимум:** `typescript`, `@types/node` (мажор = Node внутри Electron 44, проверить `npx electron -p process.versions.node`). `@types/electron` НЕ нужен (deprecated-заглушка, у electron свои типы). Опционально: eslint+typescript-eslint (`no-useless-escape` ловит класс бага BUG-1, `no-floating-promises` — расхлябанные промисы main.js), esbuild (фаза рендерера), tsx (для dev-check).
- **Не ломать:** «Electron-free» изоляция lib/* (заявлена в шапках модулей) — сохранить; семантика `deepMerge` с отбрасыванием неизвестных ключей — типизировать как есть.

### Сначала типы (src/types/, ~1 день)

- [ ] **TS-T1. `settings.ts`** — `Settings` из store.js:10-45 (`Autostart`, `DnscryptSettings` c `presets`, `TorSettings`), `SettingsPatch = DeepPartial<Settings>` для `setSetting(patch)` (main.js:633).
- [ ] **TS-T2. `ipc.ts`** — карта каналов: invoke (`settings:get/set`, `modules:status/toggle/…`, `diag:run`, `tor:countries/exitinfo/speedtest/newip`, `bridges:fetch`, `resolvers:list`, `adapters:list`, `querylog:get/clear`, `net:speed`, `update:*`) и push (`modules:state/event`, `settings:changed`, `diag:result`, `update:available/progress/downloaded`). Типизированные обёртки поверх UIBridge. Мёртвые каналы пометить/удалить (CLEAN-1, P2).
- [ ] **TS-T3. `daemon.ts`** — `DaemonName = 'tor'|'dnscrypt'|'i2p'`, `DaemonState = 'off'|'busy'|'on'|'error'`, `ModuleStatus`, дискриминированный `DaemonSpec` (bootstrap vs port-probe), `ProcessSlot`, `ProxyBackup` (proxy.js:56-63), результирующие юнионы `{ok:true,...}|{ok:false,error}` (уже де-факто есть в 5 модулях).

### Фазы конверсии (строгий режим с первого дня)

- [ ] **TS-0. Туллинг** (S, 2-4 ч): devDeps, tsconfig.main.json, jsconfig.json + globals.d.ts для рендерера, скрипты package.json, проверка `npm start` и `dist:portable`.
- [ ] **TS-1. Листья lib без Electron** (~1.5-2 дня): diag (S) → bridges (S) → netspeed (S, заодно BUG-1) → resolvers (S, поднять inline require) → updater (S) → torctl (S-M) → blocklists (S) → ipinfo (M) → onionoo (M) → netmode (M, заодно SEC-2) → proxy (M) → torspeed (M, заодно дубли export).
- [ ] **TS-2. Ядро** (~1 день): store.js (M — generic deepMerge над `Settings`), lib/configs.js (M).
- [ ] **TS-3. Supervisor** (0.5-1 день): lib/daemons.js (класс, дискриминированные спеки, ChildProcess-bookkeeping); проверка `npm run check`.
- [ ] **TS-4. main.js** (1-2 дня, 1115 LOC): IPC-хендлеры, трей, update-флоу, поднять мид-файл require'ы (main.js:977-981).
- [ ] **TS-5. Renderer JS-фаза** (0.5 дня): checkJs на js/*.js, типизация UIBridge.
- [ ] **TS-6. Renderer TS-фаза** (2-4 дня): electron-bridge (S) → utils (S) → cursor-fx (M; или удалить по CLEAN-2) → app.js (L) + esbuild-бандл, правка script-тегов index.html.
- [ ] **TS-7. Tools** (0.5 дня): dev-check (перевод на dist или tsx), screenshot (стабы из общего `Settings`/`ipc` — закрывает BUG-13), удалить check-settings.js, починить make-icons devDeps (BUG-12).

**Итого:** ~8-13 раб. дней до полного strict TS; ~4-5 дней, если рендерер остаётся на checkJs.

### Риски

- `files`-allowlist electron-builder молча исключит `dist/` — тестировать сборку в фазе 0.
- `check-settings.js` и `dev-check.js` умрут при переименовании — решить до фазы 2.
- Сандаboxes-preload требует CJS — наша tsc-commonjs выдача подходит автоматически.
- Мёртвый OpenVPN-код в app.js при типизации заставит принять решение — удалить по CLEAN-1 (или типизировать как «будущая фаза», но не оставлять в подвешенном виде).

---

## Рекомендуемый порядок релизов

| Релиз | Содержимое | Объём |
|---|---|---|
| **v1.9.5** (безопасность + срочные баги) | SEC-1..SEC-7, BUG-1..BUG-5 | 1-2 дня |
| **v1.9.6** (чистка) | CLEAN-1..CLEAN-4, BUG-6..BUG-13, P2-мелочи, SIM-2, SIM-5 | 1-2 дня |
| **v1.10.x** (TS, main-side) | TS-0..TS-4 + TS-T1..T3, попутно SEC-8..SEC-13 | 4-6 дней |
| **v1.11.x** (TS, renderer + финал) | TS-5..TS-7, SIM-1 (по решению), улучшения по желанию | 3-5 дней |
