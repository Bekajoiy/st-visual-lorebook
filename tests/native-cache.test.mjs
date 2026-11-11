import assert from 'node:assert/strict';
import test from 'node:test';
import { observeNativeCache } from '../src/native-cache.js';

class NativeCache extends Map {
    cloneOnGet = true;
    cloneOnSet = false;
    get(key) { return structuredClone(super.get(key)); }
}
const name = 'Disposable fixture';
const original = { entries: { 1: { uid:1, sticky:null, content:'Old', extensions: { other:{ retain:true } } } } };
const json = JSON.stringify(original);
const read = { method:'POST', cache:'no-cache', body:JSON.stringify({name}) };
const edit = data => ({ method:'POST', body:JSON.stringify({name,data}) });

function fixture() {
    const cache = new NativeCache();
    let nextResponse = async () => Response.json({ok:true});
    const host = { fetch: async path => path.endsWith('/get') ? Response.json(original) : nextResponse() };
    const guard = observeNativeCache(cache, host);
    return { cache, host, guard, respond: callback => { nextResponse = callback; } };
}

test('native read leaves rendering object detached and preserves the exact disk snapshot', async () => {
    const {cache, host, guard} = fixture();
    const data = await (await host.fetch('/api/worldinfo/get', read)).json();
    assert.equal(cache.set(name, data), cache);
    data.entries[1].sticky = 0;
    data.entries[1].displayIndex = 1;
    assert.deepEqual(cache.get(name), original);
    assert.equal(guard.hasConflict(name, json), false);
    assert.equal(guard.hasConflict(name, JSON.stringify({entries:{}})), false);
});

test('even a draft equal to disk is fenced from native enqueue through verified completion', async () => {
    const {cache, host, guard} = fixture();
    const draft = structuredClone(original);
    cache.set(name, draft);
    assert(guard.hasConflict(name, json));
    await host.fetch('/api/worldinfo/edit', edit(draft));
    assert(guard.hasConflict(name, json));
    guard.confirmNativeUpdate(name, draft);
    assert.equal(guard.hasConflict(name, json), false);
    draft.entries[1].sticky = 0;
    assert.deepEqual(cache.get(name), original);
});

test('an older response cannot acknowledge a newer native publication of the same object', async () => {
    const {cache, host, guard, respond} = fixture();
    const draft = structuredClone(original);
    cache.set(name, draft);
    let release;
    respond(() => new Promise(resolve => { release = resolve; }));
    const older = host.fetch('/api/worldinfo/edit', edit(draft));
    draft.entries[1].content = 'Newer';
    cache.set(name, draft);
    release(Response.json({ok:true}));
    await older;
    guard.confirmNativeUpdate(name, draft);
    assert(guard.hasConflict(name, json));
    respond(async () => Response.json({ok:true}));
    await host.fetch('/api/worldinfo/edit', edit(draft));
    guard.confirmNativeUpdate(name, draft);
    assert.equal(guard.hasConflict(name, JSON.stringify(draft)), false);
});

test('a failed native response and its update event keep pending data fenced', async () => {
    const {cache, host, guard, respond} = fixture();
    const draft = structuredClone(original);
    cache.set(name, draft);
    respond(async () => Response.json({error:'failed'}, {status:500}));
    await host.fetch('/api/worldinfo/edit', edit(draft));
    guard.confirmNativeUpdate(name, draft);
    assert(guard.hasConflict(name, json));
    assert.equal(guard.isUncertain(name), false);
    cache.set(name, draft);
    respond(async () => Response.json({ok:true}));
    await host.fetch('/api/worldinfo/edit', edit(draft));
    guard.confirmNativeUpdate(name, draft);
    assert.equal(guard.hasConflict(name, json), false);
});

test('lost acknowledgement stays fenced across a later successful save', async () => {
    const {cache, host, guard, respond} = fixture();
    const draft = structuredClone(original);
    cache.set(name, draft);
    respond(async () => { throw new Error('lost response'); });
    await assert.rejects(host.fetch('/api/worldinfo/edit', edit(draft)), /lost response/);
    assert(guard.isUncertain(name));
    cache.set(name, draft);
    respond(async () => Response.json({ok:true}));
    await host.fetch('/api/worldinfo/edit', edit(draft));
    guard.confirmNativeUpdate(name, draft);
    assert(guard.hasConflict(name, json));
});

test('an intervening native disk read cannot clear a pending publication', async () => {
    const {cache, host, guard} = fixture();
    const draft = structuredClone(original);
    draft.entries[1].content = 'Unsaved';
    cache.set(name, draft);
    const readAgain = await (await host.fetch('/api/worldinfo/get', read)).json();
    cache.set(name, readAgain);
    assert(guard.hasConflict(name, json));
    await host.fetch('/api/worldinfo/edit', edit(draft));
    guard.confirmNativeUpdate(name, draft);
    assert.equal(guard.hasConflict(name, JSON.stringify(draft)), false);
});

test('editing a native read result before publication does not confer disk provenance', async () => {
    const {cache, host, guard} = fixture();
    const data = await (await host.fetch('/api/worldinfo/get', read)).json();
    data.entries[1].content = 'Native draft before cache publication';
    cache.set(name, data);
    assert(guard.hasConflict(name, json));
});
