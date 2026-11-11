/**
 * SillyTavern 1.19 stores the first load by reference, then renders that same
 * object. Detach only objects proven to have come from the native disk reader.
 * Observe native writes so the guard can also distinguish an acknowledged
 * save from a draft published before the host's debounce or a failed request.
 */
export function observeNativeCache(cache, host = globalThis) {
    if (!(cache instanceof Map) || cache.cloneOnGet !== true || cache.cloneOnSet !== false
        || typeof host.fetch !== 'function') return null;

    const set = cache.set;
    const fetch = host.fetch;
    const reads = new WeakMap();
    const publications = new WeakMap();
    const pending = new Map();
    const inFlight = new Map();
    const uncertain = new Set();
    const revisions = new Map();
    const current = name => Map.prototype.get.call(cache, name);
    const advance = name => revisions.set(name, (revisions.get(name) ?? 0) + 1);

    function publish(name, value, saved = JSON.stringify(value)) {
        const snapshot = structuredClone(value);
        advance(name);
        publications.set(snapshot, { name, saved });
        return set.call(cache, name, snapshot);
    }

    cache.set = function (name, value) {
        if (this !== cache || typeof name !== 'string' || !value || typeof value !== 'object') return set.call(this, name, value);
        const read = reads.get(value);
        reads.delete(value);
        if (read?.name === name && JSON.stringify(value) === read.json) return publish(name, value, read.json);
        const publication = { name, value };
        advance(name);
        publications.set(value, publication);
        pending.set(name, publication);
        return set.call(this, name, value);
    };

    host.fetch = function (url, options) {
        const request = fetch.call(this, url, options);
        if (options?.method !== 'POST' || typeof options.body !== 'string') return request;
        const reading = url === '/api/worldinfo/get' && options.cache === 'no-cache';
        const writing = url === '/api/worldinfo/edit' && options.cache === undefined;
        if (!reading && !writing) return request;
        let payload;
        try { payload = JSON.parse(options.body); }
        catch { return request; }
        const name = payload?.name;
        if (typeof name !== 'string') return request;
        if (reading) {
            return request.then(response => {
                if (!response.ok) return response;
                const json = response.json;
                response.json = async function () {
                    const value = await json.call(this);
                    if (value && typeof value === 'object') reads.set(value, { name, json: JSON.stringify(value) });
                    return value;
                };
                return response;
            });
        }

        const publication = pending.get(name);
        const sent = JSON.stringify(payload.data);
        advance(name);
        inFlight.set(name, (inFlight.get(name) ?? 0) + 1);
        return request.then(async response => {
            if (!response.ok) return response;
            try {
                const result = await response.clone().json();
                if (result?.ok !== true) uncertain.add(name);
                else if (publication && pending.get(name) === publication) {
                    publication.acknowledged = sent;
                }
            } catch { uncertain.add(name); }
            return response;
        }, error => {
            uncertain.add(name);
            throw error;
        }).finally(() => {
            const count = inFlight.get(name) - 1;
            if (count) inFlight.set(name, count);
            else inFlight.delete(name);
        });
    };

    return {
        publish,
        revision: name => revisions.get(name),
        isUncertain: name => uncertain.has(name),
        hasConflict(name, diskJson) {
            if (pending.has(name) || inFlight.has(name) || uncertain.has(name)) return true;
            if (!cache.has(name)) return false;
            const value = current(name);
            const publication = publications.get(value);
            // A proven disk snapshot may be older than the file. Any in-place
            // change to it, or a publication without confirmation, stays fenced.
            return JSON.stringify(value) !== (publication?.name === name ? publication.saved : diskJson);
        },
        confirmNativeUpdate(name, value) {
            const publication = pending.get(name);
            if (publication && publication.value === value && publication.acknowledged !== undefined
                && JSON.stringify(value) === publication.acknowledged) {
                pending.delete(name);
                if (current(name) === value) publish(name, value);
            }
        },
    };
}
