const OUTPUT_SIZE = 250;
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

export function cropBounds(width, height, zoom, centerX, centerY) {
    const size = Math.min(width, height) / zoom;
    return {
        x: Math.min(width - size, Math.max(0, centerX - size / 2)),
        y: Math.min(height - size, Math.max(0, centerY - size / 2)),
        size,
    };
}

export function cropThumbnail(file, createModal, signal, onPaste) {
    if (!file?.type?.startsWith('image/')) return Promise.reject(new Error('That file is not an image.'));
    if (signal.aborted) return Promise.resolve(null);

    return new Promise((resolve, reject) => {
        const image = new Image();
        const pointers = new Map();
        let sourceUrl = '';
        let frame = 0;
        let zoom = MIN_ZOOM;
        let centerX = 0;
        let centerY = 0;
        let crop = null;
        let result = null;
        let failure;
        const abort = () => modal.__forceClose();
        const modal = createModal({
            title: 'Crop Thumbnail',
            body: `<div class="st-codex-modal-body st-codex-crop">
                <p class="st-codex-hint" id="st-codex-crop-hint">Drag the square preview or use the arrow keys to reposition. Use the slider, scroll, or pinch to zoom.</p>
                <div class="st-codex-crop-views">
                    <div>
                        <div class="st-codex-label">Original</div>
                        <div class="st-codex-crop-original"><span aria-hidden="true"></span></div>
                    </div>
                    <div>
                        <div class="st-codex-label">Thumbnail preview</div>
                        <canvas class="st-codex-crop-preview" width="360" height="360" tabindex="0"
                            aria-label="Reposition thumbnail crop" aria-describedby="st-codex-crop-hint"></canvas>
                    </div>
                </div>
                <label class="st-codex-crop-zoom">
                    <span>Zoom</span>
                    <input type="range" min="${MIN_ZOOM}" max="${MAX_ZOOM}" step="0.01" value="${MIN_ZOOM}" disabled>
                    <output>100%</output>
                </label>
                <div class="st-codex-hint st-codex-crop-loading" role="status">Loading image…</div>
            </div>`,
            footer: `<div class="st-codex-modal-foot">
                <div class="st-codex-foot-spacer"></div>
                <button class="st-codex-btn st-codex-btn-cancel" data-crop-cancel type="button">Cancel</button>
                <button class="st-codex-btn st-codex-btn-primary" data-crop-confirm type="button" disabled>Confirm Crop</button>
            </div>`,
            onClose: () => {
                signal.removeEventListener('abort', abort);
                cancelAnimationFrame(frame);
                image.onload = image.onerror = null;
                image.removeAttribute('src');
                if (sourceUrl) URL.revokeObjectURL(sourceUrl);
                if (failure) reject(failure);
                else resolve(result);
            },
        });
        const preview = modal.querySelector('canvas');
        const original = modal.querySelector('.st-codex-crop-original');
        const outline = original.querySelector('span');
        const slider = modal.querySelector('input[type="range"]');
        const zoomReadout = modal.querySelector('output');
        const confirm = modal.querySelector('[data-crop-confirm]');
        const cancel = modal.querySelector('[data-crop-cancel]');
        const loading = modal.querySelector('.st-codex-crop-loading');
        image.alt = '';

        const paint = () => {
            frame = 0;
            const context = preview.getContext('2d');
            context.clearRect(0, 0, preview.width, preview.height);
            context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, preview.width, preview.height);
            outline.style.left = `${100 * crop.x / image.naturalWidth}%`;
            outline.style.top = `${100 * crop.y / image.naturalHeight}%`;
            outline.style.width = `${100 * crop.size / image.naturalWidth}%`;
            outline.style.height = `${100 * crop.size / image.naturalHeight}%`;
            slider.value = String(zoom);
            zoomReadout.textContent = `${Math.round(zoom * 100)}%`;
        };
        const adjust = (nextZoom, dx = 0, dy = 0) => {
            zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
            crop = cropBounds(image.naturalWidth, image.naturalHeight, zoom, centerX + dx, centerY + dy);
            centerX = crop.x + crop.size / 2;
            centerY = crop.y + crop.size / 2;
            if (!frame) frame = requestAnimationFrame(paint);
        };
        const fail = error => {
            failure = error;
            modal.__forceClose();
        };

        image.onload = () => {
            if (!image.naturalWidth || !image.naturalHeight) {
                fail(new Error('This image has no usable dimensions.'));
                return;
            }
            centerX = image.naturalWidth / 2;
            centerY = image.naturalHeight / 2;
            original.style.maxWidth = `${190 * image.naturalWidth / image.naturalHeight}px`;
            original.prepend(image);
            adjust(MIN_ZOOM);
            loading.hidden = true;
            slider.disabled = false;
            confirm.disabled = false;
        };
        image.onerror = () => fail(new Error('Could not decode the image file.'));
        signal.addEventListener('abort', abort, { once: true });
        cancel.addEventListener('click', () => modal.__forceClose());
        if (onPaste) modal.addEventListener('paste', onPaste);
        cancel.focus();

        slider.addEventListener('input', () => adjust(Number(slider.value)));
        preview.addEventListener('wheel', event => {
            if (!crop) return;
            event.preventDefault();
            adjust(zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08));
        }, { passive: false });
        preview.addEventListener('keydown', event => {
            if (!crop) return;
            const step = crop.size * (event.shiftKey ? 0.12 : 0.03);
            const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
            if (!Object.hasOwn(moves, event.key)) return;
            event.preventDefault();
            adjust(zoom, ...moves[event.key]);
        });
        preview.addEventListener('pointerdown', event => {
            if (!crop || event.button !== 0 || pointers.size >= 2) return;
            pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
            preview.setPointerCapture(event.pointerId);
        });
        preview.addEventListener('pointermove', event => {
            const previous = pointers.get(event.pointerId);
            if (!previous) return;
            const next = { x: event.clientX, y: event.clientY };
            pointers.set(event.pointerId, next);
            const other = [...pointers].find(([id]) => id !== event.pointerId)?.[1];
            const scale = crop.size / preview.getBoundingClientRect().width;
            const pan = other ? scale / 2 : scale;
            let nextZoom = zoom;
            if (other) {
                const before = Math.hypot(previous.x - other.x, previous.y - other.y);
                const after = Math.hypot(next.x - other.x, next.y - other.y);
                if (before > 0 && after > 0) nextZoom *= after / before;
            }
            adjust(nextZoom, (previous.x - next.x) * pan, (previous.y - next.y) * pan);
        });
        preview.addEventListener('lostpointercapture', event => pointers.delete(event.pointerId));
        confirm.addEventListener('click', () => {
            if (!crop) return;
            try {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = OUTPUT_SIZE;
                const context = canvas.getContext('2d');
                context.imageSmoothingQuality = 'high';
                context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
                let webp;
                try { webp = canvas.toDataURL('image/webp', 0.8); }
                catch { /* Try the browser's default PNG encoder. */ }
                result = webp?.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
                if (!result.startsWith('data:image/')) throw new Error('Could not encode the thumbnail.');
                modal.__forceClose();
            } catch {
                fail(new Error('Could not process the thumbnail crop.'));
            }
        });

        try {
            sourceUrl = URL.createObjectURL(file);
            image.src = sourceUrl;
        } catch {
            fail(new Error('Could not open the image file.'));
        }
    });
}
