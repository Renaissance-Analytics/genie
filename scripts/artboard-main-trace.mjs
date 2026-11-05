/** Serialized before the owned CI/VM app entry. Never records commands, arguments, output or credential values. */
export function installArtboardMainTrace(root, injected) {
    if (!injected && process.env.GENIE_PAGE_PROBE !== '1') throw new Error('ArtBoard trace requires the owned test app');
    const ports = injected ?? {
        child: process.getBuiltinModule('node:child_process'), inspector: process.getBuiltinModule('node:inspector'),
        path: process.getBuiltinModule('node:path'), util: process.getBuiltinModule('node:util'),
        syncBuiltinESMExports: process.getBuiltinModule('node:module').syncBuiltinESMExports,
        now: () => performance.now(), wallNow: () => Date.now(), cpuUsage: () => process.cpuUsage(),
    };
    const events = [], originMs = ports.now(), originWallMs = ports.wallNow(); let dropped = 0, stopped = false;
    const originalExec = ports.child.execFile, originalPost = ports.inspector.Session.prototype.post, custom = ports.util.promisify.custom;
    const owned = ports.path.resolve(root);
    function targets(file, args) {
        if (typeof file !== 'string' || !/(?:^|[\\/])powershell(?:\.exe)?$/i.test(file) || !Array.isArray(args)) return null;
        const at = args.findIndex(value => typeof value === 'string' && value.toLowerCase() === '-encodedcommand'), encoded = args[at + 1];
        if (at < 0 || typeof encoded !== 'string' || encoded.length > 131072) return null;
        const body = Buffer.from(encoded, 'base64').toString('utf16le'), found = [];
        for (const match of body.matchAll(/Path=\[Text\.Encoding\]::Unicode\.GetString\(\[Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)\)/g)) {
            const path = Buffer.from(match[1], 'base64').toString('utf16le'), rel = ports.path.relative(owned, ports.path.resolve(path));
            const name = ports.path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + ports.path.sep) ? 'outside-owned-home' : rel.split(ports.path.sep).join('/').replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 240) || '.';
            if (!found.includes(name)) found.push(name); if (found.length >= 16) break;
        }
        return found.length ? found : null;
    }
    function begin(fields) {
        const event = { ...fields, startedMs: ports.now(), startedWallMs: ports.wallNow(), syncMs: null, syncCpuMs: null, durationMs: null, endedMs: null, endedWallMs: null, state: 'pending' };
        if (events.length < 1024) events.push(event); else dropped++;
        return { event, cpu: ports.cpuUsage() };
    }
    function synced(span) {
        const cpu = ports.cpuUsage(); span.event.syncMs = ports.now() - span.event.startedMs;
        span.event.syncCpuMs = Math.max(0, (cpu.user - span.cpu.user + cpu.system - span.cpu.system) / 1000);
    }
    function finish(span, error) {
        if (span.event.state !== 'pending') return;
        span.event.endedMs = ports.now(); span.event.endedWallMs = ports.wallNow(); span.event.durationMs = span.event.endedMs - span.event.startedMs;
        span.event.state = error ? 'failed' : 'done';
    }
    function aclSpan(args) {
        try { const paths = targets(args[0], args[1]); return paths ? begin({ kind: 'private-acl', targets: paths }) : null; } catch { return null; }
    }
    function wrappedExec(...args) {
        const span = aclSpan(args);
        if (!span) return Reflect.apply(originalExec, this, args);
        const callback = args.at(-1);
        if (typeof callback === 'function') args[args.length - 1] = function (...values) { finish(span, values[0]); return Reflect.apply(callback, this, values); };
        try { return Reflect.apply(originalExec, this, args); }
        catch (error) { finish(span, error); throw error; }
        finally { synced(span); }
    }
    // Node's custom promisifier returns a Promise WITH .child. Observe it without chaining/replacing that Promise.
    const originalCustom = originalExec[custom];
    if (typeof originalCustom === 'function') Object.defineProperty(wrappedExec, custom, { configurable: true, value: function (...args) {
        const span = aclSpan(args);
        if (!span) return Reflect.apply(originalCustom, this, args);
        try {
            const result = Reflect.apply(originalCustom, this, args);
            void result.then(() => finish(span, null), error => finish(span, error)); return result;
        } catch (error) { finish(span, error); throw error; }
        finally { synced(span); }
    } });
    function wrappedPost(...args) {
        if (args[0] !== 'Profiler.start' && args[0] !== 'Profiler.stop') return Reflect.apply(originalPost, this, args);
        const span = begin({ kind: 'profiler', method: args[0] }), callback = args.at(-1);
        if (typeof callback === 'function') args[args.length - 1] = function (...values) { finish(span, values[0]); return Reflect.apply(callback, this, values); };
        try { return Reflect.apply(originalPost, this, args); }
        catch (error) { finish(span, error); throw error; }
        finally { synced(span); }
    }
    ports.child.execFile = wrappedExec; ports.inspector.Session.prototype.post = wrappedPost; ports.syncBuiltinESMExports();
    return {
        snapshot: () => ({ originMs, originWallMs, stopped, dropped, events: events.map(event => ({ ...event, ...(event.targets ? { targets: [...event.targets] } : {}) })) }),
        stop() {
            if (stopped) return; stopped = true;
            if (ports.child.execFile === wrappedExec) ports.child.execFile = originalExec;
            if (ports.inspector.Session.prototype.post === wrappedPost) ports.inspector.Session.prototype.post = originalPost;
            ports.syncBuiltinESMExports();
        },
    };
}
