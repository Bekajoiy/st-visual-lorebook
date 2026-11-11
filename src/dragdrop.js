/**
 * dragdrop.js — HTML5 drag & drop for entry cards and category sections.
 *
 * Entry drops rewrite `extensions.visual_lorebook.sortOrder` (and categoryId
 * when crossing sections); category drops rewrite the category `order` array.
 * Both persist through the app's save pipeline.
 */

import { applyOrder, entryUid, findEntry, getEntryVisual, setCategories, setEntryVisual, sortedEntries } from './store.js';

let drag = null;
let lastIndicator = null;
let lastCardTarget = null;
let dropping = false;

export function installDragDrop(app, root) {
    if (!root || root.dataset.dndBound === '1') return;
    root.dataset.dndBound = '1';

    root.addEventListener('dragstart', event => onDragStart(app, event));
    root.addEventListener('dragover', event => onDragOver(app, event));
    root.addEventListener('dragleave', event => onDragLeave(event));
    root.addEventListener('drop', event => onDrop(app, event));
    root.addEventListener('dragend', () => cleanup());

    // A drag released outside the panel (or cancelled by Alt+Tab) never fires
    // `dragend` on the list, which would leave the drag state and the ghost
    // classes stuck until the next drag.
    window.addEventListener('dragend', () => cleanup(), true);
    window.addEventListener('drop', () => setTimeout(cleanup, 0), true);
    window.addEventListener('blur', () => cleanup());
}

/* ---------------------------------------------------------------- drag start */

function onDragStart(app, event) {
    if (app.busy || dropping || document.querySelector('.st-codex-modal-backdrop')) { event.preventDefault(); return; }
    // The enable/disable switch and the selection tick must not start a drag.
    if (event.target.closest('.st-codex-switch, .st-codex-pick, .st-codex-keys, .st-codex-preview-trigger, .st-codex-section-edit, .st-codex-section-add, .st-codex-duplicate')) {
        event.preventDefault();
        return;
    }

    const card = event.target.closest('.st-codex-card');
    if (card) {
        drag = { type: 'entry', uid: card.dataset.uid, catId: card.dataset.cat, el: card, data: app.data };
        card.classList.add('st-codex-dragging');
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', card.dataset.uid);
        }
        return;
    }

    const head = event.target.closest('.st-codex-section-head');
    if (head) {
        drag = { type: 'category', catId: head.dataset.cat, el: head, data: app.data };
        head.classList.add('st-codex-dragging');
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', `cat:${head.dataset.cat}`);
        }
    }
}

/* -------------------------------------------------------------------- hover */

function onDragOver(app, event) {
    if (!drag) return;

    if (drag.type === 'entry') {
        const grid = event.target.closest('.st-codex-grid') || event.target.closest('.st-codex-section')?.querySelector('.st-codex-grid');
        if (!grid) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';

        const section = grid.closest('.st-codex-section');
        markSectionTarget(section);
        markCardTarget(grid, event, drag.uid);
        return;
    }

    if (drag.type === 'category') {
        const section = event.target.closest('.st-codex-section');
        if (!section || section.dataset.cat === drag.catId) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        markSectionTarget(section);
    }
}

function markSectionTarget(section) {
    if (lastIndicator?.el && lastIndicator.el !== section) {
        lastIndicator.el.classList.remove('st-codex-drop-target');
        lastIndicator.el = null;
    }
    if (!section) return;
    section.classList.add('st-codex-drop-target');
    lastIndicator = { el: section };
}

function markCardTarget(grid, event, draggedUid) {
    const card = event.target.closest('.st-codex-card');
    // Only touch the previously marked node instead of rewriting classes on
    // every card in the grid (O(N) DOM writes per dragover with 300 entries).
    if (lastCardTarget && lastCardTarget !== card) {
        lastCardTarget.classList.remove('st-codex-drop-before', 'st-codex-drop-after');
        lastCardTarget = null;
    }
    if (!card || card.dataset.uid === draggedUid) return;
    const rect = card.getBoundingClientRect();
    const horizontal = event.clientX > rect.left + rect.width / 2;
    const vertical = event.clientY > rect.top + rect.height / 2;
    const after = rect.width > 260 ? horizontal : vertical;
    card.classList.toggle('st-codex-drop-before', !after);
    card.classList.toggle('st-codex-drop-after', after);
    lastCardTarget = card;
}

function onDragLeave(event) {
    if (event.target !== event.currentTarget) return;
    if (lastIndicator?.el) {
        lastIndicator.el.classList.remove('st-codex-drop-target');
        lastIndicator.el = null;
    }
}

/* --------------------------------------------------------------------- drop */

async function onDrop(app, event) {
    if (!drag || !app.data || drag.data !== app.data || app.busy || dropping) {
        cleanup();
        return;
    }

    if (drag.type === 'entry') {
        const grid = event.target.closest('.st-codex-grid') || event.target.closest('.st-codex-section')?.querySelector('.st-codex-grid');
        if (!grid) {
            cleanup();
            return;
        }
        event.preventDefault();
        const targetCat = grid.dataset.cat || 'uncategorized';
        const hovered = event.target.closest('.st-codex-card');
        if (hovered && String(hovered.dataset.uid) === String(drag.uid)) {
            cleanup();
            return;
        }
        const after = hovered?.classList.contains('st-codex-drop-after');
        const uid = drag.uid;
        await persistDrop(app, () => reorderEntry(app, uid, targetCat, hovered?.dataset.uid, Boolean(after)), true);
        return;
    }

    if (drag.type === 'category') {
        const section = event.target.closest('.st-codex-section');
        if (!section) {
            cleanup();
            return;
        }
        event.preventDefault();
        const rect = section.getBoundingClientRect();
        const after = event.clientY > rect.top + rect.height / 2;
        const catId = drag.catId;
        await persistDrop(app, () => reorderCategory(app, catId, section.dataset.cat, after));
    }
}

async function persistDrop(app, mutate, changesEntries = false) {
    const data = app.data;
    const entries = data.entries;
    const extensions = data.extensions;
    const hadExtensions = Object.hasOwn(data, 'extensions');
    let saved = false;
    dropping = true;
    try {
        // Clone entry shells/metadata, retaining immutable content strings. Drag
        // operations never need to clone or reconstruct native field payloads.
        if (changesEntries) data.entries = Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key,
            entry && typeof entry === 'object' && !Array.isArray(entry)
                ? {...entry, ...(Object.hasOwn(entry, 'extensions') ? {extensions: structuredClone(entry.extensions)} : {})} : entry,
        ]));
        if (hadExtensions) data.extensions = structuredClone(extensions);
        if (mutate() === false) return;
        saved = await app.saveNow();
    } catch (error) {
        app.toast(error.message || 'Could not save the new order.', true);
    } finally {
        if (!saved) {
            data.entries = entries;
            if (hadExtensions) data.extensions = extensions;
            else delete data.extensions;
        }
        dropping = false;
        cleanup();
        app.render();
    }
}

function reorderEntry(app, uid, targetCat, targetUid, after) {
    const data = app.data;
    const entry = findEntry(data, uid);
    if (!entry) return false;

    const sourceCat = getEntryVisual(entry).categoryId;

    // Current visual order of the destination category, minus the dragged card.
    const order = sortedEntries(data)
        .filter(({ entry: item }) => getEntryVisual(item).categoryId === targetCat && entryUid(item) && entryUid(item) !== uid)
        .map(({ entry: item }) => entryUid(item));

    let index = order.length;
    if (targetUid && String(targetUid) !== String(uid)) {
        const found = order.indexOf(String(targetUid));
        if (found !== -1) index = after ? found + 1 : found;
    }
    order.splice(index, 0, String(uid));

    setEntryVisual(entry, { categoryId: targetCat });
    applyOrder(data, targetCat, order);

    // Compact the source category so its sortOrder values stay contiguous.
    if (sourceCat !== targetCat) {
        const sourceOrder = sortedEntries(data)
            .filter(({ entry: item }) => getEntryVisual(item).categoryId === sourceCat && entryUid(item))
            .map(({ entry: item }) => entryUid(item));
        applyOrder(data, sourceCat, sourceOrder);
    }
}

function reorderCategory(app, draggedId, targetId, after) {
    if (draggedId === targetId) return false;
    const data = app.data;
    const cats = [...app.categories];
    const from = cats.findIndex(cat => cat.id === draggedId);
    if (from === -1) return false;
    const [moved] = cats.splice(from, 1);
    let to = cats.findIndex(cat => cat.id === targetId);
    if (to === -1) return false;
    if (after) to += 1;
    cats.splice(to, 0, moved);
    setCategories(data, cats);
    app.state.categories = cats;
}

/* ------------------------------------------------------------------ cleanup */

function cleanup() {
    lastCardTarget = null;
    document.querySelectorAll('.st-codex-dragging').forEach(el => el.classList.remove('st-codex-dragging'));
    document.querySelectorAll('.st-codex-drop-before, .st-codex-drop-after').forEach(el => {
        el.classList.remove('st-codex-drop-before', 'st-codex-drop-after');
    });
    if (lastIndicator?.el) lastIndicator.el.classList.remove('st-codex-drop-target');
    lastIndicator = null;
    drag = null;
}
