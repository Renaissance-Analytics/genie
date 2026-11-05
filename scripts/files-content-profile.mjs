/** CI/VM measurement only. No product imports, payload capture or transport of its own. */
export function summarizeCpuProfile(profile) {
    const samples = profile.samples ?? [], deltas = profile.timeDeltas ?? [];
    if (samples.length !== deltas.length) throw new Error('CPU samples and time deltas differ');
    const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame])), frames = new Map();
    let sampleMs = 0;
    for (let i = 0; i < samples.length; i++) {
        const frame = nodes.get(samples[i]);
        if (!frame || !Number.isFinite(deltas[i]) || deltas[i] < 0) throw new Error('invalid CPU sample node or delta');
        const name = frame.functionName || '(anonymous)', url = frame.url ?? '', line = frame.lineNumber ?? -1;
        const key = JSON.stringify([name, url, line]), entry = frames.get(key) ?? { name, url, line, selfMs: 0, samples: 0 };
        entry.selfMs += deltas[i] / 1000; entry.samples++; sampleMs += deltas[i] / 1000; frames.set(key, entry);
    }
    return { durationMs: (profile.endTime - profile.startTime) / 1000, sampleMs, frames: [...frames.values()].sort((a, b) => b.selfMs - a.selfMs) };
}

/** Serialized into each owned app process; all state and cleanup belong to this invocation. */
export function installFilesCounters(scope, now = () => performance.now()) {
    let entries = new Map(), pending = new Map(), calls = [], active = true;
    const undo = [];
    const observe = value => {
        if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.id)) return;
        if (value.kind === 'call' && typeof value.method === 'string' && !pending.has(value.id)) pending.set(value.id, { method: value.method, start: now() });
        if (value.kind === 'result') {
            const call = pending.get(value.id);
            if (call) { calls.push({ method: call.method, ms: now() - call.start }); pending.delete(value.id); }
        }
    };
    const paths = ['atob', 'btoa', 'JSON.parse', 'JSON.stringify', 'TextEncoder.prototype.encode', 'TextDecoder.prototype.decode', 'crypto.subtle.digest', 'Uint8Array.fromBase64', 'Uint8Array.prototype.toBase64', 'Buffer.from', 'Buffer.prototype.toString'];
    for (const path of paths) {
        const parts = path.split('.'), key = parts.pop();
        let owner = scope; for (const part of parts) owner = owner?.[part];
        const original = owner?.[key]; if (typeof original !== 'function') continue;
        const wrapped = function (...args) {
            if (!active) return original.apply(this, args);
            const entry = entries.get(path) ?? { calls: 0, syncMs: 0, wallMs: 0 };
            entries.set(path, entry); entry.calls++;
            const start = now();
            let value;
            try { value = original.apply(this, args); }
            catch (error) { const ms = now() - start; entry.syncMs += ms; entry.wallMs += ms; throw error; }
            entry.syncMs += now() - start;
            if (path === 'JSON.stringify') observe(args[0]);
            if (path === 'JSON.parse') observe(value);
            if (value && typeof value.then === 'function') return value.then(result => { entry.wallMs += now() - start; return result; }, error => { entry.wallMs += now() - start; throw error; });
            entry.wallMs += now() - start; return value;
        };
        owner[key] = wrapped;
        undo.push(() => { if (owner[key] === wrapped) owner[key] = original; });
    }
    return {
        reset() { entries = new Map(); pending = new Map(); calls = []; },
        pause() { active = false; }, resume() { active = true; },
        summary() { return Object.fromEntries([...entries].map(([key, value]) => [key, { ...value }])); },
        calls() { return calls.map(call => ({ ...call })); },
        stop() { active = false; for (const restore of undo.splice(0)) restore(); },
    };
}

/** CI/VM only: fs/launch spans contain no paths, arguments, environment or content. */
export function installFilesStageCounters(scope, now = () => performance.now()) {
    const builtin = name => scope.process?.getBuiltinModule?.(name) ?? {};
    const undo = [], seen = new WeakSet();
    let events = [], gaps = [], dropped = 0, ticks = 0, maxGapMs = 0, epoch = now(), last = epoch, generation = 0;
    const record = (value, ownGeneration) => {
        if (ownGeneration !== generation) return;
        if (events.length < 1000) events.push(value); else dropped++;
    };
    const replace = (owner, key, wrapped) => {
        const original = owner[key], descriptor = Object.getOwnPropertyDescriptor(owner, key);
        owner[key] = wrapped;
        undo.push(() => { if (owner[key] === wrapped) { if (descriptor) Object.defineProperty(owner, key, descriptor); else delete owner[key]; } });
        return original;
    };
    const instrument = (owner, key, operation, complete = value => value) => {
        const original = owner?.[key]; if (typeof original !== 'function') return;
        replace(owner, key, function (...args) {
            const start = now(), ownEpoch = epoch, ownGeneration = generation;
            let value;
            try { value = original.apply(this, args); }
            catch (error) { record({ operation, startedMs: start - ownEpoch, syncMs: now() - start, wallMs: now() - start, ok: false }, ownGeneration); throw error; }
            const syncMs = now() - start;
            const finish = (result, ok) => { record({ operation, startedMs: start - ownEpoch, syncMs, wallMs: now() - start, ok }, ownGeneration); return result; };
            if (value && typeof value.then === 'function') return value.then(result => complete(finish(result, true)), error => { finish(null, false); throw error; });
            return complete(finish(value, true));
        });
    };
    const handle = file => {
        if (!file || seen.has(file)) return file;
        seen.add(file);
        for (const key of ['read', 'write', 'close']) instrument(file, key, `file.${key}`);
        return file;
    };
    const fs = builtin('node:fs/promises');
    for (const key of ['mkdir', 'lstat', 'readFile', 'writeFile', 'rename', 'rm']) instrument(fs, key, `fs.${key}`);
    instrument(fs, 'open', 'fs.open', handle);
    const prototype = builtin('node:child_process').ChildProcess?.prototype, originalSpawn = prototype?.spawn;
    if (typeof originalSpawn === 'function') replace(prototype, 'spawn', function (...args) {
        const start = now(), ownEpoch = epoch, ownGeneration = generation;
        const executable = /(?:^|[\\/])powershell(?:\.exe)?$/i.test(args[0]?.file ?? '') ? 'powershell' : 'other';
        let syncMs = 0, finished = false;
        const finish = ok => {
            if (finished) return; finished = true;
            this.off('close', close); this.off('error', error);
            record({ operation: 'child.spawn', executable, startedMs: start - ownEpoch, syncMs, wallMs: now() - start, ok }, ownGeneration);
        };
        const close = code => finish(code === 0), error = () => finish(false);
        this.once('close', close); this.once('error', error);
        try { const value = originalSpawn.apply(this, args); syncMs = now() - start; return value; }
        catch (failure) { syncMs = now() - start; finish(false); throw failure; }
    });
    builtin('node:module').syncBuiltinESMExports?.();
    const timer = scope.setInterval(() => {
        const at = now(), ms = at - last;
        maxGapMs = Math.max(maxGapMs, ms); ticks++;
        if (ms >= 100) { if (gaps.length < 100) gaps.push({ startedMs: last - epoch, ms }); else dropped++; }
        last = at;
    }, 20);
    return {
        reset() { events = []; gaps = []; dropped = 0; ticks = 0; maxGapMs = 0; epoch = now(); last = epoch; generation++; },
        summary() { return { events: events.map(event => ({ ...event })), gaps: gaps.map(gap => ({ ...gap })), dropped, ticks, maxGapMs }; },
        stop() { scope.clearInterval(timer); generation++; for (const restore of undo.splice(0).reverse()) restore(); builtin('node:module').syncBuiltinESMExports?.(); },
    };
}
