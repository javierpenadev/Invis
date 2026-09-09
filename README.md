# Invis

Клон InviZible Pro (Android) для Windows: **Tor + DNSCrypt-proxy + I2Pd** под одним
управлением. Electron-приложение с трее: маленькое окно, живые статусы модулей,
настройки автозапуска.

- Источник идеи: [InviZible Pro](https://github.com/Gedsh/InviZible) (GPL-3.0)
- Демоны — официальные сборки: Tor Expert Bundle, dnscrypt-proxy, i2pd

## Документы

- [ТЗ на порт под Windows](ТЗ-порт-Windows.md) — разбор Android-оригинала, целевая архитектура, режимы сети
- [Тасклист](тасклист-порт-Windows.md) — фазы, задачи с DoD и оценками

## Приложение (`app/`)

```bash
cd app
npm install
npm run fetch-bins   # один раз: скачать демонов в bin\ (~30 МБ)
npm start
```

Сборка релиза: `npm run dist` → `release/Invis-Setup-*.exe` + `Invis-Portable-*.exe`.
Готовые сборки — в [Releases](https://github.com/javierpenadev/Invis/releases).

Подробнее — [app/README.md](app/README.md): структура, tray-поведение,
настройки, точки расширения.

## Статус

MVP работает: Tor/DNSCrypt/I2Pd стартуют и мониторятся, DNS через dnscrypt
(127.0.0.1:9053), Tor SOCKS 127.0.0.1:9050, I2P-прокси 4444/4447, консоль 7070.
Дальше по плану: системный DNS-режим, kill switch, мосты Tor, экран логов.

## Лицензия

GPL-3.0 — наследуется от InviZible Pro; лицензии демонов перечисляются в
«О программе» (см. ТЗ §8).
