/**
 * Visual Lorebook / Codex — SillyTavern third-party extension entry point.
 *
 * Adds a full-screen Codex dashboard on top of the native World Info system.
 * Nothing here changes how SillyTavern triggers or injects lore: the extension
 * only reads and writes the same JSON that the built-in editor does, plus an
 * `extensions.visual_lorebook` bag that ST preserves but ignores.
 */

import { open, close, toggle, isOpen, mount, state, app } from './src/ui.js';
import { invalidateBook, isOwnBookUpdate } from './src/store.js';

const MENU_ITEM_ID = 'st-codex-menu-item';
const TOPBAR_ID = 'st-codex-open-button';

function buildMenuItem() {
    const item = document.createElement('div');
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.id = MENU_ITEM_ID;
    item.tabIndex = 0;
    item.title = 'Open the visual Codex';
    item.innerHTML = `
        <div class="fa-solid fa-book-atlas extensionsMenuExtensionButton"></div>
        <span>Visual Lorebook</span>`;
    const activate = event => {
        event?.preventDefault();
        event?.stopPropagation();
        toggle();
    };
    item.addEventListener('click', activate);
    item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') activate(event);
    });
    return item;
}

function installMenuEntry() {
    if (document.getElementById(MENU_ITEM_ID)) return true;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    menu.appendChild(buildMenuItem());
    return true;
}

/**
 * Blue Codex button inside the Worlds/Lorebooks drawer, on the same row as the
 * panel title — visible as soon as the lorebook panel is expanded.
 */
function installDrawerButton() {
    if (document.getElementById(TOPBAR_ID)) return true;

    const drawer = document.getElementById('WorldInfo');
    if (!drawer) return false;

    const header = drawer.querySelector(':scope > .flex-container')
        || drawer.querySelector('h3')?.parentElement;
    if (!header) return false;

    const button = document.createElement('button');
    button.type = 'button';
    button.id = TOPBAR_ID;
    button.className = 'st-codex-open-btn';
    button.title = 'Open the Visual Lorebook / Codex (Ctrl+Shift+L)';
    button.innerHTML = '<span class="st-codex-open-icon" aria-hidden="true"><i class="fa-solid fa-book-open"></i></span><span>Codex</span>';
    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        toggle();
    });

    header.appendChild(button);
    return true;
}

function waitForChrome(attempt = 0) {
    const menuReady = installMenuEntry();
    const topbarReady = installDrawerButton();
    if (menuReady && topbarReady) return;
    if (attempt > 60) return;
    setTimeout(() => waitForChrome(attempt + 1), 250);
}

function registerShortcut() {
    document.addEventListener('keydown', event => {
        if (!event.ctrlKey || !event.shiftKey) return;
        if (String(event.key).toLowerCase() !== 'l') return;
        event.preventDefault();
        toggle();
    });
}

function installNativeOpenPreference() {
    const container = document.getElementById('extensions_settings');
    const context = SillyTavern.getContext();
    if (!container || !context.extensionSettings) return;

    const panel = document.createElement('details');
    panel.className = 'st-codex-native-settings';
    panel.innerHTML = `
        <summary>Visual Lorebook / Codex</summary>
        <label class="checkbox_label" for="st-codex-open-from-native">
            <input type="checkbox" id="st-codex-open-from-native" aria-describedby="st-codex-native-open-hint">
            Open lorebooks in Codex from Pick to Edit
        </label>
        <small id="st-codex-native-open-hint">Applies to the lorebook editor picker. Active-world selection works as usual.</small>`;
    container.appendChild(panel);
    const input = panel.querySelector('input');
    const settings = () => SillyTavern.getContext().extensionSettings;
    const enabled = () => settings()?.visual_lorebook?.openFromNative === true;
    const sync = () => { input.checked = enabled(); };
    sync();
    input.addEventListener('change', () => {
        const preferences = settings();
        preferences.visual_lorebook = { ...preferences.visual_lorebook, openFromNative: input.checked };
        context.saveSettingsDebounced();
    });

    const selector = '#world_editor_select';
    function openSelected(select) {
        if (!enabled()) return;
        const option = select.selectedOptions[0];
        if (!option?.value || option.disabled) return;
        const names = context.getWorldInfoNames?.();
        const name = names ? names[option.value] : option.textContent;
        if (name) void open(name, { exact: true });
    }
    // Select2 raises a user-selection event. The plain mobile select instead
    // emits a trusted DOM change. Host-driven change events use neither path.
    const nativeSelection = new AbortController();
    document.addEventListener('change', event => {
        if (event.isTrusted && event.target.matches?.(selector)
            && !event.target.classList.contains('select2-hidden-accessible')) openSelected(event.target);
    }, { signal: nativeSelection.signal });
    const namespace = '.stCodexNativeOpen';
    jQuery(document).on(`select2:select${namespace}`, selector, function () { openSelected(this); });
    const settingsLoaded = (context.event_types || context.eventTypes)?.EXTENSION_SETTINGS_LOADED;
    if (settingsLoaded) context.eventSource?.on(settingsLoaded, sync);
    window.addEventListener('pagehide', function cleanup(event) {
        if (event.persisted) return;
        nativeSelection.abort();
        jQuery(document).off(namespace);
        if (settingsLoaded) context.eventSource?.removeListener(settingsLoaded, sync);
        window.removeEventListener('pagehide', cleanup);
    });
}

function registerSlashCommand() {
    try {
        const context = SillyTavern.getContext();
        const parser = context.SlashCommandParser;
        const SlashCommand = context.SlashCommand;
        if (!parser || !SlashCommand || typeof parser.addCommandObject !== 'function') return;

        parser.addCommandObject(SlashCommand.fromProps({
            name: 'codex',
            callback: () => {
                open();
                return '';
            },
            helpString: 'Open the Visual Lorebook / Codex dashboard.',
        }));
    } catch (error) {
        console.warn('[VisualLorebook] Slash command registration skipped.', error);
    }
}

function registerEventHooks() {
    try {
        const context = SillyTavern.getContext();
        const eventSource = context.eventSource;
        const eventTypes = context.event_types || context.eventTypes;
        if (!eventSource || !eventTypes) return;

        const refresh = () => {
            if (isOpen() && state.worldName) app.reload();
        };

        // `saveWorldInfo()` echoes back the very object we just wrote. Reloading
        // on that echo is both pointless and dangerous (it would swap state.data
        // under an open modal), so only react to *foreign* changes.
        if (eventTypes.WORLDINFO_UPDATED) {
            eventSource.on(eventTypes.WORLDINFO_UPDATED, (name, data) => {
                if (!state.worldName) return;
                if (name !== state.worldName) return;
                if (data === state.data || isOwnBookUpdate(data)) return;
                invalidateBook(state.data);
                if (isOpen()) app.reload();
            });
        }
        if (eventTypes.WORLDINFO_SETTINGS_UPDATED) eventSource.on(eventTypes.WORLDINFO_SETTINGS_UPDATED, refresh);
        if (eventTypes.CHAT_CHANGED) eventSource.on(eventTypes.CHAT_CHANGED, refresh);
    } catch (error) {
        console.warn('[VisualLorebook] Event hooks skipped.', error);
    }
}

jQuery(async () => {
    if (window.visualLorebook) return;
    mount();
    waitForChrome();
    registerShortcut();
    registerSlashCommand();
    registerEventHooks();
    installNativeOpenPreference();

    // Public handle for power users and other extensions.
    window.visualLorebook = { open, close, toggle, isOpen, mount, state };

    console.log('[VisualLorebook] Codex extension ready.');
});
