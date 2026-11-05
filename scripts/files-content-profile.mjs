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
