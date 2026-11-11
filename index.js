/**
 * Visual Lorebook / Codex — SillyTavern third-party extension entry point.
 *
 * Adds a full-screen Codex dashboard on top of the native World Info system.
 * Nothing here changes how SillyTavern triggers or injects lore: the extension
 * only reads and writes the same JSON that the built-in editor does, plus an
 * `extensions.visual_lorebook` bag that ST preserves but ignores.
 */

import { open, close, toggle, isOpen, mount, state, app } from './src/ui.js';
import { confirmNativeBookUpdate, initializeNativeCacheProtection, invalidateBook, isOwnBookUpdate } from './src/store.js';

void initializeNativeCacheProtection();

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

function installSettingsPanel() {
    const container = document.getElementById('extensions_settings');
    if (!container || document.getElementById('st-codex-extension-settings')) return;

    const panel = document.createElement('div');
    panel.id = 'st-codex-extension-settings';
    panel.className = 'inline-drawer';
    panel.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Visual Lorebook / Codex</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <button type="button" class="menu_button menu_button_icon">
                <i class="fa-solid fa-book-open" aria-hidden="true"></i>
                <span>Open Codex</span>
            </button>
        </div>`;
    panel.querySelector('button').addEventListener('click', () => open());
    container.appendChild(panel);
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
                if (isOwnBookUpdate(data)) return;
                confirmNativeBookUpdate(name, data);
                if (!state.worldName) return;
                if (name !== state.worldName) return;
                if (data === state.data) return;
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
    installSettingsPanel();

    // Public handle for power users and other extensions.
    window.visualLorebook = { open, close, toggle, isOpen, mount, state };

    console.log('[VisualLorebook] Codex extension ready.');
});
