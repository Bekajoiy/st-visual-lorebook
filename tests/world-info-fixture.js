// Isolated native-module surface. No real SillyTavern data or APIs are loaded.
export const worldInfoCache = new Map();
export function createWorldInfoEntry(name, data) {
    let uid = 0;
    while (Object.hasOwn(data.entries, uid)) uid++;
    return data.entries[uid] = {uid, content: '', key: [], factoryNativeDefault: {retained: true}};
}
