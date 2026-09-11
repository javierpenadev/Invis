/*
 * Invis UI: тайтлбар, строки модулей, настройки, статус в контрол-баре.
 * Логика демонов подключается позже (ТЗ фаза 1) — пока IPC-заглушки в main.js.
 */
(function () {
    let isMax = false;

    const $ = (sel) => document.querySelector(sel);

    /* ---------- Lucide-иконки (inline SVG, stroke=currentColor) ---------- */
    /* Текстовые ⚡/⏳/✓/✗ на части систем рисуются квадратиками (нет глифа
     * в системном шрифте) — используем векторные иконки */
    const ICONS = {
        zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
        loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
        check: '<path d="M20 6 9 17l-5-5"/>',
        x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    };
    const ico = (name, size = 13) =>
        `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"`
        + ` stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

    /* ---------- статус и прогресс в контрол-баре ---------- */
    const setStatus = (text, { progress = null, error = false } = {}) => {
        const wrap = $('#progressWrap');
        const idle = $('#idleText');
        if (progress === null) {
            wrap?.classList.add('is-hidden');
            if (idle) idle.textContent = text;
            return;
        }
        wrap?.classList.remove('is-hidden');
        idle?.classList.add('is-hidden');
        const fill = $('#progressFill');
        if (fill) fill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
        const status = $('#statusText');
        if (status) { status.textContent = text; status.classList.toggle('error', error); }
    };

    /* ---------- состояние модулей (dot в строке + чип внизу) ---------- */
    const MODULES = {
        dnscrypt: { chip: 'chipDnscrypt', label: 'DNS', dot: 'dotDnscrypt', status: 'statusDnscrypt' },
        tor: { chip: 'chipTor', label: 'TOR', dot: 'dotTor', status: 'statusTor' },
        i2p: { chip: 'chipI2p', label: 'I2P', dot: 'dotI2p', status: 'statusI2p' },
    };

    /* state: 'off' | 'busy' | 'on' | 'error' */
    const setModuleState = (name, state, statusText) => {
        const m = MODULES[name];
        if (!m) return;
        $(`#${m.dot}`)?.classList.toggle('is-on', state === 'on');
        $(`#${m.dot}`)?.classList.toggle('is-busy', state === 'busy');
        $(`#${m.dot}`)?.classList.toggle('is-error', state === 'error');
        const chip = $(`#${m.chip}`);
        if (chip) {
            chip.textContent = m.label; // статус — только цветом
            chip.classList.toggle('is-on', state === 'on');
            chip.classList.toggle('is-busy', state === 'busy');
            chip.classList.toggle('is-error', state === 'error');
        }
        if (statusText !== undefined) {
            const el = $(`#${m.status}`);
            if (el) el.textContent = statusText;
        }
        $(`[data-module="${name}"]`)?.classList.toggle('is-on', state === 'on');
    };

    /* ---------- тайтлбар ---------- */
    const updateMaxIcon = () => {
        const m = document.querySelector('.maximize svg');
        if (m) m.innerHTML = isMax
            ? '<rect x="2" y="2" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1.5"/>'
            : '<rect x="1" y="1" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5"/>';
    };

    const initTitlebar = () => {
        $('.minimize')?.addEventListener('click', () => UIBridge.send('window-minimize'));
        $('.maximize')?.addEventListener('click', () => { UIBridge.send('window-maximize'); isMax = !isMax; updateMaxIcon(); });
        $('.devtools')?.addEventListener('click', () => UIBridge.send('window-devtools'));
        $('.close')?.addEventListener('click', () => UIBridge.send('window-close'));
    };

    /* ---------- настройки ---------- */
    const SETTINGS_IDS = {
        launchWithWindows: 'setLaunchWithWindows',
        closeToTray: 'setCloseToTray',
        systemDns: 'setSystemDns',
        systemProxy: 'setSystemProxy',
        autoUpdate: 'setAutoUpdate',
        'dnscrypt.autoMode': 'setDnscryptAuto',
        'dnscrypt.requireDnssec': 'fltRequireDnssec',
        'dnscrypt.requireNolog': 'fltRequireNolog',
        'dnscrypt.requireNofilter': 'fltRequireNofilter',
        'dnscrypt.dnscryptProto': 'fltDnscryptProto',
        'dnscrypt.dohProto': 'fltDohProto',
        'dnscrypt.cache': 'setCache',
        'dnscrypt.blockIpv6': 'setBlockIpv6',
        'dnscrypt.forceTcp': 'setForceTcp',
        'dnscrypt.lanAccess': 'setLanAccess',
        'dnscrypt.queryLog': 'setQueryLog',
        'dnscrypt.blockBrowserDoh': 'setBlockBrowserDoh',
        'dnscrypt.presets.ads': 'presetAds',
        'dnscrypt.presets.malware': 'presetMalware',
        'tor.useBridges': 'setUseBridges',
        'autostart.dnscrypt': 'setAutoDnscrypt',
        'autostart.tor': 'setAutoTor',
        'autostart.i2p': 'setAutoI2p',
    };

    /* Ключи с несохранённым патчем: рассылки settings:changed и ответы на свои
     * же invoke не должны затирать чекбокс, который пользователь только что
     * переключил (раньше быстрая смена двух галочек визуально сбрасывала вторую) */
    const pendingKeys = new Set();

    const applySettingsToForm = (s) => {
        for (const [key, id] of Object.entries(SETTINGS_IDS)) {
            if (pendingKeys.has(key)) continue;
            const value = key.split('.').reduce((acc, part) => acc?.[part], s);
            const input = document.getElementById(id);
            if (input && typeof value === 'boolean') input.checked = value;
        }
    };

    const initSettings = async () => {
        const current = await UIBridge.invoke('settings:get');
        if (current) applySettingsToForm(current);

        for (const [key, id] of Object.entries(SETTINGS_IDS)) {
            document.getElementById(id)?.addEventListener('change', (e) => {
                // путь любой глубины: 'a.b.c' -> { a: { b: { c: value } } }
                const patch = {};
                let node = patch;
                const parts = key.split('.');
                parts.forEach((part, i) => {
                    if (i === parts.length - 1) node[part] = e.target.checked;
                    else node = node[part] = {};
                });
                const OVERLAY_TEXT = {
                    systemDns: 'Применяю перехват системного DNS…',
                    systemProxy: 'Переключаю системный прокси…',
                };
                const ovText = OVERLAY_TEXT[key]
                    || (key.startsWith('dnscrypt.presets.') ? 'Загружаю блок-лист…' : null);
                if (ovText) InvisUI.showOverlay(ovText, { hideOnState: true });
                pendingKeys.add(key);
                UIBridge.invoke('settings:set', patch)
                    .then((s) => {
                        /* Ключ снимаем ДО применения ответа: main при неудаче
                         * (например, перехват DNS не применён) возвращает
                         * исправленное значение — галка обязана перерисоваться */
                        pendingKeys.delete(key);
                        if (s) applySettingsToForm(s);
                    })
                    .catch((err) => {
                        InvisUI.hideOverlay();
                        InvisUI.setStatus(`Ошибка сохранения настройки: ${err.message || err}`, { error: true });
                    })
                    .finally(() => {
                        pendingKeys.delete(key);
                        hideOverlayIfPending();
                    });
            });
        }

        /* Настройки могли изменить из трея — синхронизируем форму */
        UIBridge.on('settings:changed', (s) => {
            applySettingsToForm(s);
            syncResolverSelection(s);
            hideOverlayIfPending();
        });
    };

    /* ---------- оверлей контента (долгие операции) ---------- */
    let overlayHideOnState = false;
    let overlayTimer = null;
    const showOverlay = (text, opts = {}) => {
        const ov = $('#contentOverlay');
        if (!ov) return;
        $('#overlayText').textContent = text || 'Применяю…';
        ov.classList.remove('is-hidden');
        overlayHideOnState = Boolean(opts.hideOnState);
        /* страховка: оверлей не может висеть вечно */
        clearTimeout(overlayTimer);
        overlayTimer = setTimeout(hideOverlay, 45000);
    };
    const hideOverlay = () => {
        clearTimeout(overlayTimer);
        overlayHideOnState = false;
        $('#contentOverlay')?.classList.add('is-hidden');
    };
    const hideOverlayIfPending = () => { if (overlayHideOnState) hideOverlay(); };

    /* ---------- модули: состояния приходят из main (DaemonSupervisor) ---------- */
    const moduleStates = { dnscrypt: 'off', tor: 'off', i2p: 'off' };

    /* Текст статуса модуля: из события или дефолт по состоянию */
    const DEFAULT_STATUS = { off: 'остановлен', busy: 'запуск…', on: 'работает', error: 'ошибка' };
    const statusText = {};

    const applyModuleState = (name, state, text) => {
        moduleStates[name] = state;
        if (text !== undefined && text !== null) statusText[name] = text;
        InvisUI.setModuleState(name, state, statusText[name] || DEFAULT_STATUS[state]);
        /* подпись кнопки Пуск/Стоп в строке модуля */
        const btn = document.querySelector(`.module-toggle[data-module="${name}"]`);
        if (btn) btn.textContent = (state === 'on' || state === 'busy') ? 'Стоп' : 'Пуск';
        hideOverlayIfPending();
        updateModuleButtons();
        updateAggregate();
    };

    /* Сводный статус в контрол-баре */
    const NAMES = { dnscrypt: 'DNSCrypt', tor: 'Tor', i2p: 'I2P' };
    const updateAggregate = () => {
        const active = Object.entries(moduleStates).filter(([, s]) => s !== 'off');
        if (!active.length) { InvisUI.setStatus('Готов к работе'); return; }
        const parts = active.map(([n]) => `${NAMES[n]} ${statusText[n] || DEFAULT_STATUS[moduleStates[n]]}`);
        InvisUI.setStatus(parts.join(' · '));
    };

    /* Кнопки Пуск/Стоп: текст и доступность по состоянию модулей */
    const updateModuleButtons = () => {
        const start = $('#startAllBtn'), stop = $('#stopAllBtn');
        if (!start || !stop) return;
        const states = Object.values(moduleStates);
        const busy = states.includes('busy');
        const running = states.filter((s) => s === 'on').length;
        const allOn = running === states.length;
        const allOff = states.every((s) => s === 'off');
        if (busy) {
            start.innerHTML = `${ico('loader')} Запуск…`; start.disabled = true;
            stop.textContent = 'Остановить'; stop.disabled = false;
        } else if (allOn) {
            start.innerHTML = `${ico('check')} Запущено`; start.disabled = true;
            stop.textContent = 'Остановить'; stop.disabled = false;
        } else if (allOff) {
            start.innerHTML = `${ico('zap')} Запустить всё`; start.disabled = false;
            stop.textContent = 'Остановлено'; stop.disabled = true;
        } else {
            start.innerHTML = `${ico('zap')} Запустить всё`; start.disabled = false;
            stop.textContent = 'Остановить'; stop.disabled = false;
        }
    };

    /* ---------- резольверы ---------- */
    const resolverState = { list: [], loaded: false, selected: new Set() };

    const resolverVisible = () => {
        const q = ($('#resolverSearch')?.value || '').toLowerCase();
        const wantDnssec = $('#fltRequireDnssec')?.checked;
        const wantNolog = $('#fltRequireNolog')?.checked;
        const wantNofilter = $('#fltRequireNofilter')?.checked;
        const allowDnscryptProto = $('#fltDnscryptProto')?.checked;
        const allowDoh = $('#fltDohProto')?.checked;
        return resolverState.list.filter((r) => {
            if (q && !(`${r.name} ${r.description}`.toLowerCase().includes(q))) return false;
            if (wantDnssec && !r.dnssec) return false;
            if (wantNolog && !r.nolog) return false;
            if (wantNofilter && !r.nofilter) return false;
            if (allowDnscryptProto && r.protos.includes('DNSCrypt')) return true;
            if (allowDoh && r.protos.includes('DoH')) return true;
            return !(allowDnscryptProto || allowDoh);
        });
    };

    const renderResolverList = () => {
        const box = $('#resolverList');
        if (!box) return;
        const visible = resolverVisible();
        const cap = 300;
        box.innerHTML = '';
        for (const r of visible.slice(0, cap)) {
            const row = document.createElement('label');
            row.className = 'resolver-row';
            const badges = [
                r.protos.join('/'),
                r.dnssec ? 'DNSSEC' : null,
                r.nolog ? 'NOLOG' : null,
                r.nofilter ? 'NOFILTER' : null,
            ].filter(Boolean).join(' · ');
            row.innerHTML = `<input type="checkbox" ${resolverState.selected.has(r.name) ? 'checked' : ''}>`
                + `<span class="resolver-name" title="${StringUtils.escape(r.description)}">${StringUtils.escape(r.name)}</span>`
                + `<span class="hint resolver-props">${StringUtils.escape(badges)}</span>`;
            row.querySelector('input').addEventListener('change', (e) => {
                e.target.checked ? resolverState.selected.add(r.name) : resolverState.selected.delete(r.name);
                UIBridge.invoke('settings:set', { dnscrypt: { autoMode: false, servers: [...resolverState.selected] } });
                updateResolverInfo(visible.length);
            });
            box.appendChild(row);
        }
        updateResolverInfo(visible.length);
    };

    const updateResolverInfo = (shown) => {
        const el = $('#resolverInfo');
        if (el) el.textContent = `выбрано ${resolverState.selected.size} · показано ${Math.min(shown, 300)} из ${resolverState.list.length}`;
    };

    const syncResolverSelection = (s) => {
        resolverState.selected = new Set(s?.dnscrypt?.servers || []);
        renderResolverList();
        const controls = $('#resolverControls');
        if (controls) controls.classList.toggle('is-hidden', Boolean(s?.dnscrypt?.autoMode));
        const auto = $('#setDnscryptAuto');
        if (auto) auto.checked = Boolean(s?.dnscrypt?.autoMode);
    };

    const initResolvers = async () => {
        const r = await UIBridge.invoke('resolvers:list');
        if (r && r.ok) { resolverState.list = r.list; resolverState.loaded = true; }
        const info = $('#resolverInfo');
        if (info && !resolverState.loaded) info.textContent = r?.error || 'Список недоступен';

        $('#resolverSearch')?.addEventListener('input', renderResolverList);
        /* Фильтры-галки — это настройки dnscrypt (require_*, протоколы, autoMode);
         * их сохранение в main уже обслужено общими слушателями из initSettings,
         * здесь только перерисовка списка и показ/скрытие панели выбора. */
        for (const id of ['fltRequireDnssec', 'fltRequireNolog', 'fltRequireNofilter', 'fltDnscryptProto', 'fltDohProto']) {
            document.getElementById(id)?.addEventListener('change', renderResolverList);
        }
        $('#setDnscryptAuto')?.addEventListener('change', (e) => {
            $('#resolverControls')?.classList.toggle('is-hidden', e.target.checked);
        });
        $('#setBootstrap')?.addEventListener('change', (e) => {
            const list = e.target.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
            if (list.length) UIBridge.invoke('settings:set', { dnscrypt: { bootstrap: list } });
        });
        syncResolverSelection(await UIBridge.invoke('settings:get'));
    };

    /* ---------- адаптеры перехвата DNS ---------- */
    const renderAdapters = (s, list) => {
        const box = $('#adapterList');
        if (!box) return;
        const selected = new Set(s?.systemDnsAdapters || []);
        box.innerHTML = '';
        if (!list || !list.length) {
            box.innerHTML = '<span class="hint">Нет активных адаптеров</span>';
            return;
        }
        for (const name of list) {
            const label = document.createElement('label');
            label.className = 'check-row';
            label.innerHTML = `<input type="checkbox" ${selected.has(name) ? 'checked' : ''}> ${StringUtils.escape(name)}`;
            label.querySelector('input').addEventListener('change', (e) => {
                e.target.checked ? selected.add(name) : selected.delete(name);
                UIBridge.invoke('settings:set', { systemDnsAdapters: [...selected] });
            });
            box.appendChild(label);
        }
    };

    const initAdapters = async () => {
        const r = await UIBridge.invoke('adapters:list');
        const current = await UIBridge.invoke('settings:get');
        renderAdapters(current, r && r.ok ? r.list : []);
        UIBridge.on('settings:changed', (s) => renderAdapters(s, r && r.ok ? r.list : []));
    };

    /* ---------- лог запросов ---------- */
    const initQueryLog = async () => {
        const view = $('#qlView');
        const info = $('#qlInfo');
        let filter = '';
        let timer = null;
        /* Держим состояние сами: галочка из DOM заполняется асинхронно,
         * и раньше при старте с уже включённым логом опрос не начинался вовсе */
        let enabled = false;

        const startPolling = () => {
            refresh();
            if (!timer) timer = setInterval(refresh, 2000);
        };
        const stopPolling = () => {
            if (timer) { clearInterval(timer); timer = null; }
            if (view) view.textContent = 'Лог пуст';
            if (info) info.textContent = '';
        };

        const refresh = async () => {
            if (!enabled) return;
            try {
                const r = await UIBridge.invoke('querylog:get', { filter });
                if (r && view) view.textContent = r.lines.length ? r.lines.join('\n') : 'Лог пуст';
                if (r && info) info.textContent = `${r.total} записей`;
            } catch (e) { /* файл недоступен — покажем на следующем тике */ }
        };

        $('#setQueryLog')?.addEventListener('change', (e) => {
            enabled = e.target.checked;
            if (enabled) startPolling();
            else stopPolling();
        });

        /* Галочка включена в сохранённых настройках — опрашиваем сразу */
        const saved = await UIBridge.invoke('settings:get');
        if (saved?.dnscrypt?.queryLog) {
            enabled = true;
            startPolling();
        }
        $('#qlRefreshBtn')?.addEventListener('click', refresh);
        $('#qlClearBtn')?.addEventListener('click', async () => {
            UIBridge.send('querylog:clear');
            setTimeout(refresh, 200);
        });
        $('#checkUpdatesBtn')?.addEventListener('click', () => {
            InvisUI.setStatus('Проверяем обновления…');
            UIBridge.send('update:check');
        });
        $('#qlFilter')?.addEventListener('input', (e) => {
            filter = e.target.value.trim();
            clearTimeout(initQueryLog._t);
            initQueryLog._t = setTimeout(refresh, 300);
        });
    };

    const initModules = async () => {
        for (const btn of document.querySelectorAll('.module-toggle')) {
            btn.addEventListener('click', () => {
                const name = btn.dataset.module;
                /* остановка dnscrypt при перехвате возвращает системный DNS — это заметная пауза */
                if (name === 'dnscrypt' && moduleStates.dnscrypt === 'on') {
                    InvisUI.showOverlay('Останавливаю DNSCrypt…', { hideOnState: true });
                }
                UIBridge.send('modules:toggle', name);
            });
        }
        $('#startAllBtn')?.addEventListener('click', () => UIBridge.send('modules:start-all'));
        $('#stopAllBtn')?.addEventListener('click', () => UIBridge.send('modules:stop-all'));

        UIBridge.on('modules:state', ({ name, state, status }) => applyModuleState(name, state, status));

        /* Восстановить статусы при повторном открытии окна */
        const current = await UIBridge.invoke('modules:status');
        if (current) {
            for (const [name, st] of Object.entries(current)) applyModuleState(name, st.state, st.status);
        }
        $('#appPreloader')?.classList.add('is-hidden');
    };

    /* ---------- «О программе» ---------- */
    const initAbout = async () => {
        const el = $('#aboutText');
        if (!el) return;
        try {
            const info = await UIBridge.invoke('app:info');
            if (!info) { el.textContent = 'Invis'; return; }
            el.innerHTML = `Invis <b>v${StringUtils.escape(info.version)}</b> · Electron ${StringUtils.escape(info.electron)}<br>`
                + `Демоны: Tor ${StringUtils.escape(info.daemons.tor)} (BSD-3) · `
                + `dnscrypt-proxy ${StringUtils.escape(info.daemons.dnscrypt)} (ISC) · `
                + `i2pd ${StringUtils.escape(info.daemons.i2pd)} (BSD-3)<br>`
                + `Лицензия Invis: <b>GPL-3.0</b>. Тексты лицензий сторонних компонентов — `
                + `<code>THIRD-PARTY-LICENSES.md</code> в каталоге приложения.`;
        } catch (e) {
            el.textContent = 'Invis';
        }
    };

    /* ---------- инициализация ---------- */
    /* ---------- вкладки ---------- */
    const initTabs = () => {
        const btns = document.querySelectorAll('.tab-btn');
        const activate = (id) => {
            document.querySelectorAll('.tab-page').forEach((p) => p.classList.toggle('active', p.dataset.page === id));
            btns.forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
            try { localStorage.setItem('invis-tab', id); } catch (e) { /* приватный режим */ }
        };
        btns.forEach((b) => b.addEventListener('click', () => activate(b.dataset.tab)));
        let saved = 'modules';
        try { saved = localStorage.getItem('invis-tab') || 'modules'; } catch (e) { /* ignore */ }
        activate(document.querySelector(`.tab-page[data-page="${saved}"]`) ? saved : 'modules');
    };

    /* ---------- Tor: страны выхода ---------- */
    /* Флаги-эмодзи не используем: Windows их не рендерит (квадратики) */
    const COUNTRIES = {
        US: 'США', DE: 'Германия', NL: 'Нидерланды', FR: 'Франция', GB: 'Британия',
        SE: 'Швеция', CH: 'Швейцария', CA: 'Канада', RO: 'Румыния', FI: 'Финляндия',
        AT: 'Австрия', NO: 'Норвегия', PL: 'Польша', CZ: 'Чехия', ES: 'Испания',
        IT: 'Италия', JP: 'Япония', SG: 'Сингапур', AU: 'Австралия', UA: 'Украина',
        MD: 'Молдова', LV: 'Латвия', LT: 'Литва', EE: 'Эстония', TR: 'Турция',
        IS: 'Исландия', HK: 'Гонконг', KR: 'Корея', IN: 'Индия', BR: 'Бразилия',
        MX: 'Мексика', ZA: 'ЮАР', AE: 'ОАЭ', IL: 'Израиль', GR: 'Греция',
        PT: 'Португалия', DK: 'Дания', BE: 'Бельгия', IE: 'Ирландия', HU: 'Венгрия',
        BG: 'Болгария', RS: 'Сербия', SK: 'Словакия', SI: 'Словения', HR: 'Хорватия',
        RU: 'Россия', GE: 'Грузия', AM: 'Армения', KZ: 'Казахстан', TH: 'Таиланд',
        VN: 'Вьетнам', ID: 'Индонезия', MY: 'Малайзия', CL: 'Чили', NZ: 'Н. Зеландия',
        LU: 'Люксембург',
    };
    const countryState = { selected: new Set(), data: null, busy: false };

    const countryHint = (cc) => {
        const d = countryState.data && countryState.data.ok ? countryState.data.countries[cc] : null;
        if (!d) return '';
        const speed = d.mbps >= 1000 ? `${(d.mbps / 1000).toFixed(1)} Гбит/с` : `${d.mbps} Мбит/с`;
        return `${d.count} узл. · ${speed}`;
    };

    const renderCountries = () => {
        const box = $('#exitCountries');
        if (!box) return;
        /* порядок: сначала страны с выходными узлами (по убыванию скорости) */
        let codes;
        if (countryState.data && countryState.data.ok) {
            const withData = Object.entries(countryState.data.countries)
                .sort((a, b) => (b[1].mbps - a[1].mbps) || (b[1].count - a[1].count))
                .map(([cc]) => cc);
            codes = [...withData, ...Object.keys(COUNTRIES).filter((cc) => !withData.includes(cc))];
        } else {
            codes = Object.keys(COUNTRIES);
        }
        box.innerHTML = '';
        for (const cc of codes) {
            const name = COUNTRIES[cc] || cc;
            const label = document.createElement('label');
            label.className = 'check-row';
            const hint = countryHint(cc);
            label.innerHTML = `<input type="checkbox" ${countryState.selected.has(cc) ? 'checked' : ''}>`
                + `<span class="country-code">${StringUtils.escape(cc)}</span> ${StringUtils.escape(name)}`
                + (hint ? ` <span class="hint">${StringUtils.escape(hint)}</span>` : '');
            label.querySelector('input').addEventListener('change', (e) => {
                e.target.checked ? countryState.selected.add(cc) : countryState.selected.delete(cc);
                UIBridge.invoke('settings:set', { tor: { exitCountries: [...countryState.selected] } });
                InvisUI.setStatus('Страны выхода изменены — Tor перезапускается с новым torrc…');
            });
            box.appendChild(label);
        }
    };

    const loadCountries = async (force = false) => {
        countryState.busy = true;
        const r = await UIBridge.invoke('tor:countries', { force });
        countryState.busy = false;
        countryState.data = r;
        if (!r || !r.ok) {
            const el = $('#exitCountries');
            if (el) el.innerHTML = `<span class="hint">${StringUtils.escape((r && r.error) || 'Данные Onionoo недоступны')} — страны всё равно можно выбирать</span>`;
        }
        renderCountries();
    };

    const initTorCountries = async () => {
        const s = await UIBridge.invoke('settings:get');
        countryState.selected = new Set(s?.tor?.exitCountries || []);
        loadCountries(false);
        $('#countriesRefreshBtn')?.addEventListener('click', () => {
            InvisUI.setStatus('Обновляю данные о выходных узлах (Onionoo)…');
            loadCountries(true).then(() => {
                if (countryState.data && countryState.data.ok) {
                    const n = Object.keys(countryState.data.countries).length;
                    InvisUI.setStatus(`Onionoo: страны с выходными узлами — ${n}`);
                }
            });
        });
        /* Настройки могли поменять вне окна — держим выбор актуальным */
        UIBridge.on('settings:changed', (s2) => {
            countryState.selected = new Set(s2?.tor?.exitCountries || []);
            if (!countryState.busy) renderCountries();
        });
    };

    /* ---------- тест скорости через Tor (кнопка в шапке) ---------- */
    const initSpeedTest = () => {
        $('#speedBtn')?.addEventListener('click', async () => {
            InvisUI.setStatus('Тест канала через Tor: задержка, затем скорость (до минуты)…');
            const btn = $('#speedBtn');
            if (btn) btn.disabled = true;
            try {
                const r = await UIBridge.invoke('tor:speedtest');
                if (!r || !r.ok) {
                    InvisUI.setStatus(`Тест не удался: ${(r && r.error) || 'неизвестная ошибка'}`, { error: true });
                    return;
                }
                const where = r.country ? ` (${r.country})` : '';
                InvisUI.setStatus(`Tor: ↓ ${r.mbps} Мбит/с · пинг ${r.medianMs} мс · выход ${r.ip}${where}`);
            } finally {
                if (btn) btn.disabled = false;
            }
        });
    };

    /* ---------- режим приватности tor | openvpn ---------- */
    const modeState = { current: 'tor' };
    const MODE_HINTS = {
        tor: 'Прокси SOCKS5 для браузера и приложений',
        openvpn: 'Весь трафик системы через TAP (требуется админ)',
    };
    const applyModeUI = (s) => {
        modeState.current = s?.privacyMode === 'openvpn' ? 'openvpn' : 'tor';
        document.querySelectorAll('.mode-pill').forEach((p) =>
            p.classList.toggle('active', p.dataset.mode === modeState.current));
        const hint = $('#modeHint');
        if (hint) hint.textContent = MODE_HINTS[modeState.current];
        $('#rowOpenvpn')?.classList.toggle('is-hidden', modeState.current !== 'openvpn');
        $('#chipOpenvpn')?.classList.toggle('is-hidden', modeState.current !== 'openvpn');
        const sp = $('#setSystemProxy');
        if (sp) { sp.disabled = modeState.current === 'openvpn'; if (modeState.current === 'openvpn') sp.checked = false; }
        $('#systemProxyOvpnHint')?.classList.toggle('is-hidden', modeState.current !== 'openvpn');
    };
    const initModeSwitch = async () => {
        applyModeUI(await UIBridge.invoke('settings:get'));
        document.querySelectorAll('.mode-pill').forEach((p) => p.addEventListener('click', () => {
            if (p.dataset.mode === modeState.current) return;
            InvisUI.showOverlay('Переключаю канал приватности…', { hideOnState: true });
            UIBridge.invoke('mode:set', p.dataset.mode).catch((e) => {
                InvisUI.hideOverlay();
                InvisUI.setStatus('Не удалось переключить режим: ' + (e.message || e), { error: true });
            });
        }));
        UIBridge.on('settings:changed', applyModeUI);
    };

    /* ---------- OpenVPN: детект, импорт, VPNGate ---------- */
    const fmtSpeed = (bytesPerSec) => {
        const mbps = bytesPerSec * 8 / 1e6;
        return mbps >= 100 ? Math.round(mbps) + ' Мбит/с' : mbps.toFixed(1) + ' Мбит/с';
    };
    const ovpnState = { servers: [], busy: false };

    const renderVpngate = () => {
        const box = $('#vpngateList');
        if (!box) return;
        if (!ovpnState.servers.length) { box.innerHTML = '<span class="hint">Список пуст — нажмите «Обновить список VPNGate»</span>'; return; }
        const rows = [...ovpnState.servers].sort((a, b) => (a.pingMs || 9e9) - (b.pingMs || 9e9)).slice(0, 40);
        box.innerHTML = rows.map((r) => {
            const idx = ovpnState.servers.indexOf(r);
            return '<div class="vpngate-row" data-i="' + idx + '">'
            + '<span class="country-code">' + StringUtils.escape(r.cc || '??') + '</span>'
            + '<span class="vg-host" title="' + StringUtils.escape(r.host || '') + '">' + StringUtils.escape(r.host || r.ip) + '</span>'
            + '<span class="vg-ping' + ((r.pingMs || 999) < 150 ? ' good' : '') + '">' + (r.pingMs != null ? r.pingMs + ' мс' : '—') + '</span>'
            + '<span class="vg-speed">' + fmtSpeed(r.speedBps) + '</span>'
            + '<button class="mini-btn vg-connect" data-cursor-text="o">Подключить</button>'
            + '</div>';
        }).join('');
        box.querySelectorAll('.vg-connect').forEach((btn) => btn.addEventListener('click', (e) => {
            const row = e.target.closest('.vpngate-row');
            const srv = ovpnState.servers[Number(row.dataset.i)];
            InvisUI.showOverlay('Подключаюсь через ' + (srv.cc || 'VPN') + ' — подтвердите запрос UAC…', { hideOnState: true });
            InvisUI.setStatus('OpenVPN: подключение к ' + (srv.host || srv.ip) + '…');
            UIBridge.invoke('vpngate:connect', srv).then((r) => {
                if (!r || !r.ok) { InvisUI.hideOverlay(); InvisUI.setStatus((r && r.error) || 'Не удалось подключиться', { error: true }); return; }
                const h = $('#ovpnServerHint'); if (h) h.textContent = '· ' + (srv.cc || '') + ' ' + (srv.host || srv.ip || '');
            });
        }));
    };

    const loadVpngate = async (force) => {
        if (ovpnState.busy) return;
        ovpnState.busy = true;
        const r = await UIBridge.invoke('vpngate:list', { force });
        ovpnState.busy = false;
        if (r && r.ok) { ovpnState.servers = r.servers; renderVpngate(); if (force) InvisUI.setStatus('VPNGate: серверов — ' + r.servers.length); }
        else { const el = $('#vpngateList'); if (el) el.innerHTML = '<span class="hint">VPNGate недоступен: ' + StringUtils.escape((r && r.error) || '') + '. Можно импортировать свой .ovpn.</span>'; }
    };

    /* ---------- быстрый выбор страны выхода Tor ---------- */
    const quickCt = { selected: new Set(), top: [], busy: false };
    const QC_FIRST = ['DE', 'NL', 'US', 'SE', 'CH', 'FI', 'FR', 'GB'];
    const renderQuickCountries = () => {
        const box = $('#quickCountries');
        if (!box) return;
        const codes = [...new Set([...quickCt.top, ...quickCt.selected, ...QC_FIRST])].slice(0, 12);
        const pills = [{ cc: '', label: 'Любая' }, ...codes.map((cc) => ({ cc, label: cc }))];
        box.innerHTML = '<span class="qc-label">Выход Tor:</span>' + pills.map((p) =>
            '<button class="qc-pill' + ((p.cc === '' && !quickCt.selected.size) || quickCt.selected.has(p.cc) ? ' active' : '') + '" data-cc="'
            + StringUtils.escape(p.cc) + '" data-cursor-text="s">' + StringUtils.escape(p.label) + '</button>').join('');
        box.querySelectorAll('.qc-pill').forEach((b) => b.addEventListener('click', () => {
            const cc = b.dataset.cc;
            if (!cc) quickCt.selected.clear();
            else quickCt.selected.has(cc) ? quickCt.selected.delete(cc) : quickCt.selected.add(cc);
            UIBridge.invoke('settings:set', { tor: { exitCountries: [...quickCt.selected] } });
            renderQuickCountries();
            InvisUI.setStatus(quickCt.selected.size
                ? 'Выход Tor: ' + [...quickCt.selected].join(', ').toUpperCase() + ' — Tor перезапускается'
                : 'Выход Tor: любая страна — Tor перезапускается');
        }));
    };
    const applyQuickFromSettings = (s2) => {
        quickCt.selected = new Set(s2?.tor?.exitCountries || []);
        renderQuickCountries();
    };
    const initQuickCountries = async () => {
        try { applyQuickFromSettings(await UIBridge.invoke('settings:get')); } catch (e) {}
        renderQuickCountries(); /* сразу, без ожидания сети */
        try {
            const c = await UIBridge.invoke('tor:countries', {});
            if (c && c.ok) {
                quickCt.top = Object.entries(c.countries)
                    .sort((a, b) => b[1].mbps - a[1].mbps).slice(0, 8).map(([cc]) => cc);
                renderQuickCountries();
            }
        } catch (e) { /* пилюли уже отрисованы */ }
        UIBridge.on('settings:changed', applyQuickFromSettings);
    };

    /* ---------- скорость канала в шапке ---------- */
    const tbSpeed = { busy: false };
    const measureSpeed = async () => {
        if (tbSpeed.busy) return;
        tbSpeed.busy = true;
        const viaTor = moduleStates.tor === 'on';
        const el = $('#tbSpeed');
        try {
            const mbps = await UIBridge.invoke('net:speed', { viaTor });
            const v = mbps >= 10 ? String(Math.round(mbps)) : mbps.toFixed(1);
            if (el) el.textContent = '↓ ' + v + ' Мбит/с' + (viaTor ? ' · Tor' : '');
        } catch (e) { if (el) el.textContent = '↓ …'; }
        tbSpeed.busy = false;
    };
    const initTitlebarSpeed = () => {
        measureSpeed();
        setInterval(measureSpeed, 5 * 60 * 1000); /* лёгкий замер 1 МБ раз в 5 минут */
        UIBridge.on('modules:state', ({ name, state }) => {
            if (name === 'tor' && (state === 'on' || state === 'off')) setTimeout(measureSpeed, 1500);
        });
    };

    /* ---------- IP выхода Tor: страна, город, пинг ---------- */
    const initExitInfo = () => {
        const run = async () => {
            const el = $('#exitInfoText');
            if (!el) return;
            el.textContent = 'проверяю…';
            try {
                const r = await UIBridge.invoke('tor:exitinfo');
                if (!r.ok) throw new Error(r.error || 'недоступно');
                el.innerHTML = '<span class="country-code">' + StringUtils.escape(r.cc || '??') + '</span> '
                    + StringUtils.escape([r.city, r.country].filter(Boolean).join(', ') || '—')
                    + ' · ' + StringUtils.escape(r.ip || '')
                    + ' · <b>' + (r.pingMs == null ? '—' : (r.pingMs >= 1000 ? (r.pingMs/1000).toFixed(1) + ' с' : r.pingMs + ' мс')) + '</b>';
            } catch (e) {
                el.textContent = 'Недоступно: ' + (e.message || e);
            }
        };
        $('#exitInfoBtn')?.addEventListener('click', run);
        run();
    };

    const initOpenvpn = async () => {
        const det = await UIBridge.invoke('openvpn:detect');
        const el = $('#ovpnDetect');
        if (el) el.textContent = det.ok ? 'найден: ' + det.exe : 'не найден — установите OpenVPN Community';
        $('#vpngateRefreshBtn')?.addEventListener('click', () => loadVpngate(true));
        $('#ovpnImportBtn')?.addEventListener('click', async () => {
            const file = await UIBridge.invoke('openvpn:import');
            if (!file) return;
            InvisUI.showOverlay('Подключаюсь — подтвердите запрос UAC…', { hideOnState: true });
            const r = await UIBridge.invoke('openvpn:connect-file', file);
            if (!r || !r.ok) { InvisUI.hideOverlay(); InvisUI.setStatus((r && r.error) || 'Ошибка подключения', { error: true }); return; }
            const h = $('#ovpnServerHint'); if (h) h.textContent = '· ' + file.split(/[\/]/).pop();
        });
        $('#ovpnDisconnectBtn')?.addEventListener('click', () => {
            InvisUI.setStatus('OpenVPN: отключение…');
            UIBridge.send('openvpn:disconnect');
        });
        loadVpngate(false);
    };

    /* ---------- копия строки прокси ---------- */
    const initCopyProxy = () => {
        $('#copyProxyBtn')?.addEventListener('click', () => {
            const line = 'socks5://127.0.0.1:9050';
            UIBridge.send('proxy:copy');
        });
    };

    /* ---------- Tor: мосты, NEWNYM, диагностика ---------- */
    const syncTorBlock = (s) => {
        const on = Boolean(s?.tor?.useBridges);
        $('#bridgesBlock')?.classList.toggle('is-hidden', !on);
        const ta = $('#setBridges');
        if (ta && document.activeElement !== ta) ta.value = s?.tor?.bridgesText || '';
        const mins = $('#setNewIpMinutes');
        if (mins && document.activeElement !== mins) mins.value = s?.tor?.newIpMinutes || 0;
    };

    const initTor = async () => {
        const current = await UIBridge.invoke('settings:get');
        if (current) syncTorBlock(current);
        UIBridge.on('settings:changed', syncTorBlock);

        $('#setBridges')?.addEventListener('change', (e) => {
            UIBridge.invoke('settings:set', { tor: { bridgesText: e.target.value } });
        });
        $('#fetchBridgesBtn')?.addEventListener('click', async () => {
            const btn = $('#fetchBridgesBtn');
            UIHelpers.setButtonWaiting(btn, true);
            const ta = $('#setBridges');
            const r = await UIBridge.invoke('bridges:fetch', 'obfs4');
            UIHelpers.setButtonWaiting(btn, false);
            if (!r || !r.ok) {
                InvisUI.setStatus(r?.error || 'Не удалось получить мосты', { error: true });
                return;
            }
            if (ta) {
                const existing = ta.value.trim().split(/\r?\n/).filter(Boolean);
                const merged = [...new Set([...existing, ...r.lines])].join('\n');
                ta.value = merged;
                UIBridge.invoke('settings:set', { tor: { bridgesText: merged } });
            }
            InvisUI.setStatus(`Получено мостов: ${r.lines.length}`);
        });
        $('#setNewIpMinutes')?.addEventListener('change', (e) => {
            const n = Math.max(0, Math.round(Number(e.target.value) || 0));
            e.target.value = n;
            UIBridge.invoke('settings:set', { tor: { newIpMinutes: n } });
        });
        $('#torNewIpBtn')?.addEventListener('click', () => {
            InvisUI.setStatus('Tor: запрашиваем новый IP…');
            UIBridge.send('tor:newip');
        });
        UIBridge.on('modules:event', ({ text }) => InvisUI.setStatus(text));
    };

    const initDiag = () => {
        const box = $('#diagBox');
        const btn = $('#diagBtn');
        const render = (r) => {
            if (!box || !r) return;
            const line = (label, v) => {
                if (!v) return '';
                const done = v.detail !== 'проверяю…';
                const cls = !done ? 'log-warn' : (v.ok ? 'log-info' : 'log-error');
                const mark = !done ? ico('loader', 12) : (v.ok ? ico('check', 12) : ico('x', 12));
                return `<span class="${cls}">${mark} ${label}</span>: ${StringUtils.escape(v.detail || '')}`;
            };
            box.innerHTML = [
                line('DNSCrypt', r.dns),
                line('Tor', r.tor),
                line('I2P', r.i2p),
                line('Ваш реальный IP', r.realIp),
                line('IP через Tor', r.torIp),
            ].filter(Boolean).join('<br>');
        };
        $('#diagBtn')?.addEventListener('click', async () => {
            if (box) { box.classList.remove('is-hidden'); box.textContent = 'Проверяю…'; }
            if (btn) btn.disabled = true;
            try {
                const r = await UIBridge.invoke('diag:run');
                render(r);
            } catch (e) {
                if (box) box.innerHTML = `<span class="log-error">${ico('x', 12)} Ошибка проверки: ${StringUtils.escape(e.message || e)}</span>`;
            } finally {
                if (btn) btn.disabled = false;
            }
        });
        /* промежуточные кадры от main — строки появляются по мере готовности */
        UIBridge.on('diag:result', render);
        $('#i2pConsoleBtn')?.addEventListener('click', () => UIBridge.send('open:console-i2p'));
        $('#logsFolderBtn')?.addEventListener('click', () => UIBridge.send('open:logs'));
        $('#ghBtn')?.addEventListener('click', () => UIBridge.send('open:github'));
    };

    /* ---------- авто-обновление ---------- */
    const initUpdate = async () => {
        const badge = $('#updateBadge'), text = $('#updateText'), btn = $('#updateBtn');
        const verEl = $('#brandVersion');
        const cur = { available: false, version: null, downloading: false, percent: 0, readyToInstall: false };

        const render = () => {
            if (cur.downloading) {
                badge?.classList.remove('is-hidden');
                if (text) text.textContent = 'Скачивание…';
                if (btn) { btn.textContent = `${cur.percent}%`; btn.disabled = true; }
                return;
            }
            if (cur.available && cur.version) {
                badge?.classList.remove('is-hidden');
                if (text) text.textContent = `Доступна v${cur.version}`;
                if (btn) {
                    btn.disabled = Boolean(cur.readyToInstall);
                    btn.textContent = cur.readyToInstall ? 'Установка…' : 'Обновить';
                }
                return;
            }
            badge?.classList.add('is-hidden');
        };

        const info = await UIBridge.invoke('app:info');
        if (verEl && info) verEl.textContent = `v${info.version}`;

        const st0 = await UIBridge.invoke('update:state');
        if (st0) {
            cur.available = st0.available; cur.version = st0.version;
            render();
        }

        UIBridge.on('update:available', (d) => {
            cur.available = true; cur.version = d.version;
            render();
            InvisUI.setStatus('Доступна новая версия Invis — можно обновить');
        });
        UIBridge.on('update:progress', (d) => {
            if (d.error) {
                InvisUI.setStatus(`Ошибка обновления: ${d.error}`, { error: true });
                cur.downloading = false; render();
                return;
            }
            cur.downloading = true; cur.percent = d.percent; render();
        });
        UIBridge.on('update:downloaded', () => {
            cur.downloading = false; cur.readyToInstall = true; render();
            InvisUI.showOverlay('Устанавливаю обновление — приложение перезапустится…');
        });
        btn?.addEventListener('click', () => UIBridge.send('update:install'));
    };

    const init = () => {
        CursorFx.init();
        initTitlebar();
        initTabs();
        initModules();
        initSettings();
        initAbout();
        initResolvers();
        initAdapters();
        initQueryLog();
        initUpdate();
        initTor();
        initTorCountries();
        initSpeedTest();
        initQuickCountries();
        initTitlebarSpeed();
        initExitInfo();
        initCopyProxy();
        initDiag();
        setStatus('Готов к работе');
        console.log('Invis UI запущен');
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    /* Публичный мини-апи (для будущей логики демонов) */
    window.InvisUI = { setStatus, setModuleState, showOverlay, hideOverlay };
})();
