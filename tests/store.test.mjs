import assert from 'node:assert/strict';
import {readFile, writeFile, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import test, {beforeEach, after} from 'node:test';
import {worldInfoCache} from './world-info-fixture.js';
const source = await readFile(new URL('../src/store.js', import.meta.url), 'utf8');
const modulePath = join(tmpdir(), `visual-lorebook-audit-${process.pid}.mjs`);
await writeFile(modulePath, source.replace("'/scripts/world-info.js'", JSON.stringify(new URL('./world-info-fixture.js', import.meta.url).href))
    .replace("'./native-cache.js'", JSON.stringify(new URL('../src/native-cache.js', import.meta.url).href))
    .replace('const REQUEST_TIMEOUT_MS = 15000;', 'const REQUEST_TIMEOUT_MS = 150;'));
const store = await import(pathToFileURL(modulePath));
after(() => unlink(modulePath));
const fixture = () => ({futureBook: {zero: 0, nullable: null}, extensions: {other: {keep: true}}, entries: {
    storage: {uid: 42, content: 'Lore 🐉 中文 é\n', key: ['/a{1,3}/i'], disable: false, unknown: {a: [null, false, 0]},
        extensions: {other: {nested: ['keep']}, visual_lorebook: {categoryId: 'character', future: {value: 1}}}},
    43: {uid: 43, content: '', extensions: {other: {value: 2}}},
}});
let disk, writes, requests, rejected, publishError, gate, entered, hangingResponse, unreadable;
const deferred = () => {let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve};};
const waitForAbort = signal => new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), {once: true});
});
beforeEach(() => {
    disk = new Map([['Fixture', fixture()]]); writes = []; rejected = false; publishError = false; gate = null; entered = null;
    requests = []; hangingResponse = null; unreadable = null;
    worldInfoCache.clear();
    globalThis.SillyTavern = {getContext: () => ({getRequestHeaders: () => ({'Content-Type': 'application/json'}),
        reloadEditor: async () => {}, event_types: {WORLDINFO_UPDATED: 'updated'},
        eventSource: {emit: async (event, name, data) => {
            assert(store.isOwnBookUpdate(data));
            if (publishError) throw new Error('foreign listener failure');
        }},
    })};
    globalThis.fetch = async (url, options) => {
        const {name, data, fileName} = JSON.parse(options.body);
        requests.push(url);
        if (hangingResponse?.url === url && !hangingResponse.body) return waitForAbort(options.signal);
        let value;
        if (url === '/api/files/sanitize-filename') value = {fileName};
        else if (url === '/api/worldinfo/list') value = [...disk.keys()].filter(file => file !== unreadable).map(file_id => ({file_id}));
        else if (url === '/api/worldinfo/get') {
            if (name === unreadable) return {ok: false, status: 500};
            value = disk.has(name) ? disk.get(name) : {entries: {}};
        }
        else if (url === '/api/worldinfo/edit') {
            if (entered) entered.resolve();
            if (gate) await gate.promise;
            if (rejected) return {ok: false, status: 500};
            writes.push({name, data: structuredClone(data)});
            disk.set(name, structuredClone(data)); value = {ok: true};
        } else throw new Error('Unexpected endpoint: ' + url);
        return {ok: true, status: 200, json: async () => hangingResponse?.url === url && hangingResponse.body
            ? waitForAbort(options.signal) : structuredClone(value)};
    };
});
test('reading categories does not mutate a native lorebook', () => {
    const data = fixture(), original = structuredClone(data);
    store.getCategories(data); assert.deepEqual(data, original);
});
test('visual patch preserves unspecified raw metadata, native fields and other extensions', () => {
    const data = fixture(); data.entries.storage.extensions.visual_lorebook.image = null;
    const expected = structuredClone(data.entries.storage);
    expected.extensions.visual_lorebook.categoryId = 'location';
    store.setEntryVisual(data.entries.storage, {categoryId: 'location'});
    assert.deepEqual(data.entries.storage, expected);
});
test('unknown category properties and future schema version survive targeted edits', () => {
    const data = fixture();
    data.extensions.visual_lorebook = {version: 99, future: {a: 1}, categories: [
        {id: 'uncategorized', name: 'Uncategorized', color: '#888888', order: 0},
        {id: 'character', name: 'Characters', color: '#ffffff', order: 1, future: [null, false]},
    ]};
    const expected = structuredClone(data); expected.extensions.visual_lorebook.categories[1].name = 'People';
    store.updateCategory(data, 'character', {name: 'People'}); assert.deepEqual(data, expected);
});
test('malformed metadata is preserved and unsafe edits fail closed', () => {
    const data = fixture(); data.entries.storage.extensions = ['unknown metadata'];
    const before = structuredClone(data);
    assert.throws(() => store.setEntryVisual(data.entries.storage, {image: ''})); assert.deepEqual(data, before);
    data.extensions.visual_lorebook = {categories: [{id: 'x'}, {id: 'x'}]};
    const copy = structuredClone(data);
    assert.throws(() => store.updateCategory(data, 'x', {name: 'changed'})); assert.deepEqual(data, copy);
});
test('duplication is detached and reserves a genuinely free identifier', () => {
    const data = fixture(), original = structuredClone(data);
    const copy = store.duplicateEntryDraft(data, data.entries.storage);
    assert.notEqual(copy.uid, 42); copy.extensions.other.nested.push('changed'); assert.deepEqual(data, original);
});
test('ambiguous native UIDs never delete multiple entries', async () => {
    const data = fixture(); data.entries[43].uid = 42; const before = structuredClone(data);
    await assert.rejects(store.deleteEntries('Fixture', data, ['42'])); assert.deepEqual(data, before);
});
test('unchanged load/save/reload round trip preserves every property and storage key', async () => {
    const original = structuredClone(disk.get('Fixture')); const data = await store.loadBook('Fixture');
    assert(!store.hasBookChanges(data)); store.getCategories(data);
    await store.saveBook('Fixture', data); assert.deepEqual(await store.loadBook('Fixture'), original);
    assert.deepEqual(writes[0].data, original);
});
test('one-field update preserves all unknown native fields, extensions and identifiers', async () => {
    const data = await store.loadBook('Fixture'); const expected = fixture();
    expected.entries.storage.content = data.entries.storage.content = 'Edited content';
    assert(store.hasBookChanges(data)); await store.saveBook('Fixture', data);
    assert.deepEqual(disk.get('Fixture'), expected); assert(!store.hasBookChanges(data));
});
test('prompt cache is detached from mutable local drafts', async () => {
    const data = await store.loadBook('Fixture'); await store.saveBook('Fixture', data);
    data.entries.storage.content = 'Unsaved'; assert.equal(worldInfoCache.get('Fixture').entries.storage.content, fixture().entries.storage.content);
});
test('HTTP rejection never publishes a cache change or confirms a save', async () => {
    const data = await store.loadBook('Fixture'); const original = structuredClone(disk.get('Fixture'));
    worldInfoCache.set('Fixture', structuredClone(original)); data.entries.storage.content = 'Draft'; rejected = true;
    await assert.rejects(store.saveBook('Fixture', data), /HTTP 500/);
    assert.deepEqual(worldInfoCache.get('Fixture'), original); assert.deepEqual(disk.get('Fixture'), original); assert.equal(writes.length, 0);
});
test('save queue recovers after failure without losing the retained draft', async () => {
    const data = await store.loadBook('Fixture'); data.entries.storage.content = 'Draft'; rejected = true;
    await assert.rejects(store.saveBook('Fixture', data)); rejected = false; await store.saveBook('Fixture', data);
    assert.equal(writes.length, 1); assert.equal(disk.get('Fixture').entries.storage.content, 'Draft');
});
test('overlapping writes serialize immutable enqueue-time snapshots', async () => {
    const data = await store.loadBook('Fixture'); gate = deferred(); entered = deferred();
    data.entries.storage.content = 'first'; const first = store.saveBook('Fixture', data); await entered.promise;
    data.entries.storage.content = 'second'; const second = store.saveBook('Fixture', data);
    data.entries.storage.content = 'unsubmitted'; gate.resolve(); await Promise.all([first, second]);
    assert.deepEqual(writes.map(write => write.data.entries.storage.content), ['first', 'second']);
    assert.equal(disk.get('Fixture').entries.storage.content, 'second'); assert(store.hasBookChanges(data));
});
test('a different book can save while another book write is pending', async () => {
    disk.set('Other', fixture()); const first = await store.loadBook('Fixture'), second = await store.loadBook('Other');
    gate = deferred(); entered = deferred(); const pending = store.saveBook('Fixture', first); await entered.promise;
    const blocked = gate; gate = null; await store.saveBook('Other', second); assert.equal(writes[0].name, 'Other');
    blocked.resolve(); await pending;
});
test('external disk edits are rejected rather than overwritten', async () => {
    const data = await store.loadBook('Fixture'); disk.get('Fixture').entries.storage.content = 'Foreign change';
    data.entries.storage.content = 'Stale local draft'; await assert.rejects(store.saveBook('Fixture', data), /outside Codex/);
    assert.equal(writes.length, 0); assert.equal(disk.get('Fixture').entries.storage.content, 'Foreign change');
});
test('native cached pending edits allow a disk view but block writes without touching the cache', async () => {
    const pending = fixture(); pending.entries.storage.content = 'Native pending';
    worldInfoCache.set('Fixture', pending);
    const data = await store.loadBook('Fixture');
    assert.deepEqual(data, fixture()); assert(store.hadNativeChangesOnLoad(data));
    assert.equal(worldInfoCache.get('Fixture'), pending);
    await assert.rejects(store.saveBook('Fixture', data), /pending or different native edits/);
    assert.equal(writes.length, 0);
    disk.set('Fixture', structuredClone(pending));
    await assert.rejects(store.saveBook('Fixture', data), /outside Codex/);
    const refreshed = await store.loadBook('Fixture');
    assert.deepEqual(refreshed, pending); assert(!store.hadNativeChangesOnLoad(refreshed));
});
test('explicit invalidation prevents queued stale saves', async () => {
    const data = await store.loadBook('Fixture'); store.invalidateBook(data);
    await assert.rejects(store.saveBook('Fixture', data), /outside Codex/); assert.equal(writes.length, 0);
});
test('externally deleted books are never silently recreated', async () => {
    const data = await store.loadBook('Fixture'); disk.delete('Fixture');
    await assert.rejects(store.saveBook('Fixture', data)); assert.equal(writes.length, 0); assert.equal(await store.loadBook('Fixture'), null);
});
test('malformed entry containers are rejected without repair or writes', async () => {
    for (const entries of [null, [], 'invalid', 7]) {
        disk.set('Malformed', {entries, future: 'keep'}); await assert.rejects(store.loadBook('Malformed'));
        assert.deepEqual(disk.get('Malformed'), {entries, future: 'keep'});
    }
    assert.equal(writes.length, 0);
});
test('failed deletion restores entries and linked metadata exactly', async () => {
    disk.get('Fixture').entries[43].extensions.visual_lorebook = {linkedEntryUids: ['42', 'other'], unknown: null};
    const data = await store.loadBook('Fixture'); const original = structuredClone(data); const entries = data.entries; rejected = true;
    await assert.rejects(store.deleteEntries('Fixture', data, ['42'])); assert.deepEqual(data, original); assert.equal(data.entries, entries);
});
test('successful deletion targets native UID despite a different storage key', async () => {
    disk.get('Fixture').entries[43].extensions.visual_lorebook = {linkedEntryUids: ['42', 'other'], unknown: null};
    const data = await store.loadBook('Fixture'); await store.deleteEntries('Fixture', data, ['42']);
    assert(!Object.hasOwn(data.entries, 'storage')); assert.equal(data.entries[43].uid, 43);
    assert.deepEqual(data.entries[43].extensions.visual_lorebook, {linkedEntryUids: ['other'], unknown: null}); assert.equal(writes.length, 1);
});
test('failed activation restores a missing disable property', async () => {
    const data = await store.loadBook('Fixture'); rejected = true;
    await assert.rejects(store.setEntryDisabled('Fixture', data, '43', true)); assert(!Object.hasOwn(data.entries[43], 'disable'));
});
test('native entry factory inserts exactly one entry with independent metadata', async () => {
    const data = await store.loadBook('Fixture'), original = fixture(); const entry = await store.createEntry('Fixture', data, 'location');
    assert.equal(Object.keys(data.entries).length, 3); assert(entry.factoryNativeDefault.retained);
    assert.deepEqual(data.entries.storage, original.entries.storage); assert.deepEqual(data.entries[43], original.entries[43]);
});
test('failed entry creation removes only the unsaved new entry', async () => {
    const data = await store.loadBook('Fixture'), original = structuredClone(data); rejected = true;
    await assert.rejects(store.createEntry('Fixture', data, 'location')); assert.deepEqual(data, original);
});
test('category deletion moves entries without changing any native field', () => {
    const data = fixture(); store.ensureCategories(data); const entry = structuredClone(data.entries.storage);
    assert(store.removeCategory(data, 'character')); entry.extensions.visual_lorebook.categoryId = 'uncategorized';
    assert.deepEqual(data.entries.storage, entry); assert(!store.removeCategory(data, 'uncategorized'));
});
test('manual ordering preserves native insertion order and unknown metadata', () => {
    const data = fixture(); const before = structuredClone(data);
    store.applyOrder(data, 'character', ['43', '42', '43']);
    assert.equal(store.getEntryVisual(data.entries[43]).sortOrder, 0); assert.equal(store.getEntryVisual(data.entries.storage).sortOrder, 1);
    assert.deepEqual(data.entries.storage.unknown, before.entries.storage.unknown); assert.equal(data.entries.storage.order, before.entries.storage.order);
});
test('empty and large Unicode entries survive JSON persistence', async () => {
    disk.set('Empty', {entries: {}, unknown: null}); let data = await store.loadBook('Empty'); await store.saveBook('Empty', data);
    const large = '🐉中文é\n'.repeat(150000); disk.get('Fixture').entries.storage.content = large;
    data = await store.loadBook('Fixture'); await store.saveBook('Fixture', data); assert.equal((await store.loadBook('Fixture')).entries.storage.content, large);
});
test('foreign event listener failure does not roll back a committed file', async () => {
    const data = await store.loadBook('Fixture'); publishError = true;
    const warn = console.warn; console.warn = () => {};
    try { assert.equal(await store.saveBook('Fixture', data), true); } finally { console.warn = warn; }
    assert.equal(writes.length, 1);
});
test('UID allocation handles the maximum safe integer without collisions', () => {
    const data = fixture(); data.entries[Number.MAX_SAFE_INTEGER] = {uid: Number.MAX_SAFE_INTEGER};
    assert(Number.isSafeInteger(store.freeUid(data))); assert(!Object.hasOwn(data.entries, store.freeUid(data)));
});
test('new UIDs reserve storage keys even when their records are malformed', async () => {
    disk.get('Fixture').entries[44] = null;
    const data = await store.loadBook('Fixture');
    const created = await store.createEntry('Fixture', data, 'character');
    assert.notEqual(created.uid, 44);
    assert(Object.hasOwn(data.entries, '44'));
    assert.equal(disk.get('Fixture').entries[44], null);
});
test('legacy link cleanup preserves the original type of unrelated links', async () => {
    const links = [42, 51, '52', null, {unknown: true}];
    disk.get('Fixture').entries[43].extensions.visual_lorebook = {linkedEntryUids: links};
    const data = await store.loadBook('Fixture');
    await store.deleteEntries('Fixture', data, ['42']);
    assert.deepEqual(data.entries[43].extensions.visual_lorebook.linkedEntryUids, links.slice(1));
});
test('native edits detected during a request are not overwritten in prompt cache', async () => {
    const data = await store.loadBook('Fixture'); gate = deferred(); entered = deferred();
    data.entries.storage.content = 'Local draft';
    const saving = store.saveBook('Fixture', data); await entered.promise;
    const foreign = fixture(); foreign.entries.storage.content = 'Native change during request';
    worldInfoCache.set('Fixture', foreign);
    gate.resolve(); await assert.rejects(saving, /during the save/);
    assert.equal(worldInfoCache.get('Fixture'), foreign);
    await assert.rejects(store.saveBook('Fixture', data)); assert.equal(writes.length, 1);
});
test('reordering categories changes order without normalizing raw metadata', () => {
    const data = fixture();
    data.extensions.visual_lorebook = {categories: [
        {id: 'uncategorized', order: 4}, {id: 'character', name: null, color: null, order: 5, future: {keep: true}},
    ]};
    store.setCategories(data, store.getCategories(data).reverse());
    assert.deepEqual(data.extensions.visual_lorebook.categories, [
        {id: 'character', name: null, color: null, order: 0, future: {keep: true}}, {id: 'uncategorized', order: 1},
    ]);
});

test('ordinary loads and saves never scan a large library', async () => {
    for (let i = 0; i < 500; i++) disk.set(`Other ${i}`, {entries: {}, unknown: i});
    const data = await store.loadBook('Fixture');
    data.entries.storage.content = 'Edited';
    await store.saveBook('Fixture', data);
    assert.deepEqual(requests, ['/api/worldinfo/get', '/api/worldinfo/get', '/api/worldinfo/edit']);
    assert.equal(disk.size, 501);
});

test('an externally deleted empty book cannot be recreated by a save', async () => {
    disk.set('Empty', {entries: {}});
    const data = await store.loadBook('Empty');
    disk.delete('Empty');
    data.entries[1] = {uid: 1, content: 'Draft'};
    await assert.rejects(store.saveBook('Empty', data), /outside Codex/);
    assert(!disk.has('Empty'));
    assert.equal(writes.length, 0);
});

test('existing case-distinct books on a case-sensitive host are independent', async () => {
    disk.set('fixture', {entries: {}});
    const upper = await store.loadBook('Fixture');
    const lower = await store.loadBook('fixture');
    lower.entries[1] = {uid: 1};
    await store.saveBook('fixture', lower);
    assert.deepEqual(disk.get('Fixture'), upper);
    assert.deepEqual(disk.get('fixture'), lower);
    await assert.rejects(store.createBook('FIXTURE'), /changed outside Codex/);
});

test('creation refuses an unreadable or malformed target missing from a native list', async () => {
    disk.set('Unreadable', {entries: {}});
    unreadable = 'Unreadable';
    await assert.rejects(store.createBook('Unreadable'), /HTTP 500/);
    disk.set('Malformed', null);
    await assert.rejects(store.createBook('Malformed'), /Invalid lorebook entries/);
    assert.equal(writes.length, 0);
});

test('a timed-out preflight can be retried without dispatching an edit', async () => {
    const data = await store.loadBook('Fixture');
    data.entries.storage.content = 'Draft';
    hangingResponse = {url: '/api/worldinfo/get'};
    await assert.rejects(store.saveBook('Fixture', data), /Reading lorebook timed out/);
    assert(!requests.includes('/api/worldinfo/edit'));
    hangingResponse = null;
    await store.saveBook('Fixture', data);
    assert.equal(writes.length, 1);
});

test('a timed-out edit response body releases the queue and fences later writes to that book', async () => {
    disk.set('Slow book', fixture());
    const data = await store.loadBook('Slow book');
    data.entries.storage.content = 'Possibly committed';
    hangingResponse = {url: '/api/worldinfo/edit', body: true};
    const first = store.saveBook('Slow book', data);
    data.entries.storage.content = 'Newer draft';
    const second = store.saveBook('Slow book', data);
    await Promise.all([
        assert.rejects(first, /Saving lorebook timed out/),
        assert.rejects(second, /server may still apply/),
    ]);
    assert.equal(writes.length, 1);
    assert.equal(disk.get('Slow book').entries.storage.content, 'Possibly committed');
    assert(!worldInfoCache.has('Slow book'));
    hangingResponse = null;
    const reopened = await store.loadBook('Slow book');
    await assert.rejects(store.saveBook('Slow book', reopened), /server may still apply/);
    await store.saveBook('Fixture', await store.loadBook('Fixture'));
    assert.equal(writes.length, 2);
});

test('a stalled native listener cannot hold a confirmed save open', async () => {
    const original = SillyTavern.getContext;
    SillyTavern.getContext = () => ({...original(), eventSource: {emit: () => new Promise(() => {})}});
    const data = await store.loadBook('Fixture');
    assert.equal(await store.saveBook('Fixture', data), true);
    assert.equal(writes.length, 1);
});

test('valid category changes preserve malformed and ambiguous neighbouring rows', () => {
    const data = fixture();
    const invalid = [null, {name: 'Missing ID'}, {id: 'dupe', name: 'One'}, {id: 'dupe', name: 'Two'}];
    data.extensions.visual_lorebook = {categories: [...invalid, {id: 'character', name: 'People'}]};
    store.updateCategory(data, 'character', {name: 'Characters'});
    assert.equal(data.extensions.visual_lorebook.categories[4].name, 'Characters');
    const added = store.addCategory(data, 'New');
    assert(store.removeCategory(data, 'character'));
    assert.deepEqual(data.extensions.visual_lorebook.categories, [...invalid, added]);
    assert.equal(data.entries.storage.extensions.visual_lorebook.categoryId, 'uncategorized');
    assert.throws(() => store.setCategories(data, store.getCategories(data)), /cannot be reordered/);
    assert.deepEqual(data.extensions.visual_lorebook.categories, [...invalid, added]);
});

test('server-relative thumbnails accept spaces and retain scheme and control-character checks', () => {
    assert.equal(store.sanitizeImageSrc('/user/images/My Portrait.png'), '/user/images/My Portrait.png');
    assert.equal(store.sanitizeImageSrc('user/images/My Portrait.png'), 'user/images/My Portrait.png');
    for (const source of ['file:///C:/My Images/photo.png', 'C:\\My Images\\photo.png', 'javascript:bad', 'java\tscript:bad', 'data:text/html,invalid']) {
        assert.equal(store.sanitizeImageSrc(source), '');
    }
});
