/*
 * Кастомный курсор Invis: точка-указатель + кольцо-контур.
 *
 * Наведение на интерактивный элемент — кольцо перетекает в его контур:
 * обводка по границам элемента (+5px зазор) с тем же border-radius,
 * точка сжимается в маленькую метку. Текстовые поля — точка растягивается
 * в «каретку». Клик — кольцо коротко «затягивается».
 *
 * Принципы (по запросу): ничего не перекрывает контент — кольцо это только
 * рамка СНАРУЖИ элемента, точка ≤10px; смысл подписей не дублируется —
 * текстовые глифы data-cursor-text из шаблона удалены (крестили буквы
 * поверх кнопок, у которых уже есть свои иконки/подписи).
 *
 * Производительность: один rAF-цикл, вся позиция через transform
 * (композитор), rect цели кэшируется (обновление при смене цели,
 * scroll/resize и раз в 20 кадров), слой pointer-events:none, при скрытом
 * окне rAF замирает сам. Тач (hover:none) и prefers-reduced-motion —
 * фича не запускается вовсе (системный курсор не скрывается — деградации нет).
 *
 * Из шаблонной версии удалены: шар-лупа (.doc-image-container), ручки
 * rot/scale, селекторы исходного макета (photo-grid, font-selector и пр.) —
 * в Invis их нет.
 */
window.CursorFx = {
    initialized: false,
    init: function () {
        if (CursorFx.initialized) return;
        /* hover:none — тач-устройства, там кастомному курсору места нет.
         * prefers-reduced-motion сознательно НЕ гейтит: эффекты запрошены
         * как фича приложения, а системный курсор не скрывается — при
         * отключённых анимациях Windows просто получаем спокойный морф. */
        if (window.matchMedia('(hover: none)').matches) return;
        CursorFx.initialized = true;

        const layer = document.createElement('div');
        layer.className = 'cursor-layer';
        layer.setAttribute('aria-hidden', 'true');
        layer.innerHTML = '<div class="cursor-ring" id="cursorRing"></div>'
            + '<div class="cursor-ball" id="cursorBall"></div>';
        document.body.appendChild(layer);

        const ring = document.getElementById('cursorRing');
        const ball = document.getElementById('cursorBall');
        if (!ring || !ball) return;

        const PAD = 5;          // зазор контура вокруг элемента
        const K_GEO = 0.32;     // скорость морфа геометрии кольца
        const K_POS = 0.55;     // скорость точки за курсором
        const K_FADE = 0.22;    // появление/угасание

        const pointer = { x: -100, y: -100 };
        let pressed = false;
        let dirty = true;       // нужна ли пересканирование под курсором

        /* Интерактив Invis. Текстовые поля — отдельный режим «каретки». */
        const RING_SEL = [
            'button', 'a[href]', 'select',
            'input[type="checkbox"]', 'input[type="radio"]',
        ].join(',');
        const FIELD_SEL = 'input:not([type]), input[type="text"], input[type="search"],'
            + ' input[type="password"], input[type="number"], input[type="url"], input[type="email"], textarea';

        let target = null;      // элемент под кольцом
        let rect = null;        // кэш его геометрии
        let radius = 12;        // его border-radius (внутри PAD)
        let caretMode = false;  // курсор над текстовым полем
        let frame = 0;

        /* Отрисованное состояние (всё лерпится — морф без CSS-переходов) */
        const r = { x: -100, y: -100, w: 0, h: 0, rad: 12, o: 0 };
        const b = { x: -100, y: -100, w: 10, h: 10, o: 0 };
        let pressT = 0;         // 0..1 — «затягивание» при клике

        const measure = () => {
            if (!target) return;
            rect = target.getBoundingClientRect();
            const bs = getComputedStyle(target);
            const rad = parseFloat(bs.borderTopLeftRadius);
            radius = isFinite(rad) && rad > 0 ? Math.min(rad, rect.height / 2) : 6;
        };

        const underPointer = () => {
            const el = document.elementFromPoint(pointer.x, pointer.y);
            if (!el) return null;
            const field = el.closest(FIELD_SEL);
            if (field) return { el: field, field: true };
            const hit = el.closest(RING_SEL);
            return hit ? { el: hit, field: false } : null;
        };

        document.addEventListener('mousemove', (e) => {
            pointer.x = e.clientX;
            pointer.y = e.clientY;
            dirty = true;
        }, { passive: true });
        document.addEventListener('mousedown', () => { pressed = true; });
        document.addEventListener('mouseup', () => { pressed = false; });
        document.addEventListener('mouseleave', () => {
            pointer.x = -100;
            pointer.y = -100;
            dirty = true;
        });
        /* Скролл/resize мгновенно освежают кэш геометрии активной цели */
        const remeasure = () => { if (target) { measure(); dirty = true; } };
        document.addEventListener('scroll', remeasure, { passive: true, capture: true });
        window.addEventListener('resize', remeasure);

        const tick = () => {
            frame++;

            /* Пересканируем под курсором только при движении/скролле
             * (и изредка для живой цели — элемент мог переехать). Цель
             * хранится между кадрами, иначе морф не успевает начаться. */
            if (dirty || (target && frame % 20 === 0)) {
                const hover = underPointer();
                target = hover && !hover.field ? hover.el : null;
                caretMode = Boolean(hover && hover.field);
                if (target) measure();
                dirty = false;
            }

            /* Появление: курсор на экране? */
            const visible = pointer.x >= 0;

            /* --- точка --- */
            b.x += (pointer.x - b.x) * K_POS;
            b.y += (pointer.y - b.y) * K_POS;
            /* над интерактивом точка — метка 6px, над полем — каретка, иначе 10px */
            const bt = caretMode ? { w: 3.5, h: 26 } : (target ? { w: 6, h: 6 } : { w: 10, h: 10 });
            b.w += (bt.w - b.w) * K_GEO;
            b.h += (bt.h - b.h) * K_GEO;
            b.o += ((visible ? 1 : 0) - b.o) * K_FADE;
            ball.style.transform = `translate3d(${(b.x - b.w / 2).toFixed(2)}px, ${(b.y - b.h / 2).toFixed(2)}px, 0)`;
            ball.style.width = `${b.w.toFixed(2)}px`;
            ball.style.height = `${b.h.toFixed(2)}px`;
            ball.style.opacity = b.o.toFixed(3);
            ball.style.borderRadius = caretMode ? '2px' : '999px';

            /* --- кольцо-контур --- */
            pressT += ((pressed && target ? 1 : 0) - pressT) * 0.35;
            const pad = PAD - pressT * 2.5;   // при клике контур «затягивается»
            if (target && rect) {
                r.x += (rect.left - pad - r.x) * K_GEO;
                r.y += (rect.top - pad - r.y) * K_GEO;
                r.w += (rect.width + pad * 2 - r.w) * K_GEO;
                r.h += (rect.height + pad * 2 - r.h) * K_GEO;
                r.rad += (radius + pad - r.rad) * K_GEO;
                r.o += ((visible ? 1 : 0) - r.o) * K_FADE;
            } else {
                /* растворяется в точке */
                r.x += (b.x - r.w / 2 - r.x) * K_GEO;
                r.y += (b.y - r.h / 2 - r.y) * K_GEO;
                r.w += (0 - r.w) * K_GEO;
                r.h += (0 - r.h) * K_GEO;
                r.o += (0 - r.o) * K_FADE;
            }
            ring.style.transform = `translate3d(${r.x.toFixed(2)}px, ${r.y.toFixed(2)}px, 0)`;
            ring.style.width = `${Math.max(0, r.w).toFixed(2)}px`;
            ring.style.height = `${Math.max(0, r.h).toFixed(2)}px`;
            ring.style.borderRadius = `${r.rad.toFixed(2)}px`;
            ring.style.opacity = r.o.toFixed(3);

            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }
};
