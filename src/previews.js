import { POSITIONS, SELECTIVE_LOGIC, STRATEGIES, strategyOf } from './store.js';

const PANEL_ID = 'st-codex-card-preview';
const TRIGGER = '.st-codex-preview-trigger';
const HOVER_EXIT_GRACE_MS = 85;
const MATCH_SOURCES = [
    ['matchPersonaDescription', 'Persona description'],
    ['matchCharacterDescription', 'Character description'],
    ['matchCharacterPersonality', 'Character personality'],
    ['matchCharacterDepthPrompt', 'Character depth prompt'],
    ['matchScenario', 'Scenario'],
    ['matchCreatorNotes', 'Creator notes'],
];
const ROLES = [
    { value: 0, label: 'System' },
    { value: 1, label: 'User' },
    { value: 2, label: 'Assistant' },
];

function displayValue(value) {
    if (value == null) return 'Not set';
    return ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : 'Unsupported value';
}

function enumLabel(options, value, missing = 'Not set') {
    if (value == null) return missing;
    return options.find(option => option.value === value)?.label ?? `Unsupported (${displayValue(value)})`;
}

export function entrySettingsSummary(entry) {
    const match = MATCH_SOURCES.filter(([key]) => entry[key]).map(([, label]) => label);
    const delay = entry.delayUntilRecursion;
    let recursionDelay = 'Off';
    if (delay === true) recursionDelay = 'Level 1';
    else if (delay) {
        const supported = ['number', 'string'].includes(typeof delay) && Number(delay) > 0;
        recursionDelay = supported ? `Level ${delay}` : `Unsupported (${displayValue(delay)})`;
    }
    const insertion = [['Position', enumLabel(POSITIONS, entry.position)]];
    if (entry.position === 4) {
        insertion.push(['Depth', entry.depth ?? 'Native default'], ['Role', enumLabel(ROLES, entry.role, 'System (default)')]);
    } else if (entry.position === 7) {
        insertion.push(['Outlet', entry.outletName || 'Not set']);
    }
    if (entry.order != null) insertion.push(['Order', entry.order]);
    if (entry.ignoreBudget) insertion.push(['Ignore token budget', 'On']);

    const activation = [['Strategy', enumLabel(STRATEGIES, strategyOf(entry))]];
    if (entry.disable) activation.push(['Status', 'Disabled']);
    if (entry.useProbability) {
        const probability = displayValue(entry.probability);
        activation.push(['Probability', typeof entry.probability === 'number' ? `${probability}%` : probability]);
    }
    if (entry.selective && Array.isArray(entry.keysecondary) && entry.keysecondary.length) {
        activation.push(['Filter-key logic', enumLabel(SELECTIVE_LOGIC, entry.selectiveLogic)]);
    }
    return [
        ['Insertion', insertion],
        ['Recursion', [
            ['Prevent further recursion', entry.preventRecursion ? 'On' : 'Off'],
            ['Exclude from recursion', entry.excludeRecursion ? 'On' : 'Off'],
            ['Delay until recursion', recursionDelay],
        ]],
        ['Activation', activation],
        ['Also match against', [['Sources', match.join(', ') || 'No extra sources selected']]],
    ];
}

function node(tag, content, className) {
    const element = document.createElement(tag);
    if (content != null) element.textContent = displayValue(content);
    if (className) element.className = className;
    return element;
}

function fillPreview(body, entry, type) {
    body.replaceChildren();
    if (type === 'keywords') {
        for (const [heading, keys] of [['Primary keys', entry.key], ['Filter keys', entry.keysecondary]]) {
            if (!Array.isArray(keys) || !keys.length) continue;
            const list = node('ul', null, 'st-codex-preview-tags');
            for (const key of keys) list.append(node('li', displayValue(key)));
            body.append(node('h4', heading), list);
        }
        return;
    }
    for (const [heading, rows] of entrySettingsSummary(entry)) {
        const list = node('dl');
        for (const [label, value] of rows) list.append(node('dt', label), node('dd', value));
        body.append(node('h4', heading), list);
    }
}

/** Share a single top-layer panel across the cards and build its contents on demand. */
export function installCardPreviews(root, getEntry) {
    const panel = node('section', null, 'st-codex-card-popover');
    const heading = node('h3');
    const body = node('div', null, 'st-codex-preview-body');
    const dismiss = node('button', '×', 'st-codex-preview-dismiss');
    const header = node('header');
    const pinStatus = node('span', null, 'st-codex-preview-pin-status');
    const hasTopLayer = typeof panel.showPopover === 'function';
    panel.id = PANEL_ID;
    panel.hidden = true;
    panel.tabIndex = -1;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', `${PANEL_ID}-title`);
    body.tabIndex = 0;
    if (hasTopLayer) panel.setAttribute('popover', 'manual');
    heading.id = `${PANEL_ID}-title`;
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Close preview');
    pinStatus.setAttribute('aria-hidden', 'true');
    header.append(heading, pinStatus, dismiss);
    panel.append(header, body);
    document.body.append(panel);

    let anchor = null;
    let pinned = false;
    let exitTimer = 0;
    let hoverPoint = null;
    let positionFrame = 0;
    let listeners;

    function triggerFor(target) {
        const trigger = target instanceof Element ? target.closest(TRIGGER) : null;
        return root.contains(trigger) ? trigger : null;
    }

    function insidePreview(target) {
        return target instanceof Node && (anchor?.contains(target) || panel.contains(target));
    }

    function cancelExit() {
        if (!exitTimer) return;
        clearTimeout(exitTimer);
        exitTimer = 0;
    }

    function resetTrigger(trigger) {
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-pressed', 'false');
    }

    function setPinned(value) {
        pinned = value;
        anchor.setAttribute('aria-pressed', String(value));
        panel.toggleAttribute('data-pinned', value);
        pinStatus.textContent = value ? 'Pinned' : 'Click to pin';
    }

    function close(restoreFocus = false) {
        cancelExit();
        hoverPoint = null;
        if (!anchor) return;
        const previous = anchor;
        resetTrigger(previous);
        anchor = null;
        pinned = false;
        listeners.abort();
        cancelAnimationFrame(positionFrame);
        positionFrame = 0;
        if (hasTopLayer) panel.hidePopover();
        panel.hidden = true;
        panel.removeAttribute('data-pinned');
        body.replaceChildren();
        if (restoreFocus && previous.isConnected) previous.focus({ preventScroll: true });
    }

    function position() {
        positionFrame = 0;
        if (!anchor?.isConnected) return close();
        const visual = window.visualViewport;
        const left = visual?.offsetLeft ?? 0;
        const top = visual?.offsetTop ?? 0;
        const right = left + (visual?.width ?? document.documentElement.clientWidth);
        const bottom = top + (visual?.height ?? document.documentElement.clientHeight);
        const rect = anchor.getBoundingClientRect();
        const scroller = root.getBoundingClientRect();
        if (!rect.width || rect.bottom <= Math.max(top, scroller.top) || rect.top >= Math.min(bottom, scroller.bottom)
            || rect.right <= left || rect.left >= right) return close();

        const margin = 8;
        panel.style.width = `${Math.max(0, Math.min(350, right - left - 2 * margin))}px`;
        const limit = Math.max(0, Math.min(360, bottom - top - 2 * margin));
        panel.style.maxHeight = `${limit}px`;
        const naturalHeight = panel.getBoundingClientRect().height;
        const above = rect.top - top - 2 * margin;
        const below = bottom - rect.bottom - 2 * margin;
        const placeBelow = below >= naturalHeight || below >= above;
        const space = placeBelow ? below : above;
        if (space >= 100) panel.style.maxHeight = `${Math.min(limit, space)}px`;
        const { width, height } = panel.getBoundingClientRect();
        const x = Math.max(left + margin, Math.min(rect.left, right - margin - width));
        const targetY = placeBelow ? rect.bottom + margin : rect.top - margin - height;
        const y = Math.max(top + margin, Math.min(targetY, bottom - margin - height));
        panel.style.left = `${x}px`;
        panel.style.top = `${y}px`;
        if (!hasTopLayer) {
            // A transformed host ancestor can offset a fixed element.
            const measured = panel.getBoundingClientRect();
            panel.style.left = `${x + x - measured.left}px`;
            panel.style.top = `${y + y - measured.top}px`;
        }
    }

    function schedulePosition(event) {
        if (event?.target instanceof Node && panel.contains(event.target)) return;
        if (positionFrame) return;
        positionFrame = requestAnimationFrame(() => {
            position();
            // Scrolling can move a trigger away from a stationary pointer.
            if (anchor && !pinned && hoverPoint) {
                updateHover(document.elementFromPoint(hoverPoint.x, hoverPoint.y));
            }
        });
    }

    function updateHover(target) {
        if (!anchor || pinned) return;
        if (insidePreview(target)) {
            cancelExit();
            return;
        }
        if (!target) {
            close();
            return;
        }
        if (exitTimer) return;
        const leaving = anchor;
        exitTimer = setTimeout(() => {
            exitTimer = 0;
            if (anchor === leaving && !pinned) close();
        }, HOVER_EXIT_GRACE_MS);
    }

    function trackHover(event) {
        if (pinned || event.pointerType === 'touch') return;
        hoverPoint = { x: event.clientX, y: event.clientY };
        updateHover(event.type === 'pointerout' ? event.relatedTarget : event.target);
    }

    function watchOpenPanel() {
        listeners = new AbortController();
        const { signal } = listeners;
        const capture = { capture: true, signal };
        window.addEventListener('resize', schedulePosition, { signal });
        window.addEventListener('scroll', schedulePosition, { capture: true, passive: true, signal });
        window.visualViewport?.addEventListener('resize', schedulePosition, { signal });
        window.visualViewport?.addEventListener('scroll', schedulePosition, { signal });
        window.addEventListener('blur', () => { if (!pinned) close(); }, { signal });
        document.addEventListener('pointerover', trackHover, capture);
        document.addEventListener('pointerout', trackHover, capture);
        document.addEventListener('pointermove', trackHover, capture);
        document.addEventListener('pointerdown', event => {
            if (!insidePreview(event.target) && !triggerFor(event.target)) close();
        }, capture);
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            close(panel.contains(document.activeElement));
        }, capture);
        document.addEventListener('focusin', event => {
            if (event.target.closest('.st-codex-modal-backdrop')) return close();
            if (pinned && !insidePreview(event.target) && !triggerFor(event.target)) close();
        }, { signal });
    }

    function show(trigger, keepOpen) {
        cancelExit();
        if (trigger === anchor) {
            if (!keepOpen) return;
            if (pinned) return close(true);
            setPinned(true);
            panel.focus({ preventScroll: true });
            return;
        }
        if (!trigger.isConnected || document.querySelector('.st-codex-modal-backdrop')) return close();
        const entry = getEntry(trigger);
        if (!entry) return close();
        const opening = !anchor;
        if (anchor) resetTrigger(anchor);
        anchor = trigger;
        setPinned(keepOpen);
        const type = trigger.dataset.preview;
        heading.textContent = type === 'keywords' ? 'Trigger keys' : 'Entry settings';
        fillPreview(body, entry, type);
        anchor.setAttribute('aria-expanded', 'true');
        if (opening) {
            panel.hidden = false;
            if (hasTopLayer) panel.showPopover();
            watchOpenPanel();
        }
        position();
        body.scrollTop = 0;
        if (anchor && pinned) panel.focus({ preventScroll: true });
    }

    root.addEventListener('pointerover', event => {
        if (event.pointerType === 'touch' || event.buttons || pinned) return;
        const trigger = triggerFor(event.target);
        if (!trigger || triggerFor(event.relatedTarget) === trigger) return;
        hoverPoint = { x: event.clientX, y: event.clientY };
        show(trigger, false);
    });
    root.addEventListener('click', event => {
        const trigger = triggerFor(event.target);
        if (trigger) show(trigger, true);
    });
    dismiss.addEventListener('click', () => close(true));
    return { close };
}
