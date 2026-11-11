/**
 * editor.js — entry editor + category manager modals.
 *
 * The editor writes straight into the native World Info entry object, so the
 * user never has to leave the Codex to flip Constant / Vectorized / Depth and
 * the rest of SillyTavern's trigger mechanics.
 */

import {
    IMPORTANCE_LABELS,
    PALETTE,
    POSITIONS,
    SELECTIVE_LOGIC,
    STRATEGIES,
    addCategory,
    applyStrategy,
    blankEntry,
    countContentTokens,
    deleteEntry,
    duplicateEntryDraft,
    entryContent,
    entryTitle,
    escapeHtml,
    freeUid,
    getEntryVisual,
    hasBookChanges,
    nextSortOrder,
    parseKeyList,
    removeCategory,
    setCategories,
    sanitizeImageSrc,
    setEntryVisual,
    strategyOf,
    updateCategory,
} from './store.js';
import { cropThumbnail } from './thumbnail-crop.js';

/* --------------------------------------------------------------- modal shell */

let modalCloseHook = null;

/** Registered by ui.js so it can flush work that was deferred while a modal was open. */
export function setModalCloseHook(hook) {
    modalCloseHook = typeof hook === 'function' ? hook : null;
}

function createModal({ title, body, footer, small = false, onClose, beforeClose }) {
    const previousFocus = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.className = 'st-codex-modal-backdrop';
    backdrop.innerHTML = `
        <div class="st-codex-modal ${small ? 'st-codex-modal-sm' : ''}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
            <div class="st-codex-modal-head">
                <div class="st-codex-modal-title">${escapeHtml(title)}</div>
                <button class="st-codex-modal-close" type="button" title="Close">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            ${body}
            ${footer || ''}
        </div>`;

    let closed = false;
    let checkingClose = false;
    const close = () => {
        if (closed) return;
        closed = true;
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
        onClose?.();
        modalCloseHook?.();
        if (previousFocus?.isConnected) previousFocus.focus({preventScroll: true});
    };
    const requestClose = async () => {
        if (closed || checkingClose) return;
        checkingClose = true;
        try {
            if (!beforeClose || await beforeClose()) close();
        } catch (error) {
            console.error('[VisualLorebook] Could not close dialog; changes were retained.', error);
        } finally {
            checkingClose = false;
        }
    };
    const onKey = event => {
        // Stacked dialogs (confirm over editor) must not all close at once.
        const open = document.querySelectorAll('.st-codex-modal-backdrop');
        if (open[open.length - 1] !== backdrop) return;
        if (event.key === 'Tab') {
            const controls = [...backdrop.querySelectorAll('button, input, textarea, select, summary, [tabindex="0"]')]
                .filter(element => !element.disabled && element.getClientRects().length
                    && (!element.closest('details:not([open])') || element.matches('summary')));
            const first = controls[0], last = controls.at(-1);
            if (first && (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            }
            return;
        }
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        event.stopImmediatePropagation();
        requestClose();
    };

    backdrop.querySelector('.st-codex-modal-close').addEventListener('click', requestClose);
    backdrop.addEventListener('mousedown', event => {
        if (event.target === backdrop) requestClose();
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    backdrop.__close = requestClose;
    backdrop.__forceClose = close;
    return backdrop;
}

/* ----------------------------------------------------------- confirm dialog */

/**
 * Promise-based confirmation modal. Resolves true only when the user presses
 * the confirm button — closing via X, backdrop or Escape resolves false.
 */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
    return new Promise(resolve => {
        let settled = false;
        const settle = value => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        const modal = createModal({
            title,
            small: true,
            onClose: () => settle(false),
            body: `<div class="st-codex-modal-body">
                       <p class="st-codex-confirm-text">${message}</p>
                   </div>
                   <div class="st-codex-modal-foot">
                       <div class="st-codex-foot-spacer"></div>
                       <button class="st-codex-btn st-codex-btn-cancel" id="st-codex-confirm-cancel" type="button">Cancel</button>
                       <button class="st-codex-btn ${danger ? 'st-codex-btn-danger' : 'st-codex-btn-primary'}"
                               id="st-codex-confirm-ok" type="button">${escapeHtml(confirmLabel)}</button>
                   </div>`,
        });

        modal.querySelector('#st-codex-confirm-cancel').addEventListener('click', () => modal.__close());
        modal.querySelector('#st-codex-confirm-ok').addEventListener('click', () => {
            settle(true);
            modal.__close();
        });
        setTimeout(() => modal.querySelector('#st-codex-confirm-ok')?.focus(), 40);
    });
}

/* ------------------------------------------------------------- entry editor */

function unsavedChangesDialog(subject = 'entry') {
    return new Promise(resolve => {
        const modal = createModal({
            title: 'Save changes before leaving?',
            small: true,
            onClose: () => resolve('keep'),
            body: `<div class="st-codex-modal-body">
                <p class="st-codex-confirm-text">This ${escapeHtml(subject)} has unsaved changes. Would you like to save them before closing?</p>
            </div>
            <div class="st-codex-modal-foot">
                <button class="st-codex-btn" data-choice="keep" type="button">Keep editing</button>
                <div class="st-codex-foot-spacer"></div>
                <button class="st-codex-btn st-codex-btn-danger" data-choice="discard" type="button">Discard</button>
                <button class="st-codex-btn st-codex-btn-primary" data-choice="save" type="button">Save</button>
            </div>`,
        });
        modal.querySelectorAll('[data-choice]').forEach(button => {
            button.addEventListener('click', () => {
                resolve(button.dataset.choice);
                modal.__close();
            });
        });
        modal.querySelector('[data-choice="keep"]').focus();
    });
}

export function openEntryEditor(app, entry, defaultCategoryId, { duplicateOf } = {}) {
    if (!app.data || !app.worldName || app.busy || document.querySelector('.st-codex-modal-backdrop')) return;

    const isNew = !entry;
    const data = app.data;
    let draft;
    try {
        draft = isNew
            ? (duplicateOf ? duplicateEntryDraft(data, duplicateOf) : blankEntry(data, defaultCategoryId || 'uncategorized'))
            : structuredClone(entry);
    } catch (error) {
        app.toast(error.message || 'Could not open this entry.', true);
        return;
    }
    const worldName = app.worldName;
    let entryKey = isNew ? String(draft.uid)
        : Object.keys(data.entries).find(key => data.entries[key] === entry) ?? String(draft.uid);
    const visual = getEntryVisual(draft);
    const originalEntry = draft;

    let imageValue = visual.image || '';
    const selectedCategory = app.categories.some(category => category.id === visual.categoryId) ? visual.categoryId : 'uncategorized';
    let saving = false;
    let initialState;
    let saveEntry;

    const keyField = (id, label, placeholder, help) => `
        <div class="st-codex-field st-codex-key-field">
            <div class="st-codex-key-heading">
                <label class="st-codex-label" for="${id}">${label}</label>
                <div class="st-codex-key-controls">
                  <div class="st-codex-key-modes" role="group" aria-label="${label} display">
                    <button type="button" data-key-mode="text" aria-pressed="true">Text</button>
                    <button type="button" data-key-mode="tags" aria-pressed="false">Tags</button>
                  </div>
                  <button class="st-codex-key-delete-mode" type="button" aria-pressed="false" hidden>Delete mode</button>
                </div>
            </div>
            <textarea class="st-codex-input st-codex-key-text" id="${id}" rows="2"
                placeholder="${placeholder}" aria-describedby="${id}-help"></textarea>
            <div class="st-codex-key-tags" hidden aria-label="${label} tags"></div>
            <span class="st-codex-hint" id="${id}-help">${help}</span>
        </div>`;

    const categoryOptions = app.categories
        .map(cat => `<option value="${escapeHtml(cat.id)}" ${cat.id === selectedCategory ? 'selected' : ''}>${escapeHtml(cat.name)}</option>`)
        .join('');

    const strategyOptions = STRATEGIES
        .map(item => `<option value="${item.value}" ${strategyOf(draft) === item.value ? 'selected' : ''}>${escapeHtml(item.label)}</option>`)
        .join('');

    const nativeNumber = value => typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' ? Number(value) : NaN;
    const enumOptions = (options, stored) => {
        const value = nativeNumber(stored ?? 0);
        const known = options.some(option => option.value === value);
        const extra = known ? '' : `<option value="stored" selected>${Number.isFinite(value) ? `Native value (${value})` : 'Stored value (unsupported)'}</option>`;
        return extra + options.map(item => `<option value="${item.value}" ${value === item.value ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('');
    };
    const positionOptions = enumOptions(POSITIONS, draft.position);
    const logicOptions = enumOptions(SELECTIVE_LOGIC, draft.selectiveLogic);
    const roleOptions = enumOptions([{value: 0, label: 'System'}, {value: 1, label: 'User'}, {value: 2, label: 'Assistant'}], draft.role);

    const toggleSetting = (id, label, checked, hint = '') => `
        <label class="st-codex-setting st-codex-setting-toggle" for="${id}">
            <span class="st-codex-setting-label">
                <span>${label}</span>
                ${hint ? `<small>${hint}</small>` : ''}
            </span>
            <span class="st-codex-tog">
                <input type="checkbox" role="switch" id="${id}" aria-label="${escapeHtml(label)}" ${checked ? 'checked' : ''}>
                <span class="st-codex-tog-track"><span></span></span>
            </span>
        </label>`;

    const triSetting = (id, label, value, hint = '') => `
        <div class="st-codex-setting">
            <span class="st-codex-setting-label">
                <span>${label}</span>
                ${hint ? `<small>${hint}</small>` : ''}
            </span>
            <select class="st-codex-select st-codex-select-sm" id="${id}">
                <option value="" ${value === null || value === undefined ? 'selected' : ''}>Default</option>
                <option value="true" ${value === true ? 'selected' : ''}>On</option>
                <option value="false" ${value === false ? 'selected' : ''}>Off</option>
            </select>
        </div>`;

    const numberSetting = (id, label, value, hint = '', attrs = '') => `
        <div class="st-codex-setting">
            <span class="st-codex-setting-label">
                <span>${label}</span>
                ${hint ? `<small>${hint}</small>` : ''}
            </span>
            <input class="st-codex-input st-codex-input-sm" id="${id}" type="number" ${attrs}
                   value="${value === null || value === undefined || value === '' ? '' : escapeHtml(String(value))}">
        </div>`;

    const orDefault = (value, fallback) => (Number.isFinite(nativeNumber(value)) ? nativeNumber(value) : fallback);
    const nullable = value => orDefault(value, '');

    const body = `
        <div class="st-codex-tabs">
            <button class="st-codex-tab st-codex-tab-active" data-tab="visual" type="button" aria-pressed="true" aria-controls="st-codex-editor-visual">
                <i class="fa-solid fa-image"></i> Visual &amp; Content
            </button>
            <button class="st-codex-tab" data-tab="settings" type="button" aria-pressed="false" aria-controls="st-codex-editor-settings">
                <i class="fa-solid fa-sliders"></i> Entry Settings
            </button>
        </div>
        <div class="st-codex-modal-body">
            <div class="st-codex-panel st-codex-entry-workspace" id="st-codex-editor-visual" data-panel="visual">
                <div class="st-codex-entry-identity">
                    <div>
                        <label class="st-codex-label" for="st-codex-ed-title">Entry Title</label>
                        <input class="st-codex-input st-codex-entry-title-input" id="st-codex-ed-title" type="text"
                               value="${escapeHtml(draft.comment || '')}" placeholder="Name this entry">
                    </div>
                    <div>
                        <label class="st-codex-label" for="st-codex-ed-category">Category</label>
                        <select class="st-codex-select" id="st-codex-ed-category">${categoryOptions}</select>
                    </div>
                </div>

                <div class="st-codex-entry-columns">
                    <div class="st-codex-entry-writing">
                        <div class="st-codex-entry-writing-head">
                            <label class="st-codex-label" for="st-codex-ed-content">Lore Content</label>
                            <span class="st-codex-hint" id="st-codex-ed-tokens" aria-live="polite">Counting content tokens…</span>
                        </div>
                        <textarea class="st-codex-textarea" id="st-codex-ed-content"
                                  placeholder="Write the lore SillyTavern should inject when this entry triggers…"></textarea>
                    </div>

                    <div class="st-codex-entry-keywords">
                        ${keyField('st-codex-ed-keys', 'Primary Trigger Keys', 'e.g. enclave, city, outpost',
                            'Used for keyword activation. Separate keys with commas.')}
                        <div class="st-codex-entry-filter">
                            ${keyField('st-codex-ed-secondary', 'Optional Filter Keys', 'e.g. north gate, night watch',
                                'Separate filter keys with commas.')}
                            <div class="st-codex-filter-controls" role="group" aria-labelledby="st-codex-filter-label" aria-describedby="st-codex-filter-hint">
                                <div class="st-codex-field">
                                    <label class="st-codex-label" id="st-codex-filter-label" for="st-codex-ed-logic">Filter-key logic</label>
                                    <select class="st-codex-select" id="st-codex-ed-logic">${logicOptions}</select>
                                </div>
                                <label class="st-codex-toggle" for="st-codex-ed-selective">
                                    <span class="st-codex-toggle-text"><strong>Require a filter key</strong></span>
                                    <input type="checkbox" id="st-codex-ed-selective" ${draft.selective !== false ? 'checked' : ''}>
                                    <span class="st-codex-toggle-track" aria-hidden="true"><span></span></span>
                                </label>
                            </div>
                            <span class="st-codex-hint" id="st-codex-filter-hint">Apply this rule to the filter keys after a primary match when the switch is on.</span>
                        </div>
                    </div>
                </div>

                <details class="st-codex-entry-appearance">
                    <summary>
                        <strong>Card appearance</strong>
                        <span>Thumbnail and subtitle</span>
                        <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
                    </summary>
                    <div class="st-codex-entry-appearance-fields">
                        <div>
                            <label class="st-codex-label" for="st-codex-img-url">Thumbnail</label>
                            <div class="st-codex-image-row">
                                <div class="st-codex-image-preview" id="st-codex-img-preview"></div>
                                <div class="st-codex-image-controls">
                                    <div class="st-codex-image-buttons">
                                        <button class="st-codex-btn st-codex-btn-sm" id="st-codex-img-upload" type="button">
                                            <i class="fa-solid fa-upload"></i> Upload
                                        </button>
                                        <button class="st-codex-btn st-codex-btn-sm" id="st-codex-img-remove" type="button">
                                            <i class="fa-solid fa-trash-can"></i> Remove
                                        </button>
                                        <input type="file" id="st-codex-img-file" accept="image/*" hidden>
                                    </div>
                                    <input class="st-codex-input" id="st-codex-img-url" type="text"
                                           placeholder="Image URL or path served by SillyTavern">
                                    <span class="st-codex-hint">Upload or paste an image to crop it to 250 × 250.</span>
                                </div>
                            </div>
                        </div>
                        <div>
                            <label class="st-codex-label" for="st-codex-ed-importance">Subtitle / Importance</label>
                            <input class="st-codex-input" id="st-codex-ed-importance" type="text"
                                   list="st-codex-importance-list" value="${escapeHtml(visual.importanceLabel || 'Standard')}">
                            <datalist id="st-codex-importance-list">
                                ${IMPORTANCE_LABELS.map(label => `<option value="${escapeHtml(label)}"></option>`).join('')}
                            </datalist>
                            <span class="st-codex-hint">Shown under the title on the card.</span>
                        </div>
                    </div>
                </details>
            </div>

            <div class="st-codex-panel" id="st-codex-editor-settings" data-panel="settings" hidden>
                <section class="st-codex-settings-group">
                    <h4 class="st-codex-settings-title"><i class="fa-solid fa-bolt"></i> Activation</h4>
                    ${toggleSetting('st-codex-ed-enabled', 'Enabled', !draft.disable, 'Allows this entry to trigger, matching the card switch')}
                    <div class="st-codex-setting">
                        <span class="st-codex-setting-label"><span>Strategy</span></span>
                        <select class="st-codex-select st-codex-select-md" id="st-codex-ed-strategy">${strategyOptions}</select>
                    </div>
                    <p class="st-codex-settings-note">Constant = always injected · Normal = keyword match · Vectorized = embedding match.</p>
                </section>

                <section class="st-codex-settings-group">
                    <h4 class="st-codex-settings-title"><i class="fa-solid fa-location-dot"></i> Insertion</h4>
                    <div class="st-codex-setting">
                        <span class="st-codex-setting-label"><span>Position</span></span>
                        <select class="st-codex-select st-codex-select-md" id="st-codex-ed-position">${positionOptions}</select>
                    </div>
                    ${numberSetting('st-codex-ed-depth', 'Depth', orDefault(draft.depth, 4), 'Used by "at depth" positions', 'min="0" max="999"')}
                    ${numberSetting('st-codex-ed-order', 'Insertion order', orDefault(draft.order, 100), 'Higher = inserted later', 'min="0" max="9999"')}
                </section>

                <section class="st-codex-settings-group">
                    <h4 class="st-codex-settings-title"><i class="fa-solid fa-dice"></i> Trigger timing</h4>
                    ${numberSetting('st-codex-ed-probability', 'Probability %', orDefault(draft.probability, 100), '', 'min="0" max="100"')}
                    ${toggleSetting('st-codex-ed-useprob', 'Use probability', draft.useProbability !== false)}
                    ${numberSetting('st-codex-ed-sticky', 'Sticky', nullable(draft.sticky), 'Messages to keep active · empty = off', 'min="0"')}
                    ${numberSetting('st-codex-ed-cooldown', 'Cooldown', nullable(draft.cooldown), 'Messages before it may retrigger', 'min="0"')}
                    ${numberSetting('st-codex-ed-delay', 'Delay', nullable(draft.delay), 'Chat messages before first activation', 'min="0"')}
                </section>

                <section class="st-codex-settings-group">
                    <h4 class="st-codex-settings-title"><i class="fa-solid fa-layer-group"></i> Inclusion group</h4>
                    <div class="st-codex-setting">
                        <span class="st-codex-setting-label"><span>Group</span></span>
                        <input class="st-codex-input st-codex-input-md" id="st-codex-ed-group" type="text"
                               value="${escapeHtml(draft.group || '')}" placeholder="e.g. outfit">
                    </div>
                    ${toggleSetting('st-codex-ed-group-override', 'Prioritise this entry', Boolean(draft.groupOverride), 'Beats the rest of its group')}
                    ${numberSetting('st-codex-ed-group-weight', 'Weight', orDefault(draft.groupWeight, 100), '', 'min="0" max="10000"')}
                    ${triSetting('st-codex-ed-group-scoring', 'Group scoring', draft.useGroupScoring)}
                </section>

                <section class="st-codex-settings-group">
                    <h4 class="st-codex-settings-title"><i class="fa-solid fa-diagram-project"></i> Recursion</h4>
                    ${toggleSetting('st-codex-ed-prevent-recursion', 'Prevent further recursion', draft.preventRecursion, 'Stops recursion once this entry fires')}
                    ${toggleSetting('st-codex-ed-exclude-recursion', 'Exclude from recursion', draft.excludeRecursion, 'Cannot be triggered by other entries')}
                    ${numberSetting('st-codex-ed-delay-recursion', 'Delay until recursion', orDefault(draft.delayUntilRecursion, 0), '0 = immediately', 'min="0"')}
                    ${toggleSetting('st-codex-ed-ignore-budget', 'Ignore token budget', draft.ignoreBudget, 'Inject even past the budget cap')}
                </section>

                <section class="st-codex-settings-group">
                    <h4 class="st-codex-settings-title"><i class="fa-solid fa-magnifying-glass"></i> Scanning</h4>
                    ${numberSetting('st-codex-ed-scan-depth', 'Scan depth', nullable(draft.scanDepth), 'Empty = global value', 'min="0" max="100"')}
                    ${triSetting('st-codex-ed-case', 'Case sensitive', draft.caseSensitive)}
                    ${triSetting('st-codex-ed-whole-words', 'Match whole words', draft.matchWholeWords)}
                    <div class="st-codex-setting">
                        <span class="st-codex-setting-label"><span>Message role</span></span>
                        <select class="st-codex-select st-codex-select-md" id="st-codex-ed-role">
                            ${roleOptions}
                        </select>
                    </div>
                </section>

                <section class="st-codex-settings-group">
                    <h4 class="st-codex-settings-title"><i class="fa-solid fa-file-lines"></i> Also match against</h4>
                    <div class="st-codex-mini-grid">
                        ${toggleSetting('st-codex-ed-match-persona', 'Persona', draft.matchPersonaDescription)}
                        ${toggleSetting('st-codex-ed-match-char-desc', 'Char. description', draft.matchCharacterDescription)}
                        ${toggleSetting('st-codex-ed-match-char-persona', 'Personality', draft.matchCharacterPersonality)}
                        ${toggleSetting('st-codex-ed-match-char-depth', 'Depth prompt', draft.matchCharacterDepthPrompt)}
                        ${toggleSetting('st-codex-ed-match-scenario', 'Scenario', draft.matchScenario)}
                        ${toggleSetting('st-codex-ed-match-creator', 'Creator notes', draft.matchCreatorNotes)}
                    </div>
                </section>
            </div>
        </div>
        <div class="st-codex-modal-foot">
            ${isNew ? '' : `<button class="st-codex-btn st-codex-btn-danger" id="st-codex-ed-delete" type="button">
                <i class="fa-solid fa-trash"></i> Delete
            </button>`}
            <div class="st-codex-foot-spacer"></div>
            <button class="st-codex-btn st-codex-btn-cancel" id="st-codex-ed-cancel" type="button">Cancel</button>
            <button class="st-codex-btn st-codex-btn-primary" id="st-codex-ed-save" type="button">
                <i class="fa-solid fa-floppy-disk"></i> Save Entry
            </button>
        </div>`;

    let imageJob = null;
    const cancelImageSelection = () => {
        const job = imageJob;
        imageJob = null;
        job?.abort();
    };
    const modal = createModal({
        title: isNew ? (duplicateOf ? 'Duplicate Codex Entry' : 'New Codex Entry') : `Edit: ${entryTitle(draft)}`,
        body,
        footer: '',
        onClose: cancelImageSelection,
        beforeClose: async () => {
            if (saving) return false;
            if (imageJob) { app.toast('Finish or cancel the thumbnail crop first.', true); return false; }
            if (editorState() === initialState) return true;
            const focused = document.activeElement;
            const choice = await unsavedChangesDialog();
            if (choice === 'save') await saveEntry();
            if (root.isConnected && choice !== 'discard') focused?.focus();
            return choice === 'discard';
        },
    });
    const root = modal.querySelector('.st-codex-modal');
    const $ = selector => root.querySelector(selector);
    // Assign through the DOM: HTML parsing would strip one leading newline
    // from the textarea's initial text.
    const displayKeys = keys => (Array.isArray(keys) ? keys.filter(key => typeof key === 'string') : []).join(', ');
    $('#st-codex-ed-content').value = entryContent(draft);
    $('#st-codex-ed-keys').value = displayKeys(draft.key);
    $('#st-codex-ed-secondary').value = displayKeys(draft.keysecondary);

    // Compare actual values so reverting an edit also clears the dirty state.
    const editorState = () => JSON.stringify([
        ...Array.from(root.querySelectorAll('input:not([type="file"]), textarea, select'),
            field => [field.id, field.type === 'checkbox' ? field.checked : field.value]),
        imageValue,
    ]);
    initialState = editorState();
    const fieldValue = field => field.type === 'checkbox' ? field.checked : field.value;
    const initialFields = new Map(Array.from(root.querySelectorAll('input, textarea, select'), field => [field.id, fieldValue(field)]));
    const changed = id => fieldValue($('#' + id)) !== initialFields.get(id);
    const tagDrafts = new Map();
    const storedKeys = id => id === 'st-codex-ed-keys' ? originalEntry.key : originalEntry.keysecondary;
    const readKeys = async field => {
        const tags = tagDrafts.get(field.id);
        if (tags?.text === field.value) return tags.keys;
        if (!changed(field.id)) return Array.isArray(storedKeys(field.id)) ? storedKeys(field.id) : [];
        return parseKeyList(field.value);
    };
    modal.__hasUnsavedChanges = () => saving || Boolean(imageJob) || editorState() !== initialState;

    let tokenRevision = 0;
    let tokenTimer;
    let tokenPending = false;
    let tokenDirty = false;
    const updateTokenCount = async () => {
        if (!root.isConnected) return;
        if (tokenPending) { tokenDirty = true; return; }
        tokenPending = true;
        tokenDirty = false;
        const revision = ++tokenRevision;
        const text = $('#st-codex-ed-content').value;
        try {
            const count = await countContentTokens(text);
            if (root.isConnected && revision === tokenRevision) {
                $('#st-codex-ed-tokens').textContent = `${count.toLocaleString()} content tokens · current tokenizer`;
            }
        } catch {
            if (root.isConnected && revision === tokenRevision) $('#st-codex-ed-tokens').textContent = 'Token count unavailable.';
        } finally {
            tokenPending = false;
            if (tokenDirty && root.isConnected) updateTokenCount();
        }
    };
    $('#st-codex-ed-content').addEventListener('input', () => {
        ++tokenRevision;
        clearTimeout(tokenTimer);
        $('#st-codex-ed-tokens').textContent = 'Counting content tokens…';
        tokenTimer = setTimeout(updateTokenCount, 350);
    });
    updateTokenCount();

    root.querySelectorAll('.st-codex-key-field').forEach(field => {
        const text = field.querySelector('textarea');
        const tags = field.querySelector('.st-codex-key-tags');
        const deleteModeButton = field.querySelector('.st-codex-key-delete-mode');
        const hint = field.querySelector('.st-codex-hint');
        const textHint = hint.textContent;
        let deleteMode = false;
        let revision = 0;
        text.addEventListener('input', () => tagDrafts.delete(text.id));
        const setMode = async mode => {
            const currentRevision = ++revision;
            const showTags = mode === 'tags';
            text.hidden = showTags;
            tags.hidden = !showTags;
            deleteModeButton.hidden = !showTags;
            if (!showTags) {
                deleteMode = false;
                deleteModeButton.setAttribute('aria-pressed', 'false');
            }
            tags.classList.toggle('is-delete-mode', deleteMode);
            hint.textContent = deleteMode
                ? 'Delete mode is on: click a tag to remove it. Changes apply on Save.'
                : showTags ? 'Select a tag to edit it in Text mode.' : textHint;
            field.querySelectorAll('[data-key-mode]').forEach(button => {
                button.setAttribute('aria-pressed', String(button.dataset.keyMode === mode));
            });
            if (!showTags) return;
            tags.textContent = 'Loading keys…';
            try {
                // Untouched stored arrays and tag deletions retain exact keys.
                // Only free-form Text edits need SillyTavern's native parser.
                const keys = await readKeys(text);
                if (currentRevision !== revision || !root.isConnected) return;
                tags.replaceChildren();
                let offset = 0;
                keys.forEach((key, index) => {
                    if (typeof key !== 'string') return;
                    const start = text.value.indexOf(key, offset);
                    offset = start < 0 ? offset : start + key.length;
                    const tag = document.createElement('button');
                    tag.type = 'button';
                    tag.className = 'st-codex-key-tag';
                    tag.textContent = deleteMode ? `${key} ×` : key;
                    tag.title = `${deleteMode ? 'Remove' : 'Edit'}: ${key}`;
                    tag.setAttribute('aria-label', tag.title);
                    tag.addEventListener('click', async () => {
                        if (deleteMode) {
                            const remainingKeys = keys.filter((_, keyIndex) => keyIndex !== index);
                            text.value = displayKeys(remainingKeys);
                            text.dispatchEvent(new Event('input', { bubbles: true }));
                            tagDrafts.set(text.id, {text: text.value, keys: remainingKeys});
                            await setMode('tags');
                            const remaining = tags.querySelectorAll('.st-codex-key-tag');
                            (remaining[Math.min(index, remaining.length - 1)] || deleteModeButton).focus();
                            return;
                        }
                        setMode('text');
                        text.focus();
                        if (start >= 0) text.setSelectionRange(start, start + key.length);
                    });
                    tags.appendChild(tag);
                });
                if (!tags.childElementCount) tags.textContent = 'No keys yet. Use Text to add some.';
            } catch {
                if (currentRevision === revision) tags.textContent = 'Could not display keys. Use Text to edit.';
            }
        };
        field.querySelectorAll('[data-key-mode]').forEach(button => {
            button.addEventListener('click', () => setMode(button.dataset.keyMode));
        });
        deleteModeButton.addEventListener('click', () => {
            deleteMode = !deleteMode;
            deleteModeButton.setAttribute('aria-pressed', String(deleteMode));
            setMode('tags');
        });
    });

    /* ---------------------------------------------------------------- tabs */
    const tabBody = $('.st-codex-modal-body');
    const tabScroll = new Map();
    let activeTab = 'visual';
    root.querySelectorAll('.st-codex-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            if (activeTab === tab.dataset.tab) return;
            tabScroll.set(activeTab, tabBody.scrollTop);
            activeTab = tab.dataset.tab;
            root.querySelectorAll('.st-codex-tab').forEach(item => {
                const selected = item === tab;
                item.classList.toggle('st-codex-tab-active', selected);
                item.setAttribute('aria-pressed', String(selected));
            });
            root.querySelectorAll('.st-codex-panel').forEach(panel => {
                panel.hidden = panel.dataset.panel !== activeTab;
            });
            tabBody.scrollTop = tabScroll.get(activeTab) ?? 0;
        });
    });

    /* --------------------------------------------------------------- image */
    const preview = $('#st-codex-img-preview');
    const urlInput = $('#st-codex-img-url');
    const fileInput = $('#st-codex-img-file');

    const paintPreview = () => {
        const safe = sanitizeImageSrc(imageValue);
        preview.innerHTML = safe
            ? `<img src="${escapeHtml(safe)}" alt="Entry thumbnail" referrerpolicy="no-referrer">`
            : '<i class="fa-regular fa-image"></i>';
    };
    paintPreview();

    const applyImageFile = async file => {
        cancelImageSelection();
        const job = new AbortController();
        imageJob = job;
        try {
            const dataUri = await cropThumbnail(file, createModal, job.signal, onImagePaste);
            if (!dataUri || !root.isConnected || imageJob !== job) return;
            imageValue = dataUri;
            urlInput.value = '';
            paintPreview();
        } catch (error) {
            if (root.isConnected && imageJob === job) app.toast(error.message || 'Could not process that image.', true);
        } finally {
            if (imageJob === job) imageJob = null;
        }
    };

    $('#st-codex-img-upload').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file) applyImageFile(file);
        fileInput.value = '';
    });

    urlInput.addEventListener('input', () => {
        cancelImageSelection();
        imageValue = urlInput.value.trim();
        paintPreview();
    });

    $('#st-codex-img-remove').addEventListener('click', () => {
        cancelImageSelection();
        imageValue = '';
        urlInput.value = '';
        paintPreview();
    });

    const onImagePaste = event => {
        const items = event.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
                event.preventDefault();
                const file = item.getAsFile();
                if (file) applyImageFile(file);
                return;
            }
        }
    };
    modal.addEventListener('paste', onImagePaste);

    /* --------------------------------------------------------------- cancel */
    $('#st-codex-ed-cancel').addEventListener('click', () => modal.__close());

    /* --------------------------------------------------------------- delete */
    $('#st-codex-ed-delete')?.addEventListener('click', async () => {
        if (saving || app.data !== data || app.worldName !== worldName) return;
        if (!window.confirm('Delete this entry from the lorebook? This cannot be undone.')) return;
        saving = true;
        modal.inert = true;
        try {
            if (data.entries[entryKey] !== entry) throw new Error('This entry changed while the editor was open. Reload before deleting.');
            await deleteEntry(worldName, data, originalEntry.uid);
        } catch (error) {
            console.error('[VisualLorebook] Could not delete entry', error);
            app.toast(error.message || 'Could not delete that entry.', true);
            return;
        } finally {
            saving = false;
            modal.inert = false;
        }
        if (app.state) app.state.lastSaveAt = Date.now();
        app.render();
        app.toast('Entry deleted.');
        modal.__forceClose();
    });

    /* ----------------------------------------------------------------- save */
    saveEntry = async () => {
        if (saving) return;
        if (imageJob) { app.toast('Finish or cancel the thumbnail crop first.', true); return; }
        if (!isNew && editorState() === initialState) { modal.__forceClose(); return; }
        saving = true;
        modal.inert = true;
        $('#st-codex-ed-save').disabled = true;
        try {
            // Re-read at save time: a background reload may have replaced state.data
            // since this modal opened, and writing into the old object would vanish.
            if (app.data !== data || app.worldName !== worldName || (!isNew && data.entries[entryKey] !== entry)) {
                app.toast('The lorebook or entry changed. Copy your draft and reload before saving.', true);
                return;
            }
            const draft = structuredClone(originalEntry);
            const title = $('#st-codex-ed-title').value.trim();
            const categoryId = $('#st-codex-ed-category').value || 'uncategorized';
            const importance = $('#st-codex-ed-importance').value.trim();
            const safeImage = sanitizeImageSrc(imageValue);
            if (imageValue !== visual.image && imageValue && !safeImage) {
                app.toast('Enter a valid thumbnail URL or remove it before saving.', true);
                return;
            }

            let primaryKeys, secondaryKeys;
            try {
                [primaryKeys, secondaryKeys] = await Promise.all([
                    changed('st-codex-ed-keys') ? readKeys($('#st-codex-ed-keys')) : originalEntry.key,
                    changed('st-codex-ed-secondary') ? readKeys($('#st-codex-ed-secondary')) : originalEntry.keysecondary,
                ]);
            } catch (error) {
                console.error('[VisualLorebook] Could not parse trigger keys', error);
                app.toast('Could not parse trigger keys. No entry changes were applied.', true);
                return;
            }

            // Parsing is asynchronous; do not mutate an entry whose book/modal has
            // been replaced while waiting.
            if (!root.isConnected || app.data !== data || app.worldName !== worldName) {
                app.toast('The lorebook changed while saving. Reopen the editor and try again.', true);
                return;
            }

            // Validate before the first mutation: a rejected save must not leave a
            // half-edited entry that a later unrelated save could persist.
            if ((isNew || changed('st-codex-ed-title') || changed('st-codex-ed-keys')) && !title && !(Array.isArray(primaryKeys) && primaryKeys.some(key => typeof key === 'string' && key.trim()))) {
                app.toast('Give the entry a title or at least one trigger key.', true);
                return;
            }

            // Controls can display defaults for absent, null or future values.
            // Apply only changed controls so those defaults never leak into JSON.
            const setField = (property, suffix, read = field => field.value) => {
                const id = 'st-codex-ed-' + suffix;
                if (changed(id)) draft[property] = read($('#' + id));
            };
            const checked = field => field.checked;
            const trimmed = field => field.value.trim();
            const triState = field => field.value === '' ? null : field.value === 'true';
            const number = (fallback, min = 0, max = Infinity) => field => {
                const value = Number(field.value);
                return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
            };
            const nullableCount = field => field.value === '' ? null : number(null)(field);

            setField('comment', 'title', () => title);
            setField('key', 'keys', () => primaryKeys);
            setField('keysecondary', 'secondary', () => secondaryKeys);
            setField('content', 'content');
            setField('disable', 'enabled', field => !field.checked);
            if (changed('st-codex-ed-strategy')) applyStrategy(draft, $('#st-codex-ed-strategy').value);
            setField('position', 'position', field => Number(field.value) || 0);
            setField('depth', 'depth', number(0));
            setField('order', 'order', number(0));
            setField('probability', 'probability', number(0, 0, 100));
            setField('useProbability', 'useprob', checked);
            setField('selective', 'selective', checked);
            setField('selectiveLogic', 'logic', number(0));
            setField('ignoreBudget', 'ignore-budget', checked);
            setField('preventRecursion', 'prevent-recursion', checked);
            setField('excludeRecursion', 'exclude-recursion', checked);
            setField('delayUntilRecursion', 'delay-recursion', number(0));
            setField('sticky', 'sticky', nullableCount);
            setField('cooldown', 'cooldown', nullableCount);
            setField('delay', 'delay', nullableCount);
            setField('group', 'group', trimmed);
            setField('groupOverride', 'group-override', checked);
            setField('groupWeight', 'group-weight', number(100, 0, 10000));
            setField('useGroupScoring', 'group-scoring', triState);
            setField('scanDepth', 'scan-depth', nullableCount);
            setField('caseSensitive', 'case', triState);
            setField('matchWholeWords', 'whole-words', triState);
            setField('role', 'role', number(0, 0, 2));
            setField('matchPersonaDescription', 'match-persona', checked);
            setField('matchCharacterDescription', 'match-char-desc', checked);
            setField('matchCharacterPersonality', 'match-char-persona', checked);
            setField('matchCharacterDepthPrompt', 'match-char-depth', checked);
            setField('matchScenario', 'match-scenario', checked);
            setField('matchCreatorNotes', 'match-creator', checked);

            const categoryChanged = changed('st-codex-ed-category');
            const visualPatch = {
                ...(categoryChanged ? {categoryId} : {}),
                ...(imageValue !== visual.image ? {image: safeImage} : {}),
                ...(changed('st-codex-ed-importance') ? {importanceLabel: importance} : {}),
                ...(categoryChanged || isNew ? { sortOrder: nextSortOrder(data, categoryId) } : {}),
            };
            if (Object.keys(visualPatch).length) setEntryVisual(draft, visualPatch);

            if (isNew) {
                draft.uid = freeUid(data);
                entryKey = String(draft.uid);
            }
            const previousEntry = data.entries[entryKey];
            data.entries[entryKey] = draft;
            let saved = false;
            try {
                saved = await app.saveNow();
            } finally {
                // Keep failed saves local to the editor: Discard must not leak a
                // rejected draft into a later dashboard save.
                if (!saved) {
                    if (previousEntry) data.entries[entryKey] = previousEntry;
                    else delete data.entries[entryKey];
                }
            }
            if (!saved) return;
            app.render();
            app.toast(isNew ? 'Entry created.' : 'Entry saved.');
            modal.__forceClose();
        } catch (error) {
            console.error('[VisualLorebook] Entry save failed', error);
            app.toast(error.message || 'Could not save this entry.', true);
        } finally {
            saving = false;
            modal.inert = false;
            $('#st-codex-ed-save').disabled = false;
        }
    };
    $('#st-codex-ed-save').addEventListener('click', saveEntry);

    setTimeout(() => $('#st-codex-ed-title')?.focus({ preventScroll: true }), 30);
}

/* ---------------------------------------------------------- category manager */

// Stage category changes without mutating any shared native entry. A failed
// write restores precisely the previous containers, including absent metadata.
async function commitCategoryChange(app, mutate) {
    if (app.busy) return false;
    const data = app.data;
    const entries = data.entries;
    const extensions = data.extensions;
    const hadExtensions = Object.hasOwn(data, 'extensions');
    const candidate = {...data, entries: {...entries}};
    if (hadExtensions) candidate.extensions = structuredClone(extensions);
    let saved = false;
    const modal = [...document.querySelectorAll('.st-codex-modal-backdrop')].at(-1);
    if (modal) modal.inert = true;
    try {
        mutate(candidate);
        data.entries = candidate.entries;
        data.extensions = candidate.extensions;
        saved = await app.saveNow();
        return saved;
    } catch (error) {
        app.toast(error.message || 'Could not update categories.', true);
        return false;
    } finally {
        if (!saved) {
            data.entries = entries;
            if (hadExtensions) data.extensions = extensions;
            else delete data.extensions;
        }
        app.render();
        if (modal) modal.inert = false;
    }
}

export function openCategoryManager(app) {
    if (!app.data || app.busy || document.querySelector('.st-codex-modal-backdrop')) return;
    let selectedId = null;

    const counts = () => {
        const map = new Map();
        for (const entry of Object.values(app.data?.entries || {})) {
            const id = getEntryVisual(entry).categoryId;
            map.set(id, (map.get(id) || 0) + 1);
        }
        return map;
    };

    const body = `
        <div class="st-codex-modal-body">
            <div class="st-codex-field">
                <span class="st-codex-hint" style="margin:0 0 10px">
                    Drag the grip to reorder. Pick any colour with the swatch on the row, type a hex
                    value next to it, or select a row and use a preset below.
                </span>
                <div class="st-codex-cat-list" id="st-codex-cat-list"></div>
                <div class="st-codex-palette" id="st-codex-palette"></div>
            </div>
            <div class="st-codex-field">
                <button class="st-codex-btn" id="st-codex-cat-add" type="button">
                    <i class="fa-solid fa-plus"></i> New Category
                </button>
            </div>
        </div>
        <div class="st-codex-modal-foot">
            <div class="st-codex-foot-spacer"></div>
            <button class="st-codex-btn st-codex-btn-primary" id="st-codex-cat-done" type="button">Done</button>
        </div>`;

    const modal = createModal({ title: 'Manage Categories', body, small: true,
        beforeClose: async () => {
            if (app.busy) return false;
            if (!hasBookChanges(app.data)) return true;
            modal.inert = true;
            try { return await app.saveBeforeLeaving(); }
            finally { modal.inert = false; }
        },
    });
    modal.__hasUnsavedChanges = () => hasBookChanges(app.data);
    const root = modal.querySelector('.st-codex-modal');
    const $ = selector => root.querySelector(selector);
    const listEl = $('#st-codex-cat-list');
    const changeCategory = (id, patch) => {
        try { updateCategory(app.data, id, patch); app.save(); }
        catch (error) { app.toast(error.message || 'Could not update this category.', true); }
    };

    const paint = () => {
        const map = counts();
        listEl.innerHTML = app.categories
            .map(cat => `
                <div class="st-codex-cat-row ${cat.id === selectedId ? 'st-codex-cat-active' : ''}"
                     data-id="${escapeHtml(cat.id)}" draggable="true">
                    <span class="st-codex-cat-grip"><i class="fa-solid fa-grip-vertical"></i></span>
                    <input type="color" class="st-codex-cat-swatch" value="${escapeHtml(cat.color)}"
                           title="Pick any colour" ${cat.locked ? 'disabled' : ''}>
                    <input type="text" class="st-codex-cat-hex" value="${escapeHtml(cat.color)}"
                           maxlength="7" spellcheck="false" title="Hex colour, e.g. #5b8def"
                           ${cat.locked ? 'disabled' : ''}>
                    <input type="text" class="st-codex-cat-name" value="${escapeHtml(cat.name)}"
                           ${cat.locked ? 'disabled' : ''} placeholder="Category name">
                    <span class="st-codex-cat-count">${map.get(cat.id) || 0}</span>
                    <button class="st-codex-cat-remove" type="button" title="Delete category"
                            ${cat.locked ? 'disabled' : ''}>
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>`)
            .join('');
        bindRows();
    };

    const bindRows = () => {
        listEl.querySelectorAll('.st-codex-cat-row').forEach(row => {
            const id = row.dataset.id;
            const colorInput = row.querySelector('.st-codex-cat-swatch');
            const hexInput = row.querySelector('.st-codex-cat-hex');
            const nameInput = row.querySelector('.st-codex-cat-name');
            const removeBtn = row.querySelector('.st-codex-cat-remove');

            row.addEventListener('mousedown', () => {
                selectedId = id;
                listEl.querySelectorAll('.st-codex-cat-row').forEach(item => item.classList.remove('st-codex-cat-active'));
                row.classList.add('st-codex-cat-active');
            });

            colorInput?.addEventListener('input', () => {
                changeCategory(id, { color: colorInput.value });
                if (hexInput) hexInput.value = colorInput.value;
            });

            hexInput?.addEventListener('input', () => {
                const value = String(hexInput.value || '').trim();
                const valid = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
                hexInput.classList.toggle('st-codex-invalid', !valid);
                if (!valid) return;
                const normalized = value.length === 4
                    ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
                    : value.toLowerCase();
                changeCategory(id, { color: normalized });
                if (colorInput) colorInput.value = normalized;
            });

            nameInput?.addEventListener('input', () => {
                changeCategory(id, { name: nameInput.value });
            });

            nameInput?.addEventListener('change', () => {
                app.render();
                paint();
            });

            removeBtn?.addEventListener('click', async () => {
                if (!window.confirm('Delete this category? Its entries move to Uncategorized.')) return;
                const saved = await commitCategoryChange(app, data => removeCategory(data, id));
                if (!saved) { paint(); return; }
                if (selectedId === id) selectedId = null;
                paint();
            });
        });

        let dragged = null;
        listEl.querySelectorAll('.st-codex-cat-row').forEach(row => {
            row.addEventListener('dragstart', () => {
                dragged = row.dataset.id;
                row.classList.add('st-codex-dragging');
            });
            row.addEventListener('dragend', () => {
                row.classList.remove('st-codex-dragging');
                dragged = null;
            });
            row.addEventListener('dragover', event => {
                if (!dragged || dragged === row.dataset.id) return;
                event.preventDefault();
            });
            row.addEventListener('drop', async event => {
                event.preventDefault();
                if (!dragged || dragged === row.dataset.id) return;
                const cats = [...app.categories];
                const from = cats.findIndex(cat => cat.id === dragged);
                const to = cats.findIndex(cat => cat.id === row.dataset.id);
                if (from === -1 || to === -1) return;
                const [moved] = cats.splice(from, 1);
                cats.splice(to, 0, moved);
                await commitCategoryChange(app, data => setCategories(data, cats));
                paint();
            });
        });
    };

    const palette = $('#st-codex-palette');
    palette.innerHTML = PALETTE
        .map(item => `<button class="st-codex-swatch" type="button" data-color="${escapeHtml(item.color)}"
                      style="background:${escapeHtml(item.color)}" title="${escapeHtml(item.name)}"></button>`)
        .join('');
    palette.addEventListener('click', event => {
        const swatch = event.target.closest('[data-color]');
        if (!swatch) return;
        if (!selectedId) {
            app.toast('Select a category row first.', true);
            return;
        }
        changeCategory(selectedId, { color: swatch.dataset.color });
        app.render();
        paint();
    });

    $('#st-codex-cat-add').addEventListener('click', async () => {
        await commitCategoryChange(app, data => { selectedId = addCategory(data, 'New Category').id; });
        paint();
    });

    $('#st-codex-cat-done').addEventListener('click', () => {
        modal.__close();
    });

    paint();
}

/* ------------------------------------------------------- single-category edit */

/**
 * Compact editor reachable from the pencil icon in a section header, so a
 * category can be renamed/recoloured without opening the full manager.
 */
export function openCategoryEditor(app, categoryId) {
    if (app.busy || document.querySelector('.st-codex-modal-backdrop')) return;
    const category = app.categories.find(cat => cat.id === categoryId);
    if (!category || !app.data) return;

    const locked = Boolean(category.locked);
    const count = Object.values(app.data.entries || {})
        .filter(entry => getEntryVisual(entry).categoryId === categoryId).length;

    let color = category.color;

    const body = `
        <div class="st-codex-modal-body">
            <div class="st-codex-field">
                <label class="st-codex-label" for="st-codex-ce-name">Category name</label>
                <input class="st-codex-input" id="st-codex-ce-name" type="text"
                       value="${escapeHtml(category.name)}" ${locked ? 'disabled' : ''}>
            </div>
            <div class="st-codex-field">
                <label class="st-codex-label">Colour</label>
                <div class="st-codex-color-row">
                    <input type="color" class="st-codex-cat-swatch" id="st-codex-ce-swatch"
                           value="${escapeHtml(color)}" title="Pick any colour" ${locked ? 'disabled' : ''}>
                    <input type="text" class="st-codex-input st-codex-cat-hex" id="st-codex-ce-hex"
                           value="${escapeHtml(color)}" maxlength="7" spellcheck="false"
                           title="Any hex value" ${locked ? 'disabled' : ''}>
                    <span class="st-codex-hint">Picker, hex value or preset — all optional.</span>
                </div>
                <div class="st-codex-palette" id="st-codex-ce-palette">
                    ${PALETTE.map(item => `<button class="st-codex-swatch" type="button"
                        data-color="${escapeHtml(item.color)}" style="background:${escapeHtml(item.color)}"
                        title="${escapeHtml(item.name)}"></button>`).join('')}
                </div>
            </div>
            <div class="st-codex-field">
                <span class="st-codex-hint">
                    ${count} entr${count === 1 ? 'y' : 'ies'} in this category${locked ? ' · the built-in category cannot be renamed or deleted' : ''}
                </span>
            </div>
        </div>
        <div class="st-codex-modal-foot">
            ${locked ? '' : `<button class="st-codex-btn st-codex-btn-danger" id="st-codex-ce-delete" type="button">
                <i class="fa-solid fa-trash"></i> Delete
            </button>`}
            <div class="st-codex-foot-spacer"></div>
            <button class="st-codex-btn st-codex-btn-cancel" id="st-codex-ce-cancel" type="button">Cancel</button>
            <button class="st-codex-btn st-codex-btn-primary" id="st-codex-ce-save" type="button">Save</button>
        </div>`;

    let saving = false;
    let saveCategory;
    const modal = createModal({ title: `Edit ${category.name}`, body, small: true,
        beforeClose: async () => {
            if (saving || app.busy) return false;
            if (!modal.__hasUnsavedChanges()) return true;
            const choice = await unsavedChangesDialog('category');
            if (choice === 'save') await saveCategory();
            return choice === 'discard';
        },
    });
    const root = modal.querySelector('.st-codex-modal');
    const $ = selector => root.querySelector(selector);
    const swatch = $('#st-codex-ce-swatch');
    const hex = $('#st-codex-ce-hex');
    modal.__hasUnsavedChanges = () => saving || $('#st-codex-ce-name').value !== category.name || color !== category.color;

    const paint = value => {
        color = value;
        if (swatch) swatch.value = value;
        if (hex) {
            hex.value = value;
            hex.classList.remove('st-codex-invalid');
        }
    };

    swatch?.addEventListener('input', () => paint(swatch.value));

    hex?.addEventListener('input', () => {
        const raw = String(hex.value || '').trim();
        const valid = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw);
        hex.classList.toggle('st-codex-invalid', !valid);
        if (!valid) return;
        const normalized = raw.length === 4
            ? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`
            : raw.toLowerCase();
        color = normalized;
        if (swatch) swatch.value = normalized;
    });

    $('#st-codex-ce-palette').addEventListener('click', event => {
        if (locked) return;
        const preset = event.target.closest('[data-color]');
        if (preset) paint(preset.dataset.color);
    });

    $('#st-codex-ce-cancel').addEventListener('click', () => modal.__close());

    $('#st-codex-ce-delete')?.addEventListener('click', async () => {
        if (saving || app.busy) return;
        const ok = await confirmDialog({
            title: `Delete “${category.name}”?`,
            message: `Its ${count} entr${count === 1 ? 'y' : 'ies'} will move to <strong>Uncategorized</strong>. The entries themselves are not deleted.`,
            confirmLabel: 'Delete category',
            danger: true,
        });
        if (!ok) return;
        saving = true;
        const saved = await commitCategoryChange(app, data => removeCategory(data, categoryId));
        saving = false;
        if (!saved) return;
        app.render();
        modal.__forceClose();
        app.toast('Category deleted.');
    });

    saveCategory = async () => {
        if (saving || app.busy) return;
        if (locked) { modal.__forceClose(); return; }
        const name = String($('#st-codex-ce-name').value || '').trim();
        if (!name) {
            app.toast('Give the category a name.', true);
            return;
        }
        saving = true;
        const saved = await commitCategoryChange(app, data => updateCategory(data, categoryId, { name, color }));
        saving = false;
        if (!saved) return;
        app.render();
        modal.__forceClose();
        app.toast('Category updated.');
    };
    $('#st-codex-ce-save').addEventListener('click', saveCategory);
}
