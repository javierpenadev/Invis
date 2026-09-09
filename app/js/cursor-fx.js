/*
 * Кастомный курсор (перенесён из исходника без изменений логики).
 * Рисует "шарик", который тянется к интерактивным элементам,
 * показывает текст из data-cursor-text / data-cursor-dynamic
 * и умеет рисовать "лупу" над .doc-image-container.
 */
window.CursorFx = {
    initialized: false,
    init: function () {
        if (CursorFx.initialized || window.matchMedia('(hover: none)').matches) return;
        CursorFx.initialized = true;

        const layer = document.createElement('div');
        layer.className = 'cursor-layer';
        layer.setAttribute('aria-hidden', 'true');
        layer.innerHTML = `
            <div class="cursor-ball" id="cursorBall">
                <div class="cursor-lens" id="cursorLens"></div>
                <div class="cursor-label" id="cursorLabel"></div>
            </div>
        `;
        document.body.appendChild(layer);

        const ball = document.getElementById('cursorBall');
        const lens = document.getElementById('cursorLens');
        const label = document.getElementById('cursorLabel');
        if (!ball || !lens || !label) return;

        const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        const render = { x: pointer.x, y: pointer.y };
        const size = { width: 12, height: 12 };
        const smoothness = 0.9;
        let textOpacity = 0;
        let currentText = '';
        let lensSource = null;
        let lensClone = null;
        let lensVersion = '';
        const lensZoom = 2;

        const getInteractiveTarget = () => {
            const hovered = document.elementFromPoint(pointer.x, pointer.y);
            if (!hovered) return null;
            return hovered.closest([
                '[data-cursor-text]',
                '[data-cursor-dynamic]',
                '.side-btn',
                '.action-btn',
                '.titlebar-btn',
                '.reset-btn',
                '.random-btn',
                '.styled-select-trigger',
                '.photo-grid-trigger',
                '.font-selector-trigger',
                '.photo-grid-item',
                '.font-selector-item',
                '.styled-select-item',
                'input[type="range"]',
                '#rotHandle',
                '#scaleHandle',
                'button',
                'a',
                'select'
            ].join(','));
        };

        const getDynamicText = (target) => {
            const mode = target.dataset.cursorDynamic;
            if (mode === 'select-value' && target instanceof HTMLSelectElement) {
                return target.options[target.selectedIndex]?.textContent?.trim() || '';
            }
            if (mode === 'range-value' && target instanceof HTMLInputElement && target.type === 'range') {
                const unit = target.dataset.cursorUnit || '';
                return `${target.value}${unit}`;
            }
            if (mode === 'trigger-value') {
                if (target.matches('.photo-grid-trigger')) {
                    return target.querySelector('.photo-grid-label')?.textContent?.trim() || '';
                }
                if (target.matches('.font-selector-trigger')) {
                    return target.querySelector('small')?.textContent?.trim() || '';
                }
                if (target.matches('.styled-select-trigger')) {
                    return target.querySelector('span')?.textContent?.trim() || '';
                }
                const labelNode = target.querySelector('.photo-grid-label, small, span');
                return labelNode?.textContent?.trim() || target.textContent?.trim() || '';
            }
            if (mode === 'handle-icon') {
                return target.dataset.cursorText || target.textContent?.trim() || '';
            }
            return '';
        };

        const getTargetText = (target, hovered, hoveredCursor) => {
            if (!target) return '';
            if (hoveredCursor === 'grab' || hoveredCursor === 'grabbing') {
                return target.dataset.cursorGrab || '';
            }
            if (target.dataset.cursorDynamic) return getDynamicText(target);
            if (target instanceof HTMLInputElement && target.type === 'range') {
                const unit = target.dataset.cursorUnit || '';
                return `${target.value}${unit}`;
            }
            if (target.dataset.cursorText) return target.dataset.cursorText;
            if (target instanceof HTMLSelectElement) {
                return target.options[target.selectedIndex]?.textContent?.trim() || '';
            }
            return target.textContent?.trim() || target.getAttribute('title') || hovered?.getAttribute('title') || '';
        };

        const isButtonLikeTarget = (target) =>
            Boolean(target?.matches('.side-btn, .action-btn, .titlebar-btn, .reset-btn, .random-btn, button, a, .styled-select-trigger, .photo-grid-trigger, .font-selector-trigger'));

        const getLensSource = (hovered) => {
            if (!hovered) return null;
            return hovered.closest('.doc-image-container')
                || hovered.closest('#docImg')
                || null;
        };

        const getLensVersion = (source) => {
            if (source.matches('.doc-image-container')) {
                const image = source.querySelector('#docImage');
                const overlay = source.querySelector('#overlayTexts');
                return [
                    image?.src || '',
                    image?.style.cssText || '',
                    overlay?.textContent || '',
                    overlay?.children.length || 0
                ].join('|');
            }
            return [
                source.getAttribute('src') || '',
                source.getAttribute('style') || '',
                source.getBoundingClientRect().width,
                source.getBoundingClientRect().height
            ].join('|');
        };

        const stripCloneIds = (root) => {
            root.removeAttribute('id');
            root.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
        };

        const syncLens = (source) => {
            if (!source) {
                lensSource = null;
                lensClone = null;
                lensVersion = '';
                lens.innerHTML = '';
                return;
            }

            const rect = source.getBoundingClientRect();
            const version = getLensVersion(source);
            if (source !== lensSource || version !== lensVersion || !lensClone) {
                lensSource = source;
                lensVersion = version;
                lens.innerHTML = '';
                lensClone = source.cloneNode(true);
                stripCloneIds(lensClone);
                lensClone.classList.add('cursor-lens-source');
                lensClone.style.position = 'absolute';
                lensClone.style.left = '0';
                lensClone.style.top = '0';
                lensClone.style.width = `${rect.width}px`;
                lensClone.style.height = `${rect.height}px`;
                lensClone.style.margin = '0';
                lensClone.style.pointerEvents = 'none';
                lensClone.style.transformOrigin = '0 0';
                lensClone.style.overflow = 'hidden';
                if (source instanceof HTMLImageElement && lensClone instanceof HTMLImageElement) {
                    lensClone.style.transform = 'none';
                    lensClone.style.objectFit = 'fill';
                    lensClone.style.maxWidth = 'none';
                    lensClone.style.borderRadius = '0';
                    lensClone.draggable = false;
                }
                lens.appendChild(lensClone);
            }

            if (!lensClone) return;
            lensClone.scrollLeft = source.scrollLeft;
            lensClone.scrollTop = source.scrollTop;
            const relX = pointer.x - rect.left;
            const relY = pointer.y - rect.top;
            lensClone.style.left = `${size.width / 2 - relX * lensZoom}px`;
            lensClone.style.top = `${size.height / 2 - relY * lensZoom}px`;
            lensClone.style.transform = `scale(${lensZoom})`;
        };

        const apply = () => {
            const hovered = document.elementFromPoint(pointer.x, pointer.y);
            const hoveredStyle = hovered ? getComputedStyle(hovered) : null;
            const hoveredCursor = hoveredStyle?.cursor || 'default';
            const target = getInteractiveTarget();
            const rect = target?.getBoundingClientRect();
            const fieldTarget = Boolean(target?.matches('.doc-text-field[data-cursor-shape="field"]'));
            const grabTarget = hoveredCursor === 'grab' || hoveredCursor === 'grabbing';
            const lensSourceTarget = grabTarget && !fieldTarget ? getLensSource(hovered) : null;
            const lensActive = Boolean(lensSourceTarget);
            const focusPoint = rect
                ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
                : { x: pointer.x, y: pointer.y };

            render.x = render.x * smoothness + focusPoint.x * (1 - smoothness);
            render.y = render.y * smoothness + focusPoint.y * (1 - smoothness);
            ball.style.left = `${render.x}px`;
            ball.style.top = `${render.y}px`;

            const targetWidth = rect?.width || 0;
            const targetHeight = rect?.height || 0;
            const targetArea = targetWidth * targetHeight;
            const largeTarget = targetArea > 36000;
            const buttonLike = isButtonLikeTarget(target);
            const nextSize = fieldTarget && rect
                ? {
                    width: Math.max(48, targetWidth + 20),
                    height: Math.max(28, targetHeight + 18)
                }
                : target
                    ? largeTarget
                        ? { width: currentText ? 56 : 24, height: currentText ? 56 : 24 }
                        : buttonLike
                            ? {
                                width: Math.max(24, Math.min(72, targetWidth * 0.42 || 24)),
                                height: Math.max(24, Math.min(72, targetWidth * 0.42 || 24))
                            }
                            : {
                                width: Math.max(24, Math.min(64, Math.max(targetWidth, targetHeight) + 8)),
                                height: Math.max(24, Math.min(64, Math.max(targetWidth, targetHeight) + 8))
                            }
                    : hoveredCursor === 'pointer'
                        ? { width: 24, height: 24 }
                        : grabTarget
                            ? { width: 48, height: 48 }
                            : { width: 12, height: 12 };

            size.width = size.width * smoothness + nextSize.width * (1 - smoothness);
            size.height = size.height * smoothness + nextSize.height * (1 - smoothness);
            ball.style.width = `${size.width}px`;
            ball.style.height = `${size.height}px`;

            const isLightTarget = Boolean(target?.matches('.action-btn.primary, .help-badge, #rotHandle, #scaleHandle'));
            ball.classList.toggle('is-light', isLightTarget && !fieldTarget && !grabTarget);
            ball.classList.toggle('is-ring', grabTarget);
            ball.classList.toggle('is-field-target', fieldTarget);
            ball.classList.toggle('is-lens', lensActive);
            syncLens(lensSourceTarget);

            const nextText = getTargetText(target, hovered, hoveredCursor);
            if (nextText !== currentText) {
                currentText = nextText;
                label.textContent = currentText;
            }

            const desiredOpacity = currentText ? 1 : 0;
            textOpacity = desiredOpacity < 0.001 ? 0 : textOpacity * smoothness + desiredOpacity * (1 - smoothness);
            label.style.opacity = String(textOpacity);

            requestAnimationFrame(apply);
        };

        document.addEventListener('mousemove', (event) => {
            pointer.x = event.clientX;
            pointer.y = event.clientY;
        });

        requestAnimationFrame(apply);
    }
};
