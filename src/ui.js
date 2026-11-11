/**
 * ui.js — the full-screen Codex dashboard.
 *
 * Layout: header · collapsible left rail (library filters/stats) · main column
 * (filter pills, card sections, selection bar) · collapsible right rail
 * (selection, sorting, display options).
 *
 * Owns all view state and persists every mutation through store.js.
 */

import {
    createBook,
    countContentTokens,
    deleteEntries,
    entryContent,
    entrySubtitle,
    entryTitle,
    entryUid,
    escapeHtml,
    findEntry,
    getActiveWorldName,
    getCategories,
    getEntryVisual,
    hasBookChanges,
    hadNativeChangesOnLoad,
    isBookStale,
    isSameBookVersion,
    listWorlds,
    loadBook,
    nextSortOrder,
    sanitizeColor,
    sanitizeImageSrc,
    saveBook,
    setEntryDisabled,
    setEntryVisual,
    sortedEntries,
    truncate,
    updateCategory,
} from './store.js';
import { openEntryEditor, openCategoryManager, openCategoryEditor, confirmDialog, setModalCloseHook } from './editor.js';
import { installDragDrop } from './dragdrop.js';
import { installCardPreviews } from './previews.js';

const PREFS_KEY = 'st-codex-ui-prefs-v2';

export const state = {
    worldName: '',
    data: null,
    categories: [],
    activeCategory: 'all',
    search: '',
    statusFilter: 'all',
    showEmptyCategories: true,
    selectionMode: false,
    selected: new Set(),
    compact: false,
    leftCollapsed: false,
    rightCollapsed: false,
    loading: false,
    mounted: false,
    lastSaveAt: 0,
    // True when local edits have not been written yet. Used to decide whether
    // closing the Codex should write at all.
    dirty: false,
};

export const els = {};

let saveTimer = null;
let searchTimer = null;
let pendingSaves = 0;
let autosaveWaiting = false;
let saveRevision = 0;
let lastRenderedCount = 0;
let pendingReload = false;
let openBookGeneration = 0;
let toastEl = null;
let toastTimer = null;
let bulkSaving = false;
let tokenData = null;
let tokenRun = 0;
let tokenCounting = false;
let tokenCountsVisible = false;
const tokenCounts = new Map();
const tokenAttempts = new Map();
let tokenTimer = null;
let tokenPromise = null;
let mobileRail = null;
let sorting = false;
let cardPreviews;

/* ----------------------------------------------------------- view options */

function loadPrefs() {
    let raw = {};
    try {
        raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
    } catch {
        raw = {};
    }
    // Both rails start open on the very first run; afterwards the saved state wins.
    state.compact = Boolean(raw.compact);
    state.leftCollapsed = Boolean(raw.leftCollapsed);
    state.rightCollapsed = Boolean(raw.rightCollapsed);
    state.statusFilter = ['all', 'enabled', 'disabled'].includes(raw.statusFilter) ? raw.statusFilter : 'all';
    state.showEmptyCategories = raw.showEmptyCategories !== false;
}

function savePrefs() {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({
            compact: state.compact,
            leftCollapsed: state.leftCollapsed,
            rightCollapsed: state.rightCollapsed,
            statusFilter: state.statusFilter,
            showEmptyCategories: state.showEmptyCategories,
        }));
    } catch {
        /* storage unavailable — non-fatal */
    }
}

/* --------------------------------------------------------------- public app */

export const app = {
    state,
    get worldName() {
        return state.worldName;
    },
    get data() {
        return state.data;
    },
    get categories() {
        return state.categories;
    },
    get busy() { return pendingSaves > 0 || bulkSaving || sorting || state.loading; },
    save,
    saveNow: flushSave,
    saveBeforeLeaving,
    render,
    toast,
    reload: reloadCurrentBook,
    openEditor(entry) {
        openEntryEditor(app, entry);
    },
};

/* ------------------------------------------------------------------ mounting */

export function mount() {
    if (state.mounted) return;
    state.mounted = true;
    loadPrefs();
    const railToggle = (id, label) => `<label class="st-codex-rail-setting">
        <span>${label}</span><span class="st-codex-tog">
            <input type="checkbox" role="switch" id="${id}">
            <span class="st-codex-tog-track" aria-hidden="true"><span></span></span>
        </span></label>`;

    const overlay = document.createElement('div');
    overlay.className = 'st-codex-overlay st-codex-hidden';
    overlay.id = 'st-codex-overlay';
    overlay.innerHTML = `
        <div class="st-codex-header">
            <div class="st-codex-brand">
                <i class="fa-solid fa-book-atlas"></i><span>Codex</span>
            </div>
            <select class="st-codex-world-select" id="st-codex-world-select" title="Select a lorebook"></select>
            <button class="st-codex-btn st-codex-icon-only" id="st-codex-new-book" title="Create a new lorebook">
                <i class="fa-solid fa-plus"></i>
            </button>
            <div class="st-codex-search">
                <i class="fa-solid fa-magnifying-glass"></i>
                <input type="text" id="st-codex-search" placeholder="Search titles, content or trigger keys…" autocomplete="off" />
            </div>
            <div class="st-codex-header-actions">
                <button class="st-codex-btn" id="st-codex-manage-categories" title="Manage categories" aria-label="Manage categories">
                    <i class="fa-solid fa-tags"></i><span>Manage Categories</span>
                </button>
                <button class="st-codex-btn st-codex-icon-only" id="st-codex-close" title="Close (Esc)">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        </div>

        <div class="st-codex-body">
            <aside class="st-codex-rail st-codex-rail-left" id="st-codex-rail-left">
                <button class="st-codex-rail-toggle" data-rail="left" title="Toggle the library panel">
                    <i class="fa-solid fa-angles-left"></i>
                </button>
                <div class="st-codex-rail-inner">
                    <div class="st-codex-rail-block">
                        <div class="st-codex-rail-title">Library</div>
                        <dl class="st-codex-stats" id="st-codex-stats"></dl>
                        <button class="st-codex-btn st-codex-btn-sm" id="st-codex-count-tokens" type="button">Count tokens</button>
                        <span class="st-codex-hint">Counted automatically in the background. Includes disabled entries. Refresh after changing tokenizer.</span>
                    </div>
                    <div class="st-codex-rail-block">
                        <div class="st-codex-rail-title">Status</div>
                        <div class="st-codex-segmented" id="st-codex-status-filter">
                            <button type="button" data-status="all">All</button>
                            <button type="button" data-status="enabled">Enabled</button>
                            <button type="button" data-status="disabled">Disabled</button>
                        </div>
                    </div>
                    <div class="st-codex-rail-block">
                        ${railToggle('st-codex-show-empty', 'Show empty categories')}
                    </div>
                    <div class="st-codex-rail-block">
                        <div class="st-codex-rail-title">Shortcuts</div>
                        <ul class="st-codex-shortcuts">
                            <li><kbd>Esc</kbd> close the Codex</li>
                            <li><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> toggle it</li>
                            <li>Drag a card to reorder / recategorise</li>
                            <li>Drag a section header to reorder categories</li>
                        </ul>
                    </div>
                </div>
            </aside>

            <section class="st-codex-main">
                <div class="st-codex-main-tools">
                    <button class="st-codex-btn st-codex-btn-sm" id="st-codex-bulk-edit" type="button" aria-pressed="false" aria-controls="st-codex-selbar">Bulk edit</button>
                    <span class="st-codex-hint" id="st-codex-bulk-hint">Move, enable or disable multiple entries.</span>
                </div>
                <div class="st-codex-selbar" id="st-codex-selbar" hidden>
                    <span class="st-codex-selcount" id="st-codex-selcount">0 selected</span>
                    <button class="st-codex-btn st-codex-btn-sm" id="st-codex-sel-clear" type="button">Clear</button>
                    <select class="st-codex-select st-codex-bulk-category" id="st-codex-sel-category" aria-label="Move selected entries to category"></select>
                    <button class="st-codex-btn st-codex-btn-sm" id="st-codex-sel-move" type="button">Move</button>
                    <button class="st-codex-btn st-codex-btn-sm" id="st-codex-sel-enable" type="button">Enable</button>
                    <button class="st-codex-btn st-codex-btn-sm" id="st-codex-sel-disable" type="button">Disable</button>
                    <div class="st-codex-foot-spacer"></div>
                    <button class="st-codex-btn st-codex-btn-sm st-codex-btn-danger" id="st-codex-sel-delete" type="button">
                        <i class="fa-solid fa-trash"></i> Delete selected
                    </button>
                </div>
                <div class="st-codex-pillbar" id="st-codex-pillbar"></div>
                <div class="st-codex-scroll" id="st-codex-scroll"></div>
            </section>

            <aside class="st-codex-rail st-codex-rail-right" id="st-codex-rail-right">
                <button class="st-codex-rail-toggle" data-rail="right" title="Toggle the options panel">
                    <i class="fa-solid fa-angles-right"></i>
                </button>
                <div class="st-codex-rail-inner">
                    <div class="st-codex-rail-block">
                        <div class="st-codex-rail-title">Bulk editing</div>
                        ${railToggle('st-codex-selection-mode', 'Select multiple entries')}
                        <label class="st-codex-select-visible">
                            <input id="st-codex-select-all" type="checkbox">
                            <span>Select all visible</span>
                        </label>
                        <span class="st-codex-hint">Select cards, then use Move, Enable or Disable above the grid.</span>
                    </div>
                    <div class="st-codex-rail-block">
                        <div class="st-codex-sort-heading"><span class="st-codex-rail-title">Sort</span><span class="st-codex-hint">or drag &amp; drop</span></div>
                        <button class="st-codex-btn st-codex-btn-sm st-codex-rail-btn" id="st-codex-sort-title" type="button">
                            Title A→Z
                        </button>
                        <button class="st-codex-btn st-codex-btn-sm st-codex-rail-btn" id="st-codex-sort-title-desc" type="button">Title Z→A</button>
                        <button class="st-codex-btn st-codex-btn-sm st-codex-rail-btn" id="st-codex-sort-tokens" type="button">Tokens high→low</button>
                    </div>
                    <div class="st-codex-rail-block">
                        <div class="st-codex-rail-title">Display</div>
                        ${railToggle('st-codex-compact', 'Compact cards')}
                    </div>
                    <div class="st-codex-rail-block">
                        <div class="st-codex-rail-title">Info</div>
                        <p class="st-codex-rail-info" id="st-codex-info"></p>
                    </div>
                </div>
            </aside>
        </div>
    `;
    document.body.appendChild(overlay);

    els.overlay = overlay;
    els.worldSelect = overlay.querySelector('#st-codex-world-select');
    els.pillbar = overlay.querySelector('#st-codex-pillbar');
    els.scroll = overlay.querySelector('#st-codex-scroll');
    els.search = overlay.querySelector('#st-codex-search');
    els.selbar = overlay.querySelector('#st-codex-selbar');
    els.selcount = overlay.querySelector('#st-codex-selcount');
    els.stats = overlay.querySelector('#st-codex-stats');
    els.info = overlay.querySelector('#st-codex-info');
    els.railLeft = overlay.querySelector('#st-codex-rail-left');
    els.railRight = overlay.querySelector('#st-codex-rail-right');

    els.worldSelect.addEventListener('change', async () => {
        const name = els.worldSelect.value;
        if (!name || name === state.worldName) return;
        await openBook(name);
    });

    overlay.querySelector('#st-codex-new-book').addEventListener('click', promptNewBook);
    overlay.querySelector('#st-codex-manage-categories').addEventListener('click', () => {
        if (!app.busy && !document.querySelector('.st-codex-modal-backdrop')) openCategoryManager(app);
    });
    overlay.querySelector('#st-codex-close').addEventListener('click', close);

    els.search.addEventListener('input', () => {
        // 300+ entries re-rendered on every keystroke is the main source of
        // input lag; coalesce bursts of typing into one render.
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            state.search = els.search.value.trim().toLowerCase();
            renderBody();
        }, 140);
    });

    els.scroll.addEventListener('click', onScrollClick);
    cardPreviews = installCardPreviews(els.scroll, trigger => {
        const key = trigger.closest('.st-codex-card')?.dataset.entryKey;
        const entries = state.data?.entries;
        return entries && Object.hasOwn(entries, key) ? entries[key] : null;
    });

    // A thumbnail URL that 404s should degrade quietly instead of showing a
    // broken-image glyph inside the card.
    els.scroll.addEventListener('error', event => {
        const img = event.target;
        if (!img || img.tagName !== 'IMG') return;
        img.closest('.st-codex-thumb')?.classList.add('st-codex-thumb-broken');
        img.remove();
    }, true);
    els.pillbar.addEventListener('click', onPillClick);

    overlay.querySelectorAll('.st-codex-rail-toggle').forEach(button => {
        button.addEventListener('click', () => toggleRail(button.dataset.rail));
    });

    overlay.querySelector('#st-codex-status-filter').addEventListener('click', event => {
        const button = event.target.closest('[data-status]');
        if (!button) return;
        state.statusFilter = button.dataset.status;
        savePrefs();
        renderStatusFilter();
        renderBody();
    });

    overlay.querySelector('#st-codex-show-empty').addEventListener('change', event => {
        state.showEmptyCategories = event.target.checked;
        savePrefs();
        renderBody();
    });

    overlay.querySelector('#st-codex-selection-mode').addEventListener('change', event => {
        setSelectionMode(event.target.checked);
    });
    overlay.querySelector('#st-codex-bulk-edit').addEventListener('click', () => setSelectionMode(!state.selectionMode));

    overlay.querySelector('#st-codex-select-all').addEventListener('change', event => selectAllVisible(event.target.checked));
    overlay.querySelector('#st-codex-sel-clear').addEventListener('click', () => {
        state.selected.clear();
        renderBody();
    });
    overlay.querySelector('#st-codex-sel-delete').addEventListener('click', deleteSelected);
    overlay.querySelector('#st-codex-sel-move').addEventListener('click', () => editSelected({
        categoryId: overlay.querySelector('#st-codex-sel-category').value,
    }));
    overlay.querySelector('#st-codex-sel-enable').addEventListener('click', () => editSelected({ disabled: false }));
    overlay.querySelector('#st-codex-sel-disable').addEventListener('click', () => editSelected({ disabled: true }));
    overlay.querySelector('#st-codex-count-tokens').addEventListener('click', () => refreshTokenCounts(true));

    overlay.querySelector('#st-codex-sort-title').addEventListener('click', () => sortEntries('title'));
    overlay.querySelector('#st-codex-sort-title-desc').addEventListener('click', () => sortEntries('title-desc'));
    overlay.querySelector('#st-codex-sort-tokens').addEventListener('click', () => sortEntries('tokens'));

    overlay.querySelector('#st-codex-compact').addEventListener('change', event => {
        state.compact = event.target.checked;
        savePrefs();
        applyDisplayPrefs();
    });

    document.addEventListener('keydown', onKeydown);
    window.matchMedia('(max-width: 900px)').addEventListener('change', applyDisplayPrefs);
    installDragDrop(app, els.scroll);

    setModalCloseHook(() => {
        if (state.dirty && !pendingSaves && !saveTimer) state.dirty = hasBookChanges(state.data);
        if (pendingReload && !document.querySelector('.st-codex-modal-backdrop')) reloadCurrentBook();
    });
    window.addEventListener('beforeunload', event => {
        if (state.dirty || pendingSaves || [...document.querySelectorAll('.st-codex-modal-backdrop')].some(modal => modal.__hasUnsavedChanges?.())) {
            event.preventDefault();
            event.returnValue = '';
        }
    });

    applyDisplayPrefs();
    renderStatusFilter();
}

function applyDisplayPrefs() {
    els.overlay.classList.toggle('st-codex-compact', state.compact);
    els.overlay.querySelector('#st-codex-compact').checked = state.compact;
    els.overlay.querySelector('#st-codex-show-empty').checked = state.showEmptyCategories;
    els.overlay.querySelector('#st-codex-selection-mode').checked = state.selectionMode;
    const narrow = window.matchMedia('(max-width: 900px)').matches;
    els.overlay.classList.toggle('st-codex-narrow', narrow);
    els.railLeft.classList.toggle('is-collapsed', narrow ? mobileRail !== 'left' : state.leftCollapsed);
    els.railRight.classList.toggle('is-collapsed', narrow ? mobileRail !== 'right' : state.rightCollapsed);
    for (const [side, rail] of [['left', els.railLeft], ['right', els.railRight]]) {
        const expanded = !rail.classList.contains('is-collapsed');
        rail.querySelector('.st-codex-rail-toggle').setAttribute('aria-expanded', String(expanded));
        rail.querySelector('.st-codex-rail-toggle').setAttribute('aria-label', `${expanded ? 'Close' : 'Open'} ${side === 'left' ? 'Library' : 'Options'} panel`);
    }
}

function toggleRail(side) {
    if (window.matchMedia('(max-width: 900px)').matches) {
        mobileRail = mobileRail === side ? null : side;
        applyDisplayPrefs();
        return;
    }
    if (side === 'left') state.leftCollapsed = !state.leftCollapsed;
    else state.rightCollapsed = !state.rightCollapsed;
    savePrefs();
    applyDisplayPrefs();
}

function renderStatusFilter() {
    els.overlay.querySelectorAll('#st-codex-status-filter [data-status]').forEach(button => {
        button.classList.toggle('is-active', button.dataset.status === state.statusFilter);
    });
}

function onKeydown(event) {
    if (event.key !== 'Escape') return;
    if (!els.overlay || els.overlay.classList.contains('st-codex-hidden')) return;
    if (document.querySelector('.st-codex-modal-backdrop')) return;
    close();
}

export async function open(preferredWorld) {
    if (document.querySelector('.st-codex-modal-backdrop')) return;
    mount();
    const reopening = !isOpen();
    const previousBook = state.data;
    els.overlay.classList.remove('st-codex-hidden');
    document.body.classList.add('st-codex-body-lock');
    try { await refreshWorldList(preferredWorld || (await getActiveWorldName()) || state.worldName); }
    catch (error) { toast(error.message || 'Could not load the lorebook list.', true); }
    if (isOpen()) {
        if (reopening && previousBook && previousBook === state.data) renderBody();
        els.search.focus();
    }
}

export async function close() {
    if (!els.overlay) return;
    const modal = [...document.querySelectorAll('.st-codex-modal-backdrop')].at(-1);
    if (modal) {
        await modal.__close();
        if (document.querySelector('.st-codex-modal-backdrop')) return;
    }
    if (app.busy) { toast('Wait for the current operation to finish before closing.', true); return; }
    if (!await saveBeforeLeaving()) return;
    ++openBookGeneration;
    pendingReload = false;
    cardPreviews?.close();
    els.overlay.classList.add('st-codex-hidden');
    clearTimeout(tokenTimer);
    if (tokenCounting) tokenAttempts.clear();
    ++tokenRun;
    tokenCounting = false;
    tokenPromise = null;
    document.body.classList.remove('st-codex-body-lock');
}

export function isOpen() {
    return Boolean(els.overlay && !els.overlay.classList.contains('st-codex-hidden'));
}

export function toggle() {
    if (document.querySelector('.st-codex-modal-backdrop')) return;
    if (isOpen()) close();
    else open();
}

/* -------------------------------------------------------------- world loading */

async function refreshWorldList(preferred) {
    if (app.busy) return;
    if (!await saveBeforeLeaving()) return;
    const generation = ++openBookGeneration;
    const revision = saveRevision;
    const worlds = await listWorlds();
    if (generation !== openBookGeneration || revision !== saveRevision || !isOpen()
        || state.dirty || pendingSaves || document.querySelector('.st-codex-modal-backdrop')) return;
    const options = worlds.length
        ? worlds.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')
        : '<option value="">No lorebooks yet</option>';
    els.worldSelect.innerHTML = options;

    const target = preferred && worlds.includes(preferred) ? preferred : worlds[0] || '';
    if (!worlds.length) {
        cardPreviews?.close();
        state.worldName = '';
        state.data = null;
        state.categories = [];
        renderPills([]);
        renderStats([]);
        els.scroll.innerHTML = `
            <div class="st-codex-empty">
                <p>No lorebooks found in this SillyTavern installation.</p>
                <button class="st-codex-btn st-codex-btn-primary" id="st-codex-empty-create">
                    <i class="fa-solid fa-plus"></i><span>Create your first lorebook</span>
                </button>
            </div>`;
        els.scroll.querySelector('#st-codex-empty-create')?.addEventListener('click', promptNewBook);
        return;
    }

    els.worldSelect.value = target;
    if (!state.data || target !== state.worldName) {
        await openBook(target);
    } else {
        // Reopening must re-read the book: it may have been edited in
        // SillyTavern's own panel while the Codex was hidden.
        await reloadCurrentBook();
    }
}

async function openBook(name) {
    if (pendingSaves || bulkSaving || sorting || document.querySelector('.st-codex-modal-backdrop')) {
        els.worldSelect.value = state.worldName;
        return;
    }
    const generation = ++openBookGeneration;

    // Never replace the outgoing book while a debounced edit is still waiting:
    // its timer would then write the new book's data instead.
    if (state.dirty || saveTimer) {
        const saved = await saveBeforeLeaving();
        if (generation !== openBookGeneration) return;
        if (!saved) {
            els.worldSelect.value = state.worldName;
            state.loading = false;
            return;
        }
    }

    state.loading = true;
    cardPreviews?.close();
    els.scroll.innerHTML = '<div class="st-codex-empty">Loading lorebook…</div>';
    try {
        const data = await loadBook(name);
        if (generation !== openBookGeneration) return;
        if (!data) {
            els.worldSelect.value = state.worldName;
            toast(`Could not load lorebook "${name}".`, true);
            return;
        }
        state.worldName = name;
        els.worldSelect.value = name;
        state.data = data;
        pendingReload = false;
        state.categories = getCategories(data);
        state.activeCategory = 'all';
        state.search = '';
        state.selected.clear();
        if (els.search) els.search.value = '';
        state.dirty = false;
        state.lastSaveAt = 0;
        if (hadNativeChangesOnLoad(data)) showNativeChangesNotice();
    } catch (error) {
        if (generation !== openBookGeneration) return;
        els.worldSelect.value = state.worldName;
        console.error('[VisualLorebook] Failed to open lorebook', error);
        toast(error.message || 'Could not open this lorebook.', true);
    } finally {
        if (generation === openBookGeneration) {
            state.loading = false;
            if (state.data) render();
            else els.scroll.innerHTML = '<div class="st-codex-empty">Could not load this lorebook. Choose another book or reopen Codex.</div>';
        }
    }
}

async function reloadCurrentBook() {
    if (!state.worldName) return;
    // Keep a modal's draft anchored to its original book. Defer replacement
    // while a dialog, save or book switch is active.
    if (document.querySelector('.st-codex-modal-backdrop') || state.dirty || pendingSaves || saveTimer || state.loading) {
        pendingReload = true;
        return;
    }
    pendingReload = false;
    const world = state.worldName;
    const generation = ++openBookGeneration;
    const revision = saveRevision;
    let data;
    try { data = await loadBook(world); }
    catch (error) { toast(error.message || 'Could not reload this lorebook.', true); return; }
    if (generation !== openBookGeneration || state.worldName !== world || !isOpen()) return;
    if (!data) {
        toast('This lorebook is no longer available. Choose another book.', true);
        return;
    }
    if (revision !== saveRevision || state.dirty || pendingSaves || document.querySelector('.st-codex-modal-backdrop')) {
        pendingReload = true;
        return;
    }
    const unchanged = isSameBookVersion(state.data, data);
    if (unchanged && !isBookStale(state.data)) {
        if (hadNativeChangesOnLoad(data)) showNativeChangesNotice();
        return;
    }
    state.data = data;
    state.categories = getCategories(data);
    if (!unchanged) state.selected.clear();
    if (!state.categories.some(cat => cat.id === state.activeCategory)) state.activeCategory = 'all';
    state.dirty = false;
    render();
    if (hadNativeChangesOnLoad(data)) showNativeChangesNotice();
}

function showNativeChangesNotice() {
    toast('Showing the last saved version. Finish any pending edits in the native World Info editor before saving here.');
}

async function promptNewBook() {
    if (app.busy || document.querySelector('.st-codex-modal-backdrop')) return;
    if (!await saveBeforeLeaving()) return;
    const name = window.prompt('Name for the new lorebook:');
    if (!name || !name.trim()) return;
    try {
        const created = await createBook(name.trim());
        await refreshWorldList(created);
        els.worldSelect.value = created;
        toast(`Created lorebook "${created}".`);
    } catch (error) {
        toast(error.message || 'Could not create that lorebook.', true);
    }
}

/* -------------------------------------------------------------------- render */

/** Recomputes the whole view from one sorted snapshot. */
function renderBody() {
    if (!state.data) return;
    if (tokenData !== state.data) {
        tokenData = state.data;
        ++tokenRun;
        tokenCounting = false;
        tokenCountsVisible = true;
        tokenCounts.clear();
        tokenAttempts.clear();
        clearTimeout(tokenTimer);
        tokenPromise = null;
    }
    const ordered = sortedEntries(state.data);
    renderPills(ordered);
    renderSections(ordered);
    renderStats(ordered);
    renderSelectionUi();
    renderInfo(ordered.length);
    scheduleTokenCounts(ordered);
}

export function render() {
    if (!state.data) return;
    if (state.dirty && !pendingSaves && !saveTimer) state.dirty = hasBookChanges(state.data);
    state.categories = getCategories(state.data);
    renderBody();
}

function countsByCategory(ordered = sortedEntries(state.data)) {
    const counts = new Map();
    const categoryIds = new Set(state.categories.map(cat => cat.id));
    for (const { entry } of ordered) {
        const visual = getEntryVisual(entry);
        const id = categoryIds.has(visual.categoryId) ? visual.categoryId : 'uncategorized';
        counts.set(id, (counts.get(id) || 0) + 1);
    }
    return counts;
}

function renderPills(ordered = []) {
    if (!els.pillbar) return;
    const counts = state.data ? countsByCategory(ordered) : new Map();
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);

    const pills = [
        `<button class="st-codex-pill ${state.activeCategory === 'all' ? 'st-codex-pill-active' : ''}"
                 data-cat="all" style="--pill-color:#8b8b96">
            <span>All</span><span class="st-codex-pill-count">${total}</span>
         </button>`,
    ];

    for (const cat of state.categories) {
        const count = counts.get(cat.id) || 0;
        const active = state.activeCategory === cat.id;
        pills.push(`
            <button class="st-codex-pill ${active ? 'st-codex-pill-active' : ''}"
                    data-cat="${escapeHtml(cat.id)}" style="--pill-color:${escapeHtml(sanitizeColor(cat.color))}">
                <span class="st-codex-pill-dot"></span>
                <span>${escapeHtml(cat.name)}</span>
                <span class="st-codex-pill-count">${count}</span>
            </button>`);
    }

    els.pillbar.innerHTML = pills.join('');
}

function renderStats(ordered = []) {
    if (!els.stats) return;
    const entries = ordered.map(item => item.entry);
    const disabled = entries.filter(entry => entry.disable).length;
    const constant = entries.filter(entry => !entry.disable && entry.constant).length;
    const keys = entries.reduce((sum, entry) => sum + (Array.isArray(entry.key) ? entry.key.length : 0), 0);

    els.stats.innerHTML = `
        <div><dt>Entries</dt><dd>${entries.length}</dd></div>
        <div><dt>Enabled</dt><dd>${entries.length - disabled}</dd></div>
        <div><dt>Disabled</dt><dd>${disabled}</dd></div>
        <div><dt>Constant</dt><dd>${constant}</dd></div>
        <div><dt>Categories</dt><dd>${state.categories.length}</dd></div>
        <div><dt>Trigger keys</dt><dd>${keys}</dd></div>
        ${tokenCountsVisible ? `<div title="Stored content across the whole book, including disabled entries"><dt>Content tokens</dt><dd>${formatTokens(entries)}</dd></div>` : ''}`;
    const button = els.overlay.querySelector('#st-codex-count-tokens');
    button.disabled = tokenCounting;
    button.textContent = tokenCounting ? 'Counting tokens…' : tokenCountsVisible ? 'Refresh token counts' : 'Count tokens';
}

function formatTokens(entries) {
    let total = 0;
    for (const entry of entries) {
        const result = tokenCounts.get(entryUid(entry));
        if (!result || result.content !== entryContent(entry)) return '—';
        total += result.count;
    }
    return total.toLocaleString();
}

function groupTokenEntries(ordered, categoryIds) {
    const groups = new Map();
    for (const { entry } of ordered) {
        const categoryId = getEntryVisual(entry).categoryId;
        const id = categoryIds.has(categoryId) ? categoryId : 'uncategorized';
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(entry);
    }
    return groups;
}

function renderTokenCounts(ordered = sortedEntries(state.data)) {
    renderStats(ordered);
    const groups = groupTokenEntries(ordered, new Set(state.categories.map(cat => cat.id)));
    for (const section of els.scroll.querySelectorAll('.st-codex-section')) {
        const count = section.querySelector('.st-codex-section-head .st-codex-token-count');
        if (count) count.textContent = `${formatTokens(groups.get(section.dataset.cat) || [])} tokens`;
    }
    // Keep card controls and any open preview mounted while the tokenizer runs.
    for (const card of els.scroll.querySelectorAll('.st-codex-card')) {
        const count = card.querySelector('.st-codex-token-count');
        const entry = state.data.entries[card.dataset.entryKey];
        if (count && entry) count.textContent = `${formatTokens([entry])} tokens`;
    }
}

function scheduleTokenCounts(ordered) {
    if (tokenCounting || !isOpen()) return;
    const pending = ordered.some(({entry}) => {
        const uid = entryUid(entry);
        const content = entryContent(entry);
        return uid && tokenCounts.get(uid)?.content !== content && tokenAttempts.get(uid) !== content;
    });
    clearTimeout(tokenTimer);
    if (pending) tokenTimer = setTimeout(() => refreshTokenCounts(false), 120);
}

function refreshTokenCounts(force = true) {
    if (!state.data) return Promise.resolve(false);
    if (tokenCounting) return tokenPromise;
    clearTimeout(tokenTimer);
    tokenPromise = countTokens(force);
    return tokenPromise;
}

async function countTokens(force) {
    const data = state.data;
    const run = ++tokenRun;
    tokenCounting = true;
    tokenCountsVisible = true;
    if (force) {
        tokenCounts.clear();
        tokenAttempts.clear();
    }
    const ordered = sortedEntries(data);
    renderTokenCounts(ordered);
    const entries = ordered.map(({entry}) => ({ uid: entryUid(entry), content: entryContent(entry) }))
        .filter(entry => entry.uid && (force || (tokenCounts.get(entry.uid)?.content !== entry.content && tokenAttempts.get(entry.uid) !== entry.content)));
    let failures = 0;
    // Limit native tokenizer requests for large books, including remote tokenizers.
    for (let offset = 0; offset < entries.length; offset += 4) {
        const batch = entries.slice(offset, offset + 4);
        batch.forEach(entry => tokenAttempts.set(entry.uid, entry.content));
        const results = await Promise.allSettled(batch.map(entry => countContentTokens(entry.content)));
        if (state.data !== data || run !== tokenRun) return false;
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') tokenCounts.set(batch[index].uid, {content: batch[index].content, count: result.value});
            else failures++;
        });
        // Stop a large book from hammering an unavailable remote tokenizer.
        if (results.every(result => result.status === 'rejected')) {
            entries.slice(offset + batch.length).forEach(entry => tokenAttempts.set(entry.uid, entry.content));
            failures += entries.length - offset - batch.length;
            break;
        }
        if (offset % 32 === 28) await new Promise(resolve => setTimeout(resolve, 0));
        if (state.data !== data || run !== tokenRun) return false;
    }
    if (run !== tokenRun || state.data !== data) return false;
    tokenCounting = false;
    renderTokenCounts();
    if (failures) toast(`Token counts unavailable for ${failures} entries. Check your tokenizer connection and retry.`, true);
    return failures === 0;
}

function renderInfo(total = lastRenderedCount) {
    if (!els.info || !state.data) return;
    const visible = lastRenderedCount;
    const stamp = state.lastSaveAt ? new Date(state.lastSaveAt).toLocaleTimeString() : '—';
    els.info.innerHTML = `
        <span>${visible} of ${total} entries shown</span>
        <span>Last save: ${escapeHtml(stamp)}</span>
        <span>${pendingSaves ? 'Saving changes…' : state.dirty ? 'Unsaved changes. Keep Codex open and retry saving.' : 'Changes are written to the lorebook automatically.'}</span>`;
}

function matchesSearch(entry) {
    if (!state.search) return true;
    const haystack = [
        entry.comment || '',
        entryContent(entry),
        ...(Array.isArray(entry.key) ? entry.key : []),
        ...(Array.isArray(entry.keysecondary) ? entry.keysecondary : []),
    ].filter(value => typeof value === 'string')
        .join(' ')
        .toLowerCase();
    return haystack.includes(state.search);
}

function passesStatus(entry) {
    if (state.statusFilter === 'enabled') return !entry.disable;
    if (state.statusFilter === 'disabled') return Boolean(entry.disable);
    return true;
}

function renderSections(ordered = []) {
    cardPreviews?.close();
    if (!state.data) return;
    lastRenderedCount = 0;

    const entries = ordered.filter(({ entry }) => passesStatus(entry) && matchesSearch(entry));
    const categoryIds = new Set(state.categories.map(cat => cat.id));
    const grouped = new Map();
    const tokenGroups = tokenCountsVisible ? groupTokenEntries(ordered, categoryIds) : new Map();
    for (const item of entries) {
        const visual = getEntryVisual(item.entry);
        const id = categoryIds.has(visual.categoryId) ? visual.categoryId : 'uncategorized';
        if (!grouped.has(id)) grouped.set(id, []);
        grouped.get(id).push(item);
    }

    const visibleCategories = state.activeCategory === 'all'
        ? state.categories
        : state.categories.filter(cat => cat.id === state.activeCategory);

    const sections = visibleCategories.map(cat => {
        const items = grouped.get(cat.id) || [];
        if (items.length === 0 && (state.search || state.statusFilter !== 'all')) return '';
        if (items.length === 0 && !state.showEmptyCategories) return '';
        return renderSection(cat, items, tokenGroups.get(cat.id) || []);
    });

    const html = sections.filter(Boolean).join('');
    if (!html) {
        els.scroll.innerHTML = `<div class="st-codex-empty">
            ${!ordered.length ? `<p>This lorebook has no entries to show.</p>
                <button class="st-codex-btn st-codex-btn-primary" data-action="add-entry" data-cat="uncategorized" type="button">
                    <i class="fa-solid fa-plus"></i><span>Add entry</span>
                </button>` : state.search ? 'No entries match your search.' : 'No entries match the current filters.'}
        </div>`;
        return;
    }
    els.scroll.innerHTML = `<div class="st-codex-sections">${html}</div>`;
    lastRenderedCount = els.scroll.querySelectorAll('.st-codex-card').length;
}

function renderSection(cat, items, categoryEntries = []) {
    const collapsed = Boolean(cat.collapsed);
    const cards = items.map(item => renderCard(item.entry, cat, item.key)).join('');

    return `
        <section class="st-codex-section ${collapsed ? 'st-codex-collapsed' : ''}"
                 data-cat="${escapeHtml(cat.id)}" style="--section-color:${escapeHtml(sanitizeColor(cat.color))}">
            <div class="st-codex-section-head" data-action="toggle-section" data-cat="${escapeHtml(cat.id)}" draggable="true">
                <span class="st-codex-chevron"><i class="fa-solid fa-chevron-down"></i></span>
                <span class="st-codex-section-title">${escapeHtml(cat.name)}</span>
                <span class="st-codex-section-count">(${items.length})</span>
                ${tokenCountsVisible ? `<span class="st-codex-token-count" title="Content tokens for the entire category, including hidden and disabled entries">${formatTokens(categoryEntries)} tokens</span>` : ''}
                <button class="st-codex-section-edit" data-action="edit-category" data-cat="${escapeHtml(cat.id)}"
                        title="Edit this category" draggable="false">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button class="st-codex-section-add" data-action="add-entry" data-cat="${escapeHtml(cat.id)}">
                    <i class="fa-solid fa-plus"></i><span>Add</span>
                </button>
            </div>
            <div class="st-codex-grid" data-cat="${escapeHtml(cat.id)}">
                ${cards}
                <div class="st-codex-card-add" data-action="add-entry" data-cat="${escapeHtml(cat.id)}"
                     style="--cat-color:${escapeHtml(sanitizeColor(cat.color))}">
                    <i class="fa-solid fa-plus"></i><span>Add ${escapeHtml(cat.name)}</span>
                </div>
            </div>
        </section>`;
}

function statusOf(entry) {
    if (entry.disable) return { key: 'disabled', label: 'Disabled' };
    if (entry.constant) return { key: 'constant', label: 'Constant' };
    if (entry.vectorized) return { key: 'vectorized', label: 'Vectorized' };
    return { key: 'keyword', label: 'Keyword' };
}

function renderCard(entry, cat, entryKey) {
    const visual = getEntryVisual(entry);
    const title = entryTitle(entry);
    const subtitle = entrySubtitle(entry);
    const preview = truncate(entryContent(entry) || 'No content yet.', 220);
    const importanceClass = `st-codex-imp-${String(subtitle).toLowerCase().replace(/[^a-z]/g, '')}`;
    const status = statusOf(entry);
    const uid = entryUid(entry);
    const selected = state.selected.has(uid);

    const primary = Array.isArray(entry.key) ? entry.key : [];
    const secondary = Array.isArray(entry.keysecondary) ? entry.keysecondary : [];
    const keyCount = primary.length + secondary.length;

    const imageSrc = sanitizeImageSrc(visual.image);
    const thumb = imageSrc
        ? `<div class="st-codex-thumb"><img src="${escapeHtml(imageSrc)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>`
        : '';

    const picker = state.selectionMode
        ? `<span class="st-codex-pick" aria-hidden="true"><i class="fa-solid fa-check"></i></span>`
        : '';

    const keys = keyCount
        ? `<button class="st-codex-keys st-codex-preview-trigger" type="button" draggable="false" data-preview="keywords"
               aria-haspopup="dialog" aria-expanded="false" aria-pressed="false" aria-controls="st-codex-card-preview">
               <i class="fa-solid fa-key" aria-hidden="true"></i>${keyCount} key${keyCount > 1 ? 's' : ''}
           </button>`
        : `<span class="st-codex-keys st-codex-keys-empty"><i class="fa-solid fa-key" aria-hidden="true"></i>no keys</span>`;

    return `
        <article class="st-codex-card ${entry.disable ? 'st-codex-disabled' : ''} ${selected ? 'st-codex-selected' : ''} ${state.selectionMode ? 'st-codex-picking' : ''}"
                 data-action="open-entry" data-uid="${escapeHtml(uid)}" data-entry-key="${escapeHtml(entryKey)}" draggable="true"
                 style="--cat-color:${escapeHtml(sanitizeColor(cat.color))}">
            ${picker}
            ${thumb}
            <div class="st-codex-card-body">
                <div class="st-codex-card-top">
                    <span class="st-codex-badge">${escapeHtml(cat.name)}</span>
                    <span class="st-codex-status st-codex-status-${status.key}">
                        <i></i>${status.label}
                    </span>
                    <button class="st-codex-switch ${entry.disable ? '' : 'is-on'}"
                            data-action="toggle-disable" data-uid="${escapeHtml(uid)}"
                            draggable="false"
                            title="${entry.disable ? 'Enable this entry' : 'Disable this entry'}"
                            aria-pressed="${entry.disable ? 'false' : 'true'}"><span></span></button>
                </div>
                <div class="st-codex-card-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
                <div class="st-codex-card-subtitle ${importanceClass}">${escapeHtml(subtitle)}</div>
                <div class="st-codex-card-preview">${escapeHtml(preview)}</div>
                <div class="st-codex-card-foot">${keys}
                    <button class="st-codex-preview-trigger st-codex-settings-preview" type="button" draggable="false"
                        data-preview="settings" aria-label="Preview settings for ${escapeHtml(title)}"
                        aria-haspopup="dialog" aria-expanded="false" aria-pressed="false" aria-controls="st-codex-card-preview">
                        <i class="fa-solid fa-sliders" aria-hidden="true"></i>
                    </button>
                    ${tokenCountsVisible ? `<span class="st-codex-token-count" title="Stored content tokens; refresh counts after edits">${formatTokens([entry])} tokens</span>` : ''}
                    <button class="st-codex-duplicate" data-action="duplicate-entry" data-uid="${escapeHtml(uid)}" draggable="false"
                        type="button" title="Duplicate entry" aria-label="Duplicate ${escapeHtml(title)}"><i class="fa-solid fa-copy"></i></button>
                </div>
            </div>
        </article>`;
}

/* ------------------------------------------------------------------- events */

function onPillClick(event) {
    const pill = event.target.closest('.st-codex-pill');
    if (!pill) return;
    state.activeCategory = pill.dataset.cat || 'all';
    renderBody();
}

function toggleSelected(uid) {
    const card = document.querySelector(`.st-codex-card[data-uid="${CSS.escape(uid)}"]`);
    if (state.selected.has(uid)) {
        state.selected.delete(uid);
        card?.classList.remove('st-codex-selected');
    } else {
        state.selected.add(uid);
        card?.classList.add('st-codex-selected');
    }
    renderSelectionUi();
}

function setSelectionMode(enabled) {
    state.selectionMode = Boolean(enabled);
    if (!state.selectionMode) state.selected.clear();
    els.overlay.querySelector('#st-codex-selection-mode').checked = state.selectionMode;
    renderBody();
}

function renderSelectionUi() {
    if (!els.selbar) return;
    els.selbar.hidden = !state.selectionMode;
    const count = state.selected.size;
    const bulkButton = els.overlay.querySelector('#st-codex-bulk-edit');
    bulkButton.textContent = state.selectionMode ? 'Done selecting' : 'Bulk edit';
    bulkButton.setAttribute('aria-pressed', String(state.selectionMode));
    bulkButton.disabled = bulkSaving || sorting;
    els.overlay.querySelector('#st-codex-selection-mode').checked = state.selectionMode;
    els.overlay.querySelector('#st-codex-selection-mode').disabled = bulkSaving || sorting;
    els.overlay.querySelector('#st-codex-bulk-hint').textContent = state.selectionMode
        ? 'Click cards to select them, then choose an action below.'
        : 'Move, enable or disable multiple entries.';
    els.overlay.querySelectorAll('[id^="st-codex-sort-"]').forEach(button => { button.disabled = sorting || bulkSaving; });
    els.selcount.textContent = `${count} selected`;
    const del = els.overlay.querySelector('#st-codex-sel-delete');
    if (del) {
        del.disabled = count === 0;
        del.innerHTML = `<i class="fa-solid fa-trash"></i> Delete selected${count ? ` (${count})` : ''}`;
    }
    const selectAll = els.overlay.querySelector('#st-codex-select-all');
    if (selectAll) {
        const visible = visibleUids();
        const selectedCount = visible.filter(uid => state.selected.has(uid)).length;
        selectAll.checked = visible.length > 0 && selectedCount === visible.length;
        selectAll.indeterminate = selectedCount > 0 && selectedCount < visible.length;
        selectAll.disabled = bulkSaving || sorting || !visible.length;
    }
    const categorySelect = els.overlay.querySelector('#st-codex-sel-category');
    const categoryId = categorySelect.value;
    categorySelect.innerHTML = state.categories.map(category => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)}</option>`).join('');
    if (state.categories.some(category => category.id === categoryId)) categorySelect.value = categoryId;
    els.selbar.querySelectorAll('button, select').forEach(control => {
        control.disabled = bulkSaving || sorting || !count;
    });
    els.selbar.setAttribute('aria-busy', String(bulkSaving));
}

async function editSelected({ categoryId, disabled }) {
    if (app.busy || !state.data || !state.selected.size) return;
    if (categoryId !== undefined && !state.categories.some(category => category.id === categoryId)) return;
    const ordered = sortedEntries(state.data);
    const uidCounts = new Map();
    for (const {entry} of ordered) {
        const uid = entryUid(entry);
        uidCounts.set(uid, (uidCounts.get(uid) || 0) + 1);
    }
    if ([...state.selected].some(uid => !uid || uidCounts.get(uid) !== 1)) {
        toast('Selection contains missing or ambiguous entry identifiers. Reload before editing.', true);
        return;
    }
    const data = state.data;
    const changes = [];
    let sortOrder = categoryId === undefined ? 0 : nextSortOrder(data, categoryId);
    try {
        for (const {key, entry} of ordered) {
            if (!state.selected.has(entryUid(entry))) continue;
            if (categoryId !== undefined && getEntryVisual(entry).categoryId === categoryId) continue;
            if (disabled !== undefined && Boolean(entry.disable) === disabled) continue;
            const updated = structuredClone(entry);
            if (categoryId !== undefined) setEntryVisual(updated, {categoryId, sortOrder: sortOrder++});
            if (disabled !== undefined) updated.disable = disabled;
            changes.push({key, previous: entry, updated});
        }
    } catch (error) {
        toast(error.message || 'Could not edit the selection.', true);
        return;
    }
    if (!changes.length) { toast('Selected entries already have that setting.'); return; }
    for (const {key, updated} of changes) data.entries[key] = updated;
    bulkSaving = true;
    renderSelectionUi();
    try {
        const saved = await flushSave();
        if (!saved) {
            for (const {key, previous, updated} of changes) {
                if (data.entries[key] === updated) data.entries[key] = previous;
            }
        } else {
            toast(`${changes.length} entr${changes.length === 1 ? 'y' : 'ies'} ${categoryId !== undefined ? 'moved' : disabled ? 'disabled' : 'enabled'}.`);
        }
    } finally {
        bulkSaving = false;
        render();
    }
}

function visibleUids() {
    return [...document.querySelectorAll('.st-codex-card')]
        .filter(card => card.offsetParent !== null)
        .map(card => card.dataset.uid);
}

function selectAllVisible(checked) {
    if (checked && !state.selectionMode) {
        setSelectionMode(true);
    }
    for (const uid of visibleUids()) {
        if (checked) state.selected.add(uid);
        else state.selected.delete(uid);
    }
    renderBody();
}

async function deleteSelected() {
    if (app.busy) return;
    const data = state.data;
    const world = state.worldName;
    const uids = [...state.selected];
    if (!uids.length) return;

    const titles = uids
        .map(uid => findEntry(state.data, uid))
        .filter(Boolean)
        .map(entry => entryTitle(entry));
    const list = titles.slice(0, 8).map(title => `<li>${escapeHtml(truncate(title, 60))}</li>`).join('');
    const more = titles.length > 8 ? `<li>…and ${titles.length - 8} more</li>` : '';

    const ok = await confirmDialog({
        title: `Delete ${uids.length} entr${uids.length === 1 ? 'y' : 'ies'}?`,
        message: `<ul class="st-codex-confirm-list">${list}${more}</ul>
                  <p class="st-codex-hint">This removes them from the lorebook file. It cannot be undone.</p>`,
        confirmLabel: `Delete ${uids.length}`,
        danger: true,
    });
    if (!ok || state.data !== data || state.worldName !== world || app.busy) return;

    bulkSaving = true;
    renderSelectionUi();
    try {
        await deleteEntries(world, data, uids);
    } catch (error) {
        console.error('[VisualLorebook] Delete failed', error);
        toast(error.message || 'Could not delete those entries.', true);
        return;
    } finally {
        bulkSaving = false;
        render();
    }
    state.selected.clear();
    state.lastSaveAt = Date.now();
    render();
    toast(`${uids.length} entr${uids.length === 1 ? 'y' : 'ies'} deleted.`);
}

async function sortEntries(mode) {
    if (!state.data || app.busy) return;
    const data = state.data;
    sorting = true;
    renderSelectionUi();
    const changes = [];
    let saved = false;
    try {
        if (mode === 'tokens') await refreshTokenCounts(false);
        if (state.data !== data) return;
        const ordered = sortedEntries(data);
        if (mode === 'tokens' && ordered.some(({entry}) => tokenCounts.get(entryUid(entry))?.content !== entryContent(entry))) {
            toast('Token counts are unavailable. Refresh counts before sorting by tokens.', true);
            return;
        }
        const groups = new Map(state.categories.map(cat => [cat.id, []]));
        for (const item of ordered) {
            const categoryId = getEntryVisual(item.entry).categoryId;
            (groups.get(categoryId) || groups.get('uncategorized')).push({...item, title: entryTitle(item.entry)});
        }
        for (const items of groups.values()) {
            items.sort((a, b) => {
                const titleOrder = a.title.localeCompare(b.title, undefined, {sensitivity: 'base'});
                if (mode === 'tokens') return tokenCounts.get(entryUid(b.entry)).count - tokenCounts.get(entryUid(a.entry)).count || titleOrder;
                return mode === 'title-desc' ? -titleOrder : titleOrder;
            });
            items.forEach(({key, entry}, index) => {
                const updated = structuredClone(entry);
                setEntryVisual(updated, {sortOrder: index});
                changes.push({key, previous: entry, updated});
                data.entries[key] = updated;
            });
        }
        saved = await flushSave();
        if (saved) toast(mode === 'tokens' ? 'Entries sorted by token count within each category.' : 'Entries sorted by title within each category.');
    } catch (error) {
        toast(error.message || 'Could not save the sort order.', true);
    } finally {
        if (!saved) for (const {key, previous, updated} of changes) {
            if (data.entries[key] === updated) data.entries[key] = previous;
        }
        sorting = false;
        render();
    }
}

function onScrollClick(event) {
    if (event.target.closest('.st-codex-preview-trigger')) return;
    if (app.busy || document.querySelector('.st-codex-modal-backdrop')) return;
    const duplicate = event.target.closest('[data-action="duplicate-entry"]');
    if (duplicate) {
        event.stopPropagation();
        const entry = findEntry(state.data, duplicate.dataset.uid);
        if (entry) openEntryEditor(app, null, undefined, { duplicateOf: entry });
        return;
    }
    const addBtn = event.target.closest('[data-action="add-entry"]');
    if (addBtn) {
        event.stopPropagation();
        const catId = addBtn.dataset.cat || 'uncategorized';
        openEntryEditor(app, null, catId);
        return;
    }

    const editCategory = event.target.closest('[data-action="edit-category"]');
    if (editCategory) {
        event.stopPropagation();
        openCategoryEditor(app, editCategory.dataset.cat);
        return;
    }

    const toggle = event.target.closest('[data-action="toggle-section"]');
    if (toggle) {
        const catId = toggle.dataset.cat;
        const cat = state.categories.find(item => item.id === catId);
        if (!cat) return;
        try { updateCategory(state.data, catId, { collapsed: !cat.collapsed }); }
        catch (error) { toast(error.message || 'Could not update this category.', true); return; }
        cat.collapsed = !cat.collapsed;
        const section = toggle.closest('.st-codex-section');
        section?.classList.toggle('st-codex-collapsed', cat.collapsed);
        scheduleSave();
        return;
    }

    const sw = event.target.closest('[data-action="toggle-disable"]');
    if (sw) {
        event.stopPropagation();
        event.preventDefault();
        const uid = sw.dataset.uid;
        const entry = findEntry(state.data, uid);
        if (!entry) return;

        const data = state.data;
        const world = state.worldName;
        // Use the same tracked save pipeline as every other dashboard edit.
        // The store helper rolls back this flag if persistence fails.
        const disabled = !entry.disable;
        const pending = setEntryDisabled(world, data, uid, disabled);
        ++saveRevision;
        ++pendingSaves;
        state.dirty = true;
        renderInfo();

        // Patch just this card instead of re-rendering 300 of them: a full
        // rebuild on every switch click is what makes rapid toggling feel slow
        // and jump the scroll position.
        const card = sw.closest('.st-codex-card');
        card?.classList.toggle('st-codex-disabled', entry.disable);
        sw.classList.toggle('is-on', !entry.disable);
        sw.setAttribute('aria-pressed', entry.disable ? 'false' : 'true');
        sw.title = entry.disable ? 'Enable this entry' : 'Disable this entry';
        const chip = card?.querySelector('.st-codex-status');
        if (chip) {
            const status = statusOf(entry);
            chip.className = `st-codex-status st-codex-status-${status.key}`;
            chip.innerHTML = `<i></i>${status.label}`;
        }
        if (passesStatus(entry)) {
            renderStats(sortedEntries(state.data));
        } else {
            // The card no longer belongs in the active status filter, so a
            // partial patch would leave it visible and selectable.
            renderBody();
        }

        pending.then(() => {
            if (state.data === data) state.lastSaveAt = Date.now();
        }).catch(error => {
            console.error('[VisualLorebook] Could not toggle entry', error);
            toast(error.message || 'Could not save that change.', true);
        }).finally(() => {
            --pendingSaves;
            if (state.data === data) render();
            resumeAutosave();
        });
        return;
    }

    const card = event.target.closest('[data-action="open-entry"]');
    if (!card) return;
    const uid = card.dataset.uid;
    if (state.selectionMode) {
        toggleSelected(uid);
        return;
    }
    const entry = findEntry(state.data, uid);
    if (entry) openEntryEditor(app, entry);
}

/* -------------------------------------------------------------- persistence */

export function scheduleSave() {
    ++saveRevision;
    state.dirty = true;
    state.categories = getCategories(state.data);
    armAutosave();
}

function armAutosave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        if (pendingSaves) {
            autosaveWaiting = true;
            return;
        }
        flushSave();
    }, 220);
}

function resumeAutosave() {
    if (pendingSaves || !autosaveWaiting) return;
    autosaveWaiting = false;
    armAutosave();
}

export function save() {
    scheduleSave();
}

async function saveBeforeLeaving() {
    if (!state.dirty && !saveTimer) return true;
    const data = state.data;
    if (await flushSave()) return !state.dirty;
    const discard = await confirmDialog({
        title: 'Discard unsaved changes to this lorebook?',
        message: 'The save could not be confirmed. You can keep editing or discard the pending changes in this dashboard.',
        confirmLabel: 'Discard local changes',
        danger: true,
    });
    if (!discard || state.data !== data || pendingSaves) return false;
    clearTimeout(saveTimer);
    saveTimer = null;
    autosaveWaiting = false;
    state.data = null;
    state.categories = [];
    state.selected.clear();
    state.dirty = false;
    pendingReload = true;
    els.scroll.innerHTML = '<div class="st-codex-empty">Reload the lorebook to continue.</div>';
    return true;
}

/**
 * Queues a write and resolves with `true`/`false`.
 *
 * Callers that show a "saved" confirmation must await this: a failed fetch has
 * to keep the editor open, not silently close it over lost data.
 */
export function flushSave() {
    autosaveWaiting = false;
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    if (!state.worldName || !state.data) return Promise.resolve(false);
    const world = state.worldName;
    const data = state.data;
    state.dirty = true;
    const revision = ++saveRevision;
    ++pendingSaves;
    renderInfo();
    const operation = saveBook(world, data)
        .then(() => {
            if (state.worldName === world && state.data === data) {
                if (revision === saveRevision) state.dirty = false;
                state.lastSaveAt = Date.now();
            }
            return true;
        })
        .catch(error => {
            if (state.data === data && state.worldName === world && isBookStale(data)) pendingReload = true;
            console.error('[VisualLorebook] Save failed', error);
            toast(error.message || 'Could not save the lorebook. Check the console.', true);
            return false;
        }).finally(() => {
            --pendingSaves;
            resumeAutosave();
            renderInfo();
            if (pendingReload) setTimeout(() => {
                if (isOpen() && !pendingSaves && !state.dirty && !document.querySelector('.st-codex-modal-backdrop')) reloadCurrentBook();
            }, 0);
        });
    return operation;
}

/* -------------------------------------------------------------------- toast */

export function toast(message, isError = false) {
    if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.className = 'st-codex-toast';
        document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.toggle('st-codex-toast-error', Boolean(isError));
    toastEl.classList.add('st-codex-toast-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toastEl?.classList.remove('st-codex-toast-show');
    }, 2600);
}
