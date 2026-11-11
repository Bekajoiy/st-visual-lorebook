/**
 * store.js — SillyTavern bridge + Visual Lorebook data layer.
 *
 * Golden rule: this module never re-implements World Info semantics. It reads
 * and writes the exact JSON that SillyTavern's own `world-info.js` produces.
 * All visual metadata lives inside the native `extensions` object, which ST
 * preserves on import/export and ignores during prompt generation.
 */

import { observeNativeCache } from './native-cache.js';

const WI_MODULE_PATH = '/scripts/world-info.js';
const SCHEMA_KEY = 'visual_lorebook';
const SCHEMA_VERSION = 1;
const REQUEST_TIMEOUT_MS = 15000;
const EMPTY_BOOK_JSON = '{"entries":{}}';

/* ------------------------------------------------------------------ palette */

export const PALETTE = [
    { name: 'Blue', color: '#5b8def' },
    { name: 'Emerald', color: '#34d399' },
    { name: 'Purple', color: '#a78bfa' },
    { name: 'Amber', color: '#fbbf24' },
    { name: 'Crimson', color: '#ef5b6b' },
    { name: 'Cyan', color: '#22d3ee' },
    { name: 'Rose', color: '#f472b6' },
    { name: 'Lime', color: '#a3e635' },
    { name: 'Orange', color: '#fb923c' },
    { name: 'Slate', color: '#94a3b8' },
];

export const IMPORTANCE_LABELS = ['Critical', 'Important', 'Standard', 'Supplementary'];

export const STRATEGIES = [
    { value: 'constant', label: 'Constant' },
    { value: 'normal', label: 'Normal' },
    { value: 'vectorized', label: 'Vectorized' },
];

export const POSITIONS = [
    { value: 0, label: 'Before Char. Defs' },
    { value: 1, label: 'After Char. Defs' },
    { value: 2, label: 'Top of Author Note' },
    { value: 3, label: 'Bottom of Author Note' },
    { value: 4, label: 'At Depth' },
    { value: 5, label: 'Before Example Msgs' },
    { value: 6, label: 'After Example Msgs' },
    { value: 7, label: 'Outlet' },
];

export const SELECTIVE_LOGIC = [
    { value: 0, label: 'AND ANY' },
    { value: 1, label: 'NOT ALL' },
    { value: 2, label: 'NOT ANY' },
    { value: 3, label: 'AND ALL' },
];

/* ------------------------------------------------------------ ST API bridge */

let moduleCache = null;
let nativeCacheGuard;

export async function initializeNativeCacheProtection() {
    const mod = await wiModule();
    nativeCacheGuard ??= observeNativeCache(mod.worldInfoCache);
}

export function confirmNativeBookUpdate(name, data) {
    nativeCacheGuard?.confirmNativeUpdate(name, data);
}

async function wiModule() {
    if (moduleCache) return moduleCache;
    try {
        moduleCache = await import(/* @vite-ignore */ WI_MODULE_PATH);
    } catch (error) {
        console.warn('[VisualLorebook] Could not import world-info.js, falling back to context API.', error);
        moduleCache = {};
    }
    return moduleCache;
}

async function resolveApi(name) {
    const context = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    if (context && typeof context[name] === 'function') {
        return context[name].bind(context);
    }
    const mod = await wiModule();
    if (typeof mod[name] === 'function') {
        return mod[name];
    }
    throw new Error(`[VisualLorebook] SillyTavern API "${name}" is unavailable in this build.`);
}

export async function listWorlds() {
    const context = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    if (context && Array.isArray(context.world_names) && context.world_names.length) {
        return [...context.world_names];
    }
    const mod = await wiModule();
    if (Array.isArray(mod.world_names)) {
        return [...mod.world_names];
    }
    return [];
}

export async function getActiveWorldName() {
    const context = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    if (context && typeof context.chatMetadata?.world_info === 'string' && context.chatMetadata.world_info) {
        return context.chatMetadata.world_info;
    }
    return null;
}

export async function loadBook(name) {
    if (!name) return null;
    const stored = await readStoredBook(name);
    if (!stored) return null;
    const mod = await wiModule();
    const nativeChanges = nativeCacheDiffers(mod.worldInfoCache, name, stored.json);
    baselines.set(stored.data, { name, json: stored.json, nativeChanges });
    return stored.data;
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const baselines = new WeakMap();

function validateBook(data) {
    if (!isRecord(data) || !isRecord(data.entries)) {
        throw new Error('Invalid lorebook entries. No data was repaired or overwritten.');
    }
}

class UnconfirmedSaveError extends Error {}

async function requestJson(path, body, label, saving = false) {
    const getRequestHeaders = await resolveApi('getRequestHeaders');
    const headers = getRequestHeaders();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
        response = await fetch(path, {
            method: 'POST', headers, body, cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status}).`);
        return await response.json();
    } catch (error) {
        if (response && !response.ok) throw error;
        const reason = controller.signal.aborted ? `${label} timed out.` : `${label} did not receive a usable response.`;
        if (saving) throw new UnconfirmedSaveError(reason, { cause: error });
        throw new Error(reason, { cause: error });
    } finally {
        clearTimeout(timer);
    }
}

async function readFileNames() {
    const worlds = await requestJson('/api/worldinfo/list', '{}', 'Listing lorebooks');
    if (!Array.isArray(worlds)) throw new Error('Invalid lorebook listing.');
    return worlds.map(world => world?.file_id).filter(name => typeof name === 'string');
}

async function readStoredBook(name, creating = false) {
    const data = await requestJson('/api/worldinfo/get', JSON.stringify({ name }), 'Reading lorebook');
    validateBook(data);
    const json = JSON.stringify(data);
    // The host returns this exact JSON for a missing file. Only that response
    // requires a library scan. Creation also checks case variants explicitly.
    if (json === EMPTY_BOOK_JSON) {
        const names = await readFileNames();
        const exists = creating
            ? names.some(file => file.toLowerCase() === name.toLowerCase())
            : names.includes(name);
        if (!exists) return null;
    }
    return { data, json };
}

function nativeCacheDiffers(cache, name, json) {
    if (nativeCacheGuard) return nativeCacheGuard.hasConflict(name, json);
    return Boolean(cache?.has(name) && JSON.stringify(cache.get(name)) !== json);
}

export function hadNativeChangesOnLoad(data) {
    return Boolean(baselines.get(data)?.nativeChanges);
}

/**
 * Every write for a given book is serialized through one queue. Callers can be
 * fire-and-forget (toggle switches, deletes, drags) without risking an older
 * request landing after a newer one.
 */
const saveQueues = new Map();
const staleBooks = new WeakSet();
const activeSavedPayloads = new WeakSet();
const unconfirmedWrites = new Set();
const UNCONFIRMED_SAVE = 'The server may still apply this write. Check the saved lorebook before refreshing SillyTavern and editing it again.';

export function invalidateBook(data) {
    if (data && typeof data === 'object') staleBooks.add(data);
}

export function isBookStale(data) {
    return staleBooks.has(data);
}

export function hasBookChanges(data) {
    const baseline = baselines.get(data);
    return Boolean(data && (!baseline || JSON.stringify(data) !== baseline.json));
}

export function isSameBookVersion(first, second) {
    const a = baselines.get(first), b = baselines.get(second);
    return Boolean(a && b && a.name === b.name && a.json === b.json);
}

export function isOwnBookUpdate(data) {
    return Boolean(
        data && typeof data === 'object' && activeSavedPayloads.has(data),
    );
}

export async function saveBook(name, data) {
    if (!name || !data) return false;
    validateBook(data);
    const key = name.toLowerCase();
    // The serialized snapshot is also the request payload and saved baseline.
    const json = JSON.stringify(data);
    const previous = saveQueues.get(key) || Promise.resolve();
    const run = previous.then(() => writeBook(name, key, data, json));
    // Store a settled-safe tail so one rejection cannot poison later saves.
    const tail = run.catch(() => {}).finally(() => {
        if (saveQueues.get(key) === tail) saveQueues.delete(key);
    });
    saveQueues.set(key, tail);
    return run;
}

async function writeBook(name, key, data, json) {
    if (unconfirmedWrites.has(key)) throw new Error(UNCONFIRMED_SAVE);
    const baseline = baselines.get(data);
    if (!baseline || baseline.name !== name) throw new Error('Reload this lorebook before saving.');
    const mod = await wiModule();
    const context = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    // These exports and the endpoints below are verified against installed ST.
    // Fail closed on builds where we cannot safely synchronize the native cache.
    if (!mod.worldInfoCache?.set || !context?.eventSource?.emit || !context.event_types?.WORLDINFO_UPDATED) {
        throw new Error('This SillyTavern build does not expose the verified lorebook persistence APIs.');
    }
    const stored = await readStoredBook(name, baseline.json === null);
    if (staleBooks.has(data) || (stored?.json ?? null) !== baseline.json) {
        invalidateBook(data);
        throw new Error(
            'This lorebook changed outside Codex. Copy your draft, close the editor to reload, then reapply your changes.',
        );
    }
    if (nativeCacheGuard?.isUncertain(name)) {
        throw new Error('A native save could not be confirmed. Keep a copy of your draft and verify the saved lorebook before refreshing SillyTavern.');
    }
    if (nativeCacheDiffers(mod.worldInfoCache, name, baseline.json)) {
        throw new Error('SillyTavern has pending or different native edits. Keep your draft, then finish or retry the save in the native World Info editor. Reopen Codex to load the saved version.');
    }
    const nativeRevision = nativeCacheGuard?.revision(name);
    // ST's saveWorldInfo currently ignores HTTP errors and publishes to the cache
    // before the request succeeds. Use the same atomic server endpoint, checking
    // its acknowledgement before publishing to the native cache/event bus.
    try {
        const body = `{"name":${JSON.stringify(name)},"data":${json}}`;
        const result = await requestJson('/api/worldinfo/edit', body, 'Saving lorebook', true);
        if (result?.ok !== true) throw new UnconfirmedSaveError('SillyTavern did not acknowledge the lorebook save.');
    } catch (error) {
        if (!(error instanceof UnconfirmedSaveError)) throw error;
        // Aborting the browser request cannot cancel a server-side file write.
        unconfirmedWrites.add(key);
        invalidateBook(data);
        throw new Error(`${error.message} ${UNCONFIRMED_SAVE}`, { cause: error });
    }
    if (staleBooks.has(data) || nativeCacheDiffers(mod.worldInfoCache, name, baseline.json)
        || nativeRevision !== nativeCacheGuard?.revision(name)) {
        invalidateBook(data);
        throw new Error('Another component changed this lorebook during the save. The request completed, but its final state needs verification. Keep a copy of your draft and reload; no automatic retry will overwrite it.');
    }
    baseline.json = json;
    baseline.nativeChanges = false;
    const payload = JSON.parse(json);
    if (nativeCacheGuard) nativeCacheGuard.publish(name, payload);
    else mod.worldInfoCache.set(name, JSON.parse(json));
    activeSavedPayloads.add(payload);
    void notifyBookSaved(context, name, payload);
    void refreshNativeEditor(name);
    return true;
}

async function notifyBookSaved(context, name, payload) {
    try {
        await context.eventSource.emit(context.event_types.WORLDINFO_UPDATED, name, payload);
    } catch (error) {
        // The file is already committed. A foreign listener failure must not be
        // reported as a failed write or roll back the editor's committed state.
        console.warn('[VisualLorebook] Lorebook saved, but an update listener failed.', error);
    }
}

/**
 * SillyTavern refreshes its prompt-side cache inside `saveWorldInfo`, but the
 * World Info drawer keeps its own rendered copy. Nudging ST's own reloadEditor
 * makes the native panel reflect Codex edits without a page reload.
 */
async function refreshNativeEditor(name) {
    if (!name) return;
    try {
        const context = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        const reload = context?.reloadWorldInfoEditor || context?.reloadEditor;
        if (typeof reload === 'function') {
            await reload.call(context, name);
            return;
        }
        const mod = await wiModule();
        if (typeof mod.reloadEditor === 'function') {
            await mod.reloadEditor(name);
        }
    } catch (error) {
        console.warn('[VisualLorebook] Native editor refresh skipped.', error);
    }
}

export async function createBook(name) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('A lorebook name is required.');

    // The server saves sanitize(`${name}.json`). Validate the exact filename it
    // will use, otherwise a name like "A:B" can silently replace "AB".
    const filename = `${clean}.json`;
    const sanitized = await requestJson('/api/files/sanitize-filename', JSON.stringify({ fileName: filename }), 'Checking lorebook filename');
    if (sanitized?.fileName !== filename) {
        throw new Error('Use a valid lorebook filename without reserved characters.');
    }

    const existing = await listWorlds();
    if (existing.some(name => name.toLowerCase() === clean.toLowerCase())) {
        throw new Error(`A lorebook named "${clean}" already exists.`);
    }

    const data = { entries: {} };
    ensureCategories(data, true);
    baselines.set(data, { name: clean, json: null });
    await saveBook(clean, data);

    // Rebuild native selectors as well as the live name array. Pushing into the
    // array alone leaves the new lorebook absent from the native drawer.
    const mod = await wiModule();
    void resolveApi('updateWorldInfoList').then(update => update()).catch(error => {
        console.warn('[VisualLorebook] Book created, but native selector refresh failed.', error);
    });
    if (Array.isArray(mod.world_names) && !mod.world_names.includes(clean)) {
        mod.world_names.push(clean);
    }
    const context = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    if (context && Array.isArray(context.world_names) && !context.world_names.includes(clean)) {
        context.world_names.push(clean);
    }
    return clean;
}

export async function deleteBook(name) {
    const deleteWorldInfo = await resolveApi('deleteWorldInfo');
    await deleteWorldInfo(name);
}

/* ---------------------------------------------------------------- categories */

export function defaultCategories() {
    return [
        { id: 'uncategorized', name: 'Uncategorized', color: '#8b8b96', order: 0, collapsed: false, locked: true },
        { id: 'character', name: 'Character', color: '#5b8def', order: 1, collapsed: false },
        { id: 'location', name: 'Location', color: '#34d399', order: 2, collapsed: false },
        { id: 'faction', name: 'Faction', color: '#a78bfa', order: 3, collapsed: false },
        { id: 'rule', name: 'Rule', color: '#fbbf24', order: 4, collapsed: false },
    ];
}

export function newCategoryId() {
    return `cat_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeCategory(raw, index) {
    raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
        ...raw,
        id: typeof raw.id === 'string' && raw.id ? raw.id : `invalid_${index}`,
        name: typeof raw.name === 'string' && raw.name ? raw.name : 'Untitled',
        // Colours are interpolated into `style="--x: VALUE"`, so anything that is
        // not a plain hex triplet would allow CSS injection from a lorebook file.
        color: sanitizeColor(raw.color, PALETTE[index % PALETTE.length].color),
        order: Number.isFinite(raw.order) ? raw.order : index,
        collapsed: Boolean(raw.collapsed),
        locked: raw.id === 'uncategorized' || Boolean(raw.locked),
    };
}

/**
 * Returns the category list for a lorebook, creating and persisting defaults
 * the first time the book is opened by this extension.
 */
export function ensureCategories(data, forceDefaults = false) {
    if (!data) return [];
    ensureMetadataObject(data, 'extensions');
    const existing = data.extensions[SCHEMA_KEY];
    if (existing !== undefined && !isRecord(existing)) throw new Error('Invalid visual metadata. No data was replaced.');
    if (existing?.categories !== undefined && !Array.isArray(existing.categories)) throw new Error('Invalid category metadata. No data was replaced.');
    if (forceDefaults || !existing || !Array.isArray(existing.categories) || !existing.categories.length) {
        data.extensions[SCHEMA_KEY] = {
            ...(existing && typeof existing === 'object' ? existing : {}),
            version: existing?.version ?? SCHEMA_VERSION,
            categories: defaultCategories(),
        };
        return data.extensions[SCHEMA_KEY].categories;
    }
    return existing.categories;
}

export function getCategories(data) {
    // A display projection only: viewing a native book must never normalize its
    // persisted metadata, downgrade a future schema or install default fields.
    const raw = data?.extensions?.[SCHEMA_KEY]?.categories;
    const cats = Array.isArray(raw) && raw.length
        ? raw.filter(cat => isRecord(cat) && typeof cat.id === 'string' && cat.id).map(normalizeCategory)
        : defaultCategories();
    if (!cats.some(cat => cat.id === 'uncategorized')) cats.unshift(defaultCategories()[0]);
    const ids = new Set();
    const unique = cats.filter(cat => !ids.has(cat.id) && ids.add(cat.id));
    return unique.sort((a, b) => a.order - b.order);
}

export function setCategories(data, categories) {
    const existing = new Map();
    for (const cat of ensureCategories(data)) {
        if (!isRecord(cat) || typeof cat.id !== 'string' || !cat.id || existing.has(cat.id)) {
            throw new Error('Categories cannot be reordered while their stored identifiers are malformed or duplicated.');
        }
        existing.set(cat.id, cat);
    }
    data.extensions[SCHEMA_KEY].categories = categories.map((cat, index) => ({ ...(existing.get(cat.id) || cat), order: index }));
    return data.extensions[SCHEMA_KEY].categories;
}

export function getCategory(data, categoryId) {
    const cats = getCategories(data);
    return cats.find(cat => cat.id === categoryId) || cats.find(cat => cat.id === 'uncategorized') || cats[0];
}

export function addCategory(data, name, color) {
    const cats = ensureCategories(data);
    const maxOrder = cats.reduce((max, cat, index) => Math.max(max, Number.isFinite(cat?.order) ? cat.order : index), -1);
    const ids = new Set(cats.map(cat => cat?.id));
    const base = newCategoryId();
    let id = base;
    for (let suffix = 1; ids.has(id); suffix++) id = `${base}_${suffix}`;
    const cat = normalizeCategory({
        id,
        name: name || 'New Category',
        color: color || PALETTE[cats.length % PALETTE.length].color,
        order: maxOrder + 1,
    }, cats.length);
    cats.push(cat);
    return cat;
}

export function updateCategory(data, categoryId, patch) {
    const cats = ensureCategories(data);
    if (categoryId === 'uncategorized' && ('name' in patch || 'color' in patch)) return;
    const cat = findUniqueCategory(cats, categoryId);
    if (cat) Object.assign(cat, patch, { id: cat.id });
    else if (categoryId === 'uncategorized') cats.push({ ...defaultCategories()[0], ...patch, id: categoryId });
}

export function removeCategory(data, categoryId) {
    const cats = ensureCategories(data);
    const target = findUniqueCategory(cats, categoryId);
    if (!target || target.locked || categoryId === 'uncategorized') return false;
    const replacements = [];
    for (const {key, entry} of entriesOf(data)) {
        const visual = getEntryVisual(entry);
        if (visual.categoryId === categoryId) {
            const copy = structuredClone(entry);
            setEntryVisual(copy, { categoryId: 'uncategorized' });
            replacements.push([key, copy]);
        }
    }
    const remaining = cats.filter(cat => cat !== target);
    data.extensions[SCHEMA_KEY].categories = remaining;
    for (const [key, copy] of replacements) data.entries[key] = copy;
    return true;
}

function findUniqueCategory(categories, id) {
    const matches = categories.filter(cat => isRecord(cat) && cat.id === id);
    if (matches.length > 1) throw new Error('This category has a duplicate identifier. Its stored records were preserved.');
    return matches[0];
}

/* ------------------------------------------------------------------- entries */

export function entryUid(entry) {
    const uid = entry?.uid;
    return typeof uid === 'string' || Number.isSafeInteger(uid) ? String(uid) : '';
}

export function getEntryVisual(entry) {
    const ext = entry && entry.extensions && typeof entry.extensions === 'object' ? entry.extensions : null;
    const raw = ext && ext[SCHEMA_KEY] && typeof ext[SCHEMA_KEY] === 'object' ? ext[SCHEMA_KEY] : {};
    return {
        categoryId: typeof raw.categoryId === 'string' && raw.categoryId ? raw.categoryId : 'uncategorized',
        image: typeof raw.image === 'string' ? raw.image : '',
        importanceLabel: typeof raw.importanceLabel === 'string' && raw.importanceLabel ? raw.importanceLabel : '',
        linkedEntryUids: Array.isArray(raw.linkedEntryUids) ? raw.linkedEntryUids
            .filter(uid => typeof uid === 'string' || Number.isSafeInteger(uid)).map(String) : [],
        sortOrder: Number.isFinite(raw.sortOrder) ? raw.sortOrder : 0,
    };
}

export function setEntryVisual(entry, patch) {
    if (!entry) return;
    ensureMetadataObject(entry, 'extensions');
    const raw = entry.extensions[SCHEMA_KEY];
    if (raw !== undefined && !isRecord(raw)) throw new Error('Invalid entry visual metadata. No data was replaced.');
    const preserved = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    entry.extensions[SCHEMA_KEY] = { ...preserved, ...patch };
    return entry.extensions[SCHEMA_KEY];
}

function ensureMetadataObject(parent, key) {
    if (parent[key] === undefined) parent[key] = {};
    if (!isRecord(parent[key])) throw new Error(`Invalid ${key} metadata. No data was replaced.`);
}

export function entriesOf(data) {
    if (!data || !data.entries || typeof data.entries !== 'object') return [];
    return Object.entries(data.entries)
        .map(([key, entry]) => ({ key, entry }))
        .filter(item => isRecord(item.entry));
}

/**
 * Finds an entry by uid even when the `entries` object key and `entry.uid`
 * disagree (common in hand-edited or imported lorebooks).
 */
export function findEntry(data, uid) {
    if (!data || !data.entries) return null;
    if (typeof uid !== 'string' && !Number.isSafeInteger(uid)) return null;
    const matches = entriesOf(data).filter(({entry}) => entryUid(entry) && entryUid(entry) === String(uid));
    if (matches.length > 1) return null;
    return matches[0]?.entry || null;
}

export function sortedEntries(data) {
    const list = entriesOf(data);
    list.sort((a, b) => {
        const va = getEntryVisual(a.entry).sortOrder;
        const vb = getEntryVisual(b.entry).sortOrder;
        if (va !== vb) return va - vb;
        return Number(entryUid(a.entry) || a.key) - Number(entryUid(b.entry) || b.key);
    });
    return list;
}

export function nextSortOrder(data, categoryId) {
    let max = -1;
    for (const { entry } of entriesOf(data)) {
        const visual = getEntryVisual(entry);
        if (visual.categoryId === categoryId) {
            max = Math.max(max, visual.sortOrder);
        }
    }
    return max + 1;
}

export function entryTitle(entry) {
    const comment = typeof entry?.comment === 'string' ? entry.comment.trim() : '';
    if (comment) return comment;
    const keys = Array.isArray(entry?.key) ? entry.key.filter(key => typeof key === 'string' && key.trim()) : [];
    if (keys.length) return keys[0];
    const content = typeof entry?.content === 'string' ? entry.content.trim() : '';
    if (content) return content.slice(0, 48);
    return `Entry ${entryUid(entry)}`.trim();
}

export function entryContent(entry) {
    return typeof entry?.content === 'string' ? entry.content : '';
}

export function entrySubtitle(entry) {
    const visual = getEntryVisual(entry);
    if (visual.importanceLabel) return visual.importanceLabel;
    if (entry?.constant) return 'Constant';
    if (entry?.vectorized) return 'Vectorized';
    return 'Standard';
}

export function strategyOf(entry) {
    if (entry?.constant) return 'constant';
    if (entry?.vectorized) return 'vectorized';
    return 'normal';
}

export function applyStrategy(entry, strategy) {
    if (!entry) return;
    entry.constant = strategy === 'constant';
    entry.vectorized = strategy === 'vectorized';
}

export function freeUid(data) {
    let max = 0;
    // Reserve every storage key, including records too malformed to display.
    const used = new Set(Object.keys(data?.entries || {}));
    for (const {entry} of entriesOf(data)) used.add(entryUid(entry));
    for (const value of used) {
        const numeric = Number(value);
        if (Number.isSafeInteger(numeric) && numeric >= 0) max = Math.max(max, numeric);
    }
    if (max < Number.MAX_SAFE_INTEGER) return max + 1;
    let uid = 0;
    while (used.has(String(uid))) uid++;
    return uid;
}

export function blankEntry(data, categoryId) {
    const uid = freeUid(data);
    return {
        uid,
        key: [],
        keysecondary: [],
        comment: '',
        content: '',
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: false,
        order: 100,
        position: 0,
        disable: false,
        ignoreBudget: false,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: true,
        depth: 4,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: 0,
        sticky: null,
        cooldown: null,
        delay: null,
        matchPersonaDescription: false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
        outletName: '',
        triggers: [],
        extensions: {
            [SCHEMA_KEY]: {
                categoryId: categoryId || 'uncategorized',
                image: '',
                importanceLabel: 'Standard',
                linkedEntryUids: [],
                sortOrder: nextSortOrder(data, categoryId || 'uncategorized'),
            },
        },
    };
}

/**
 * Creates an entry through SillyTavern's own factory when available so every
 * native default matches the current build, then layers our metadata on top.
 */
export async function createEntry(worldName, data, categoryId) {
    const fallback = blankEntry(data, categoryId);
    let entry = null;

    try {
        const createWorldInfoEntry = await resolveApi('createWorldInfoEntry');
        // The native factory inserts immediately. Run it against a detached
        // container so re-keying cannot leave an extra entry in the real book.
        const created = await createWorldInfoEntry(worldName, {entries: structuredClone(data.entries)});
        if (created && typeof created === 'object') {
            entry = created;
        }
    } catch (error) {
        console.warn('[VisualLorebook] createWorldInfoEntry unavailable, using local template.', error);
    }

    if (!entry) {
        entry = fallback;
    } else {
        // Re-key against a guaranteed-free uid and fill any missing native fields.
        entry.uid = freeUid(data);
        for (const [key, value] of Object.entries(fallback)) {
            if (entry[key] === undefined) entry[key] = value;
        }
        if (!entry.extensions || typeof entry.extensions !== 'object') entry.extensions = {};
    }

    entry.extensions[SCHEMA_KEY] = {
        ...getEntryVisual(entry),
        categoryId: categoryId || 'uncategorized',
        sortOrder: nextSortOrder(data, categoryId || 'uncategorized'),
    };

    const key = String(entry.uid);
    data.entries[key] = entry;
    try { await saveBook(worldName, data); }
    catch (error) { if (data.entries[key] === entry) delete data.entries[key]; throw error; }
    return entry;
}

export async function deleteEntry(worldName, data, uid) {
    await deleteEntries(worldName, data, [uid]);
}

/**
 * Deletes several entries in a single write. Also strips now-dangling
 * `linkedEntryUids` references left over from older versions of the extension.
 */
export async function deleteEntries(worldName, data, uids) {
    const wanted = new Set(uids.map(String));
    const index = indexEntries(data);
    const targets = [...wanted].map(uid => index.get(uid));
    if (targets.some(entry => !entry)) throw new Error('An entry is missing or has an ambiguous UID. Reload before deleting.');
    const original = data.entries;
    const targetSet = new Set(targets);
    const updated = {...original};
    for (const [key, entry] of Object.entries(updated)) if (targetSet.has(entry)) delete updated[key];
    for (const [key, entry] of Object.entries(updated)) {
        if (!isRecord(entry)) continue;
        const links = entry.extensions?.[SCHEMA_KEY]?.linkedEntryUids;
        if (!Array.isArray(links)) continue;
        const kept = links.filter(link => !((typeof link === 'string' || Number.isSafeInteger(link)) && wanted.has(String(link))));
        if (kept.length !== links.length) {
            updated[key] = structuredClone(entry);
            setEntryVisual(updated[key], { linkedEntryUids: kept });
        }
    }
    data.entries = updated;
    try { await saveBook(worldName, data); }
    catch (error) { if (data.entries === updated) data.entries = original; throw error; }
}

/** Flips the native `disable` flag on one entry and persists immediately. */
export async function setEntryDisabled(worldName, data, uid, disabled) {
    const entry = findEntry(data, uid);
    if (!entry) return null;
    const hadFlag = Object.hasOwn(entry, 'disable');
    const previous = entry.disable;
    entry.disable = Boolean(disabled);
    try { await saveBook(worldName, data); }
    catch (error) {
        if (entry.disable === Boolean(disabled)) {
            if (hadFlag) entry.disable = previous;
            else delete entry.disable;
        }
        throw error;
    }
    return entry;
}

/**
 * Applies an explicit ordering array of uids to a category. Entries in that
 * category not present in the array keep their relative order after it.
 */
export function applyOrder(data, categoryId, orderedUids) {
    const index = indexEntries(data);
    const ordered = [...new Set(orderedUids.map(String))];
    if (ordered.some(uid => !index.get(uid))) throw new Error('An entry identifier is missing or ambiguous. No order was saved.');
    const seen = new Set();
    let cursor = 0;
    for (const uid of ordered) {
        const entry = index.get(uid);
        setEntryVisual(entry, { categoryId, sortOrder: cursor++ });
        seen.add(String(uid));
    }
    for (const { entry } of sortedEntries(data)) {
        const visual = getEntryVisual(entry);
        if (visual.categoryId === categoryId && !seen.has(entryUid(entry))) {
            setEntryVisual(entry, { sortOrder: cursor++ });
        }
    }
}

function indexEntries(data) {
    const index = new Map();
    for (const {entry} of entriesOf(data)) {
        const uid = entryUid(entry);
        if (!uid) continue;
        index.set(uid, index.has(uid) ? null : entry);
    }
    return index;
}

/* -------------------------------------------------------------- image helper */

/**
 * Downscales and compresses an image File/Blob into a WebP data URI so a
 * lorebook JSON never carries multi-megabyte payloads.
 */
export function compressImage(file, maxSize = 250, quality = 0.8) {
    return new Promise((resolve, reject) => {
        if (!file || !file.type || !file.type.startsWith('image/')) {
            reject(new Error('That file is not an image.'));
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read the image file.'));
        reader.onabort = () => reject(new Error('Image reading was cancelled.'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('Could not decode the image file.'));
            img.onload = () => {
                try {
                    const ratio = Math.min(1, maxSize / Math.max(img.width, img.height));
                    const width = Math.max(1, Math.round(img.width * ratio));
                    const height = Math.max(1, Math.round(img.height * ratio));
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        reject(new Error('Canvas is unavailable in this browser.'));
                        return;
                    }
                    ctx.imageSmoothingEnabled = true;
                    ctx.imageSmoothingQuality = 'high';
                    ctx.drawImage(img, 0, 0, width, height);
                    try {
                        const webp = canvas.toDataURL('image/webp', quality);
                        if (webp.startsWith('data:image/webp')) {
                            resolve(webp);
                            return;
                        }
                    } catch { /* fall through to PNG */ }
                    resolve(canvas.toDataURL('image/png'));
                } catch (error) {
                    reject(new Error(`Could not process the image: ${error.message}`));
                }
            };
            img.src = String(reader.result || '');
        };
        reader.readAsDataURL(file);
    });
}

export async function imageFromClipboardEvent(event) {
    const items = event?.clipboardData?.items;
    if (!items) return null;
    for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) return compressImage(file);
        }
    }
    return null;
}

/* ------------------------------------------------------------------ utilities */

/**
 * Category colours end up inside a `style="--cat-color: …"` attribute. A value
 * like `red; background-image: url(https://evil/x)` would otherwise inject CSS
 * (and leak a request) from a hostile lorebook, so only hex triplets are kept.
 */
export function sanitizeColor(value, fallback = '#8b8b96') {
    const raw = typeof value === 'string' ? value.trim() : '';
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw) ? raw.toLowerCase() : fallback;
}

/**
 * Thumbnails come from lorebook metadata and are written into `<img src>`.
 * Only http(s), image data-URIs, blob URLs and relative paths are allowed;
 * `javascript:`, `vbscript:` and `data:text/html` are dropped.
 */
export function sanitizeImageSrc(value) {
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) return '';
    const raw = value.trim();
    if (!raw) return '';
    if (/^data:image\//i.test(raw) || /^(https?:|blob:)/i.test(raw)) return raw;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return '';
    // Spaces are legal in browser-served paths. Keep the existing restriction
    // on quote and angle characters in relative paths.
    if (/[<>"']/.test(raw)) return '';
    return raw;
}

export function escapeHtml(value) {
    return (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function truncate(value, max) {
    // Slice first: collapsing whitespace over a multi-megabyte entry is wasted
    // work when only `max` characters are ever shown.
    const source = String(value ?? '').slice(0, Math.max(max * 4, max + 1));
    const text = source.replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export async function parseKeyList(value) {
    // Native parser understands commas inside slash-delimited regexes, e.g.
    // `/a{1,3}/i`; a blind split would turn that into two broken keys.
    const splitKeywordsAndRegexes = await resolveApi('splitKeywordsAndRegexes');
    const keys = await splitKeywordsAndRegexes(String(value ?? ''));
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string')) throw new Error('The native keyword parser returned invalid keys.');
    return keys;
}

/** Content only; no prompt wrappers, macro expansion or padding. */
export async function countContentTokens(value) {
    const text = String(value ?? '');
    if (!text) return 0;
    const context = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    const operation = typeof context?.getTokenCountAsync === 'function'
        ? context.getTokenCountAsync(text, 0)
        : import('/scripts/tokenizers.js').then(module => module.getTokenCountAsync(text, 0));
    let timer;
    let count;
    try {
        count = await Promise.race([operation, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Tokenizer timed out.')), 20000);
        })]);
    } finally {
        clearTimeout(timer);
    }
    if (!Number.isFinite(count) || count < 0) throw new Error('Tokenizer returned an invalid count.');
    return count;
}

/** Detached duplicate: nothing is inserted until the new editor is saved. */
export function duplicateEntryDraft(data, entry) {
    const copy = structuredClone(entry);
    copy.uid = freeUid(data);
    copy.comment = `${entryTitle(entry)} (copy)`;
    setEntryVisual(copy, { sortOrder: nextSortOrder(data, getEntryVisual(copy).categoryId) });
    return copy;
}

export function colorForCategory(data, categoryId) {
    return getCategory(data, categoryId)?.color || '#5b8def';
}
