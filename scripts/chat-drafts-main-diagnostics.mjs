/** Serialized into the owned CI/VM main inspector. Retains numeric diagnostics only. */
export function installDraftMainDiagnostics({ buffer, now, onGc }) {
    const empty = () => ({ calls: 0, bytes: 0, errors: 0, totalMs: 0, maxMs: 0 });
    let decode = empty(), encode = empty(), gc = { count: 0, totalMs: 0, maxMs: 0, events: [], maximum: null }, since = now(), stopped = false;
    const from = buffer.from, toString = buffer.prototype.toString;
    function decoded(...args) {
        if (args[1] !== 'base64') return from.apply(this, args);
        const stats = decode, started = now(); let failed = true;
        stats.calls++;
        try { const value = from.apply(this, args); stats.bytes += value.byteLength ?? value.length; failed = false; return value; }
        finally { const ms = Math.max(0, now() - started); stats.totalMs += ms; stats.maxMs = Math.max(stats.maxMs, ms); if (failed) stats.errors++; }
    }
    function encoded(...args) {
        if (args[0] !== 'base64') return toString.apply(this, args);
        const stats = encode, started = now(); let failed = true;
        stats.calls++; stats.bytes += this.byteLength ?? this.length;
        try { const value = toString.apply(this, args); failed = false; return value; }
        finally { const ms = Math.max(0, now() - started); stats.totalMs += ms; stats.maxMs = Math.max(stats.maxMs, ms); if (failed) stats.errors++; }
    }
    buffer.from = decoded; buffer.prototype.toString = encoded;
    let stopGc;
    try {
        stopGc = onGc(entries => {
            if (stopped) return;
            for (const entry of entries) {
                if (!Number.isFinite(entry.startTime) || entry.startTime < since || !Number.isFinite(entry.duration) || entry.duration < 0) continue;
                const event = { startTime: entry.startTime, duration: entry.duration, kind: entry.detail?.kind ?? null };
                gc.count++; gc.totalMs += event.duration;
                if (event.duration >= gc.maxMs) { gc.maxMs = event.duration; gc.maximum = event; }
                if (gc.events.length < 256) gc.events.push(event);
            }
        });
    } catch (error) {
        if (buffer.from === decoded) buffer.from = from;
        if (buffer.prototype.toString === encoded) buffer.prototype.toString = toString;
        throw error;
    }
    return {
        reset() { decode = empty(); encode = empty(); gc = { count: 0, totalMs: 0, maxMs: 0, events: [], maximum: null }; since = now(); },
        snapshot() { return { since, elapsedMs: Math.max(0, now() - since), decode: { ...decode }, encode: { ...encode }, gc: { ...gc, events: gc.events.map(event => ({ ...event })), maximum: gc.maximum ? { ...gc.maximum } : null } }; },
        stop() {
            if (stopped) return; stopped = true;
            if (buffer.from === decoded) buffer.from = from;
            if (buffer.prototype.toString === encoded) buffer.prototype.toString = toString;
            stopGc();
        },
    };
}
