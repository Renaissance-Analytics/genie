#!/usr/bin/env node
/**
 * THE MEMORY SOAK (Tynn #662). TEST VM ONLY: it starts its own app, on a home and ports of its own, and never touches another.
 *
 * The owner, 61.2 on Windows, 2026-11-12: window main went 1955 -> 3617 MB within a minute and hung; window processes
 * vanished twice with no Windows error; genie-host swung 200 -> 800-1426 MB and back every few minutes all afternoon.
 *
 * What it does, in the real app: the owner's estate seeded (scripts/perf-lag/memory-soak-seed.mjs: 32 agents, ten threads
 * of 6,000 rows, four agents streaming the whole time, 9,500 mails, 240 open questions and 4 MB of attention history),
 * then for `--minutes` (default 30): a chat switch every 3 s (the agent's own view, then its workspace with its chat),
 * and every 20 s a question dismissed on the Deck (what the owner's answers did at 17:53). Every 10 s: window main's,
 * genie-host's and the page's memory (process.memoryUsage + V8's heap), and the engine link's wire as each side read it
 * (chunks, the longest line, and how many characters a reader that re-joins its buffer per chunk would copy). Over the
 * whole run, in 5-minute windows, V8's SAMPLING HEAP PROFILER on window main and genie-host, objects collected by GC
 * INCLUDED: what allocated, garbage or not. A heap snapshot of a process the first time its RSS passes 1 GB.
 *
 *   node scripts/perf-lag/memory-soak-cdp.mjs [--minutes 30] [--label name]     (or .soak-minutes / .soak-label files)
 *
 * Writes soak-out/<label>-samples.jsonl, -summary.json, -profile-<proc>-<n>.heapprofile, -alloc-<proc>.json.
 */
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { installUiLagHostLaunch } from './ui-lag-host-launch.mjs';
import { seedSoak } from './memory-soak-seed.mjs';

const WIN = process.platform === 'win32';
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
// In-Session passes no arguments: a VM job may say them in files beside the checkout instead.
const fileArg = (name) => { try { return readFileSync(`.soak-${name}`, 'utf8').trim() || undefined; } catch { return undefined; } };
const MINUTES = Number(arg('minutes', fileArg('minutes') ?? '30'));
const LABEL = arg('label', fileArg('label') ?? 'soak');
const OUT = resolve('soak-out');
const PORT = 9372, INSPECT = 9373, HOST_INSPECT = 9374;
const SWITCH_MS = 3000, DISMISS_MS = 20000, SAMPLE_MS = 10000, PROFILE_WINDOW_MS = 5 * 60_000, SNAPSHOT_RSS_MB = 1024;
// The PAGE's heap snapshot (Tynn #665): once, the first time the renderer's heap passes this, read by heap-retainers.mjs.
const PAGE_SNAPSHOT_MB = Number(arg('page-snapshot-mb', fileArg('page-snapshot-mb') ?? '1200'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const demand = (ok, reason) => { if (!ok) throw new Error(reason); };
const targets = async (port) => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
async function until(label, read, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await read().catch(() => null); if (v) return v; await sleep(200); } throw new Error(`${label} was not ready`); }
const mainWindow = (list) => (Array.isArray(list) ? list : []).find((t) => t?.type === 'page' && t.webSocketDebuggerUrl && /\/index\.html(?:[?#]|$)/.test(String(t.url)) && !/#genie:\/\/(?:[^/?#]+\/)?(?:takeover|flow|files)\//.test(String(t.url))) ?? null;
const mb = (b) => Math.round((b / 1048576) * 10) / 10;

/**
 * THE PAGE'S REACT QUEUES (Tynn #665), read from the fiber tree each sample: per state hook, the updates React holds that
 * are not committed yet (its pending ring and its base queue), the most any one hook holds, and the most an ESTATE hook
 * (a state whose value has `agents` and `workspaces`) holds; with the root's pending and expired lanes. A pushed update
 * that never commits is retained here with whatever its updater closes over.
 */
const PAGE_REACT = `(() => {
    const el = document.getElementById('root'); if (!el) return null;
    const key = Object.keys(el).find((k) => k.startsWith('__reactContainer$')); if (!key) return null;
    const fr = el[key].stateNode;
    const ring = (last) => { if (!last) return 0; let n = 0; let u = last.next; do { n += 1; u = u.next; } while (u && u !== last.next && n < 1e6); return n; };
    const bits = (x) => { let n = 0; for (let v = x >>> 0; v; v &= v - 1) n += 1; return n; };
    let fibers = 0, hooks = 0, queued = 0, maxQueued = 0, estateHooks = 0, estateQueued = 0;
    const stack = [fr.current];
    while (stack.length) {
        const f = stack.pop(); fibers += 1;
        if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling);
        if (f.tag !== 0 && f.tag !== 11 && f.tag !== 15) continue;
        for (let h = f.memoizedState; h && typeof h === 'object' && 'next' in h; h = h.next) {
            if (!h.queue || typeof h.queue.lastRenderedReducer !== 'function') continue;
            hooks += 1;
            const q = ring(h.queue.pending) + ring(h.baseQueue);
            queued += q; if (q > maxQueued) maxQueued = q;
            const v = h.memoizedState;
            if (v && typeof v === 'object' && 'agents' in v && 'workspaces' in v) { estateHooks += 1; estateQueued += q; }
        }
    }
    return { fibers, hooks, queued, maxQueued, estateHooks, estateQueued, pendingLanes: bits(fr.pendingLanes), expiredLanes: bits(fr.expiredLanes) };
})()`;

class Cdp {
    next = 0; pending = new Map(); listeners = new Map(); dead = null;
    on(method, fn) { this.listeners.set(method, fn); return () => this.listeners.delete(method); }
    static async connect(url, label) {
        const c = new Cdp(); c.label = label; c.socket = new WebSocket(url); let timer;
        c.socket.addEventListener('message', (event) => { const frame = JSON.parse(event.data); if (frame.method === 'Debugger.paused') c.paused = frame.params; if (frame.method) c.listeners.get(frame.method)?.(frame.params); const done = c.pending.get(frame.id); if (typeof done === 'function') { c.pending.delete(frame.id); done(frame); } });
        c.socket.addEventListener('close', () => { c.dead ??= `${label}: CDP closed`; for (const done of c.pending.values()) done({ error: { message: c.dead } }); c.pending.clear(); });
        try { await Promise.race([new Promise((ok, no) => { c.socket.addEventListener('open', ok, { once: true }); c.socket.addEventListener('error', no, { once: true }); }), new Promise((_, no) => { timer = setTimeout(() => no(new Error('CDP connect timed out')), 10000); })]); }
        finally { clearTimeout(timer); }
        return c;
    }
    request(method, params = {}, ms = 120000) {
        if (this.dead) return Promise.reject(new Error(this.dead));
        const id = ++this.next;
        return new Promise((ok, no) => {
            const timer = setTimeout(() => { this.pending.delete(id); no(new Error(`${this.label} ${method} timed out`)); }, ms);
            this.pending.set(id, (f) => { clearTimeout(timer); if (f.error) no(new Error(`${this.label} ${method}: ${f.error.message}`)); else ok(f.result); });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }
    async evaluate(expression, ms) {
        const r = await this.request('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, ms);
        if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'exception');
        return r.result.value;
    }
    close() { try { this.socket.close(); } catch { /* gone */ } }
}

/**
 * THE WIRE GAUGE, installed in a process (window main or genie-host): every string or Buffer `data` a socket emits that
 * carries the engine protocol (`{"kind":`), per socket: chunk sizes, line lengths, and the characters a reader that
 * re-joins its whole pending buffer on each chunk (`buffer += chunk; buffer.indexOf('\n')`) copies to find the next
 * newline. The model: a chunk arriving while `acc` characters wait copies `acc + chunk`.
 */
function installWireGauge() {
    if (globalThis.__soakWire) return true;
    const net = process.getBuiltinModule('node:net');
    const g = { chunks: 0, chunkChars: 0, maxChunk: 0, lines: 0, maxLine: 0, linesOver1MB: 0, rejoinCopiedChars: 0, sockets: 0 };
    globalThis.__soakWire = g;
    const state = new WeakMap();
    const orig = net.Socket.prototype.emit;
    net.Socket.prototype.emit = function (event, chunk, ...rest) {
        try {
            if (event === 'data' && chunk != null) {
                let s = state.get(this);
                const len = chunk.length;
                if (!s) {
                    const head = typeof chunk === 'string' ? chunk.slice(0, 64) : chunk.toString('latin1', 0, Math.min(64, len));
                    if (head.includes('{"kind":')) { s = { acc: 0 }; state.set(this, s); g.sockets += 1; }
                }
                if (s) {
                    g.chunks += 1; g.chunkChars += len; if (len > g.maxChunk) g.maxChunk = len;
                    if (s.acc > 0) g.rejoinCopiedChars += s.acc + len;
                    let from = 0;
                    for (let nl = chunk.indexOf(typeof chunk === 'string' ? '\n' : 0x0a); nl !== -1; nl = chunk.indexOf(typeof chunk === 'string' ? '\n' : 0x0a, from)) {
                        const line = s.acc + (nl - from);
                        g.lines += 1; if (line > g.maxLine) g.maxLine = line; if (line > 1048576) g.linesOver1MB += 1;
                        s.acc = 0; from = nl + 1;
                    }
                    s.acc += len - from;
                }
            }
        } catch { /* the gauge never costs the read */ }
        return orig.call(this, event, chunk, ...rest);
    };
    return true;
}

const MEMORY = `(() => { const m = process.memoryUsage(); const h = process.getBuiltinModule('node:v8').getHeapStatistics(); const w = globalThis.__soakWire ?? null; return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers, heapLimit: h.heap_size_limit, mallocedMemory: h.malloced_memory, wire: w ? { ...w } : null }; })()`;

/** A sampling profile's allocations by function (self size, collected objects included), the top `n`. */
function topAllocators(profile, n = 30) {
    const by = new Map();
    let total = 0;
    const walk = (node, stack) => {
        const f = node.callFrame;
        const key = `${f.functionName || '(anonymous)'} ${f.url ? basename(f.url) : '(native)'}:${f.lineNumber + 1}`;
        if (node.selfSize > 0) {
            total += node.selfSize;
            const e = by.get(key) ?? { self: 0, via: new Map() };
            e.self += node.selfSize;
            const parent = stack.slice(-3).join(' < ');
            e.via.set(parent, (e.via.get(parent) ?? 0) + node.selfSize);
            by.set(key, e);
        }
        for (const c of node.children ?? []) walk(c, [...stack, `${f.functionName || '(anon)'}:${f.lineNumber + 1}`]);
    };
    walk(profile.head, []);
    return { totalMb: mb(total), top: [...by.entries()].sort((a, b) => b[1].self - a[1].self).slice(0, n).map(([fn, e]) => ({ fn, mb: mb(e.self), via: [...e.via.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([s, v]) => `${mb(v)} MB: ${s}`) })) };
}

/** A heap snapshot streamed to a file, whole. */
async function writeSnapshot(cdp, file) {
    const out = createWriteStream(file);
    const stop = cdp.on('HeapProfiler.addHeapSnapshotChunk', (p) => out.write(p.chunk));
    try { await cdp.request('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false }, 900000); }
    finally { stop(); await new Promise((r) => out.end(r)); }
}

/** A heap snapshot to a file, and its retained summary by constructor (self size). */
async function snapshot(cdp, file) {
    const out = createWriteStream(file);
    const stop = cdp.on('HeapProfiler.addHeapSnapshotChunk', (p) => out.write(p.chunk));
    try { await cdp.request('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false }, 600000); }
    finally { stop(); await new Promise((r) => out.end(r)); }
    const size = statSync(file).size;
    // Past a few hundred MB one JSON.parse is past V8's string limit: the file is kept, unsummarised.
    if (size > 400 * 1048576) { rmSync(file, { force: true }); return { file: basename(file), fileMb: mb(size), top: null }; }
    const snap = JSON.parse(readFileSync(file, 'utf8'));
    rmSync(file, { force: true });
    const f = snap.snapshot.meta.node_fields, types = snap.snapshot.meta.node_types[0], width = f.length;
    const iType = f.indexOf('type'), iName = f.indexOf('name'), iSelf = f.indexOf('self_size');
    const by = new Map();
    let total = 0;
    for (let i = 0; i < snap.nodes.length; i += width) {
        const t = types[snap.nodes[i + iType]], self = snap.nodes[i + iSelf];
        total += self;
        const key = t === 'object' || t === 'closure' ? `${t}:${snap.strings[snap.nodes[i + iName]]}` : t;
        by.set(key, (by.get(key) ?? 0) + self);
    }
    return { file: basename(file), totalMb: mb(total), top: [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k} ${mb(v)} MB`) };
}

let app = null, root = null, page = null, main = null, host = null, code = 1, pageAnalysis = null;
const summary = { label: LABEL, minutes: MINUTES, head: null, seeded: null, switches: 0, dismissals: 0, dismissFailures: 0, errors: [], pageErrors: [], failedSurfaces: null, died: null, snapshots: [], profiles: { main: [], host: [] } };
const samplesFile = join(OUT, `${LABEL}-samples.jsonl`);
try {
    demand(process.env.CI === 'true' || process.env.GENIE_SOAK_ALLOW === '1' || (WIN && /^genie$/i.test(process.env.USERNAME ?? '')) || (process.platform === 'linux' && process.env.USER === 'genie'), 'refused: run only in CI or a test VM');
    demand(existsSync('dist/main/entry.js'), 'run from a built checkout');
    for (const port of [PORT, INSPECT, HOST_INSPECT]) { let used = false; try { await targets(port); used = true; } catch (e) { if (e.name === 'TimeoutError') used = true; } demand(!used, `port ${port} in use; nothing touched`); }
    try { summary.head = readFileSync('.soak-head', 'utf8').trim(); } catch { try { summary.head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim(); } catch { /* no git in the shipped tree */ } }
    mkdirSync(OUT, { recursive: true });
    rmSync(samplesFile, { force: true });
    root = mkdtempSync(join(tmpdir(), 'genie-soak-'));
    const home = join(root, 'home');
    const seeded = await seedSoak({ home, workspace: join(root, 'workspace') });
    summary.seeded = { agents: seeded.agents.length, busy: seeded.busy.length, bytesMb: Object.fromEntries(Object.entries(seeded.bytes).map(([k, v]) => [k, mb(v)])) };
    console.log(`SOAK_SEEDED ${JSON.stringify(summary.seeded)}`);
    // The busy stub works for the whole soak (it reads its duration from a file beside it: a provider gets a filtered env).
    writeFileSync(resolve('scripts/perf-lag/.busy-ms'), String((MINUTES + 10) * 60_000));
    const env = { ...process.env, HOME: home, USERPROFILE: home, GENIE_HOME: join(home, '.genie'), GENIE_PAGE_PROBE: '1', GENIE_UI_LAG_MEASURE: '1', GENIE2_CODEX_BINARY: resolve('scripts/perf-lag/stub-codex-busy.mjs') };
    const log = openSync(join(OUT, `${LABEL}-electron.log`), 'w');
    const electron = resolve('node_modules/electron', WIN ? 'dist/electron.exe' : 'dist/electron');
    const args = ['.', `--remote-debugging-port=${PORT}`, `--inspect-brk=${INSPECT}`, `--user-data-dir=${join(root, 'profile')}`];
    if (!WIN) args.push('--no-sandbox');
    if (process.platform === 'linux' && ['wayland', 'x11'].includes(process.env.XDG_SESSION_TYPE)) args.push(`--ozone-platform=${process.env.XDG_SESSION_TYPE}`);
    app = spawn(electron, args, { env, windowsHide: true, detached: !WIN, stdio: ['ignore', log, log] }); closeSync(log);
    main = await Cdp.connect((await until('paused main inspector', async () => (await targets(INSPECT))[0])).webSocketDebuggerUrl, 'main');
    await main.request('Debugger.enable'); await main.request('Runtime.runIfWaitingForDebugger');
    const paused = await until('entry pause', async () => main.paused);
    const hostOptions = { home: join(home, '.genie'), entry: resolve('dist/main/host.js'), inspectPort: HOST_INSPECT };
    const installed = await main.request('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId, returnByValue: true, expression: `globalThis.__soakHostLaunch=(${installUiLagHostLaunch.toString()})(Object.assign(${JSON.stringify(hostOptions)},{execPath:process.execPath}));true` });
    if (installed.exceptionDetails) throw new Error(installed.exceptionDetails.exception?.description ?? 'host hook failed');
    await main.request('Debugger.resume'); await main.request('Debugger.disable');
    const target = await until('the main window', async () => mainWindow(await targets(PORT)), 240000);
    page = await Cdp.connect(target.webSocketDebuggerUrl, 'page');
    // THE PAGE'S OWN ERRORS: a render that failed (an error boundary drew "failed to draw") is a soak that measured less.
    const pageError = (kind, text) => { if (summary.pageErrors.length < 10) summary.pageErrors.push({ t: new Date().toISOString(), kind, text: String(text).slice(0, 6000) }); };
    page.on('Runtime.exceptionThrown', (p) => pageError('exception', p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? ''));
    page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') pageError('console.error', (p.args ?? []).map((a) => String(a.description ?? a.value ?? '')).join(' | ')); });
    await page.request('Runtime.enable');
    await until('the page bridge', () => page.evaluate('typeof window.genieTest === "object"'), 60000);
    host = await Cdp.connect((await until('genie-host inspector', async () => (await targets(HOST_INSPECT))[0], 60000)).webSocketDebuggerUrl, 'host');
    // What's new over a first run: closed as a person closes it.
    try { await until('What’s new', () => page.evaluate(`Boolean(document.querySelector('[data-whats-new]'))`), 20000); await page.evaluate(`document.querySelector('[data-action="whats-new-close"]')?.click(); true`); } catch { /* not shown */ }
    for (const c of [main, host]) { await c.evaluate(`(${installWireGauge.toString()})()`); await c.request('HeapProfiler.enable'); }
    await page.request('HeapProfiler.enable');
    const startProfiles = async () => { for (const c of [main, host]) if (!c.dead) await c.request('HeapProfiler.startSampling', { samplingInterval: 65536, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true }).catch((e) => summary.errors.push(e.message)); };
    let profileN = 0;
    const saveProfiles = async () => {
        profileN += 1;
        for (const [name, c] of [['main', main], ['host', host]]) {
            if (c.dead) continue;
            try {
                const { profile } = await c.request('HeapProfiler.stopSampling', {}, 300000);
                writeFileSync(join(OUT, `${LABEL}-profile-${name}-${profileN}.heapprofile`), JSON.stringify(profile));
                summary.profiles[name].push({ window: profileN, ...topAllocators(profile, 15) });
            } catch (e) { summary.errors.push(e.message); }
        }
    };
    await startProfiles();
    const t0 = Date.now(), end = t0 + MINUTES * 60_000;
    let nextSample = t0, nextSwitch = t0, nextDismiss = t0 + 10_000, nextProfile = t0 + PROFILE_WINDOW_MS, i = 0;
    const snapped = new Set();
    let pageSnapped = false, pageUsedMb = 0;
    console.log(`SOAK_START ${new Date(t0).toISOString()} for ${MINUTES} min`);
    while (Date.now() < end) {
        if (main.dead) { summary.died = { at: new Date().toISOString(), after_s: Math.round((Date.now() - t0) / 1000), what: main.dead }; break; }
        const now = Date.now();
        if (now >= nextSample) {
            nextSample += SAMPLE_MS;
            const read = async (c) => (c.dead ? null : c.evaluate(MEMORY, 20000).catch((e) => ({ error: e.message })));
            const [m, h] = await Promise.all([read(main), read(host)]);
            const p = page.dead ? null : await page.request('Runtime.getHeapUsage', {}, 20000).catch(() => null);
            const react = page.dead ? null : await page.evaluate(PAGE_REACT, 20000).catch((e) => ({ error: e.message }));
            const s = { t: Math.round((Date.now() - t0) / 1000), main: m, host: h, page: p ? { used: p.usedSize, total: p.totalSize, react } : null };
            if (p) pageUsedMb = mb(p.usedSize);
            writeFileSync(samplesFile, `${JSON.stringify(s)}\n`, { flag: 'a' });
            // A surface that failed to draw (react-fancy's TabsList update loop, React #185, seen on the line too) is retried as a
            // person would, so the soak keeps measuring a page that draws; each one is counted.
            if (!page.dead) {
                const failed = await page.evaluate(`[...document.querySelectorAll('[data-surface-failed]')].map((e) => e.getAttribute('data-surface-failed'))`, 10000).catch(() => []);
                if (failed.length > 0) {
                    summary.failedSurfaces ??= { t: s.t, surfaces: failed };
                    summary.surfaceRetries = (summary.surfaceRetries ?? 0) + 1;
                    await page.evaluate(`document.querySelectorAll('[data-surface-retry]').forEach((b) => b.click()); true`, 10000).catch(() => {});
                }
            }
            console.log(`SOAK_SAMPLE t=${s.t}s main rss=${m?.rss ? mb(m.rss) : '-'} heap=${m?.heapUsed ? mb(m.heapUsed) : '-'} host rss=${h?.rss ? mb(h.rss) : '-'} heap=${h?.heapUsed ? mb(h.heapUsed) : '-'} page=${p ? mb(p.usedSize) : '-'} react=${react ? JSON.stringify(react) : '-'} wire.maxLine=${m?.wire?.maxLine ?? '-'}`);
            for (const [name, c, r] of [['main', main, m], ['host', host, h]]) {
                if (snapped.has(name) || !r?.rss || r.rss / 1048576 < SNAPSHOT_RSS_MB) continue;
                snapped.add(name);
                try { summary.snapshots.push({ proc: name, t: s.t, rssMb: mb(r.rss), ...(await snapshot(c, join(OUT, `${LABEL}-${name}-peak.heapsnapshot`))) }); } catch (e) { summary.errors.push(`snapshot ${name}: ${e.message}`); }
            }
        }
        if (!pageSnapped && !page.dead && pageUsedMb >= PAGE_SNAPSHOT_MB) {
            pageSnapped = true;
            const file = join(OUT, `${LABEL}-page-peak.heapsnapshot`);
            try {
                const at = Math.round((Date.now() - t0) / 1000), usedMb = pageUsedMb, react = await page.evaluate(PAGE_REACT, 20000).catch(() => null);
                await writeSnapshot(page, file);
                console.log(`SOAK_PAGE_SNAPSHOT t=${at}s used=${usedMb} MB file=${mb(statSync(file).size)} MB`);
                // Read off the soak's loop (it can take minutes): a child node, the file deleted after.
                pageAnalysis = new Promise((done) => {
                    const child = spawn(process.execPath, ['--max-old-space-size=24000', resolve('scripts/perf-lag/heap-retainers.mjs'), file, join(OUT, `${LABEL}-page-retainers.json`)], { stdio: ['ignore', 'ignore', 'pipe'] });
                    let err = '';
                    child.stderr.on('data', (d) => { err += d; });
                    child.on('exit', (exit) => { rmSync(file, { force: true }); summary.pageSnapshot = { t: at, usedMb, react, exit, err: err.slice(-2000) || undefined }; done(); });
                });
            } catch (e) { summary.errors.push(`page snapshot: ${e.message}`); rmSync(file, { force: true }); }
        }
        if (now >= nextProfile) { nextProfile += PROFILE_WINDOW_MS; await saveProfiles(); await startProfiles(); }
        if (now >= nextDismiss) {
            nextDismiss += DISMISS_MS;
            try {
                await page.evaluate(`window.location.hash = '#genie://deck'; true`);
                const ok = await until('a question on the Deck', () => page.evaluate(`(() => { const b = document.querySelector('[data-deck-dismiss]'); if (!b) return false; b.click(); return true; })()`), 15000);
                if (ok) summary.dismissals += 1;
            } catch (e) { summary.dismissFailures += 1; if (summary.dismissFailures <= 3) summary.errors.push(`dismiss: ${e.message}`); }
        }
        if (now >= nextSwitch) {
            nextSwitch += SWITCH_MS;
            const a = seeded.agents[i % seeded.agents.length];
            const route = i % 2 === 0 ? `genie://agent/${a.id}?tab=stream` : `genie://workspace/soak?chat=${a.id}`;
            i += 1;
            try { await page.evaluate(`window.location.hash = ${JSON.stringify(`#${route}`)}; true`, 20000); summary.switches += 1; } catch (e) { summary.errors.push(`switch: ${e.message}`); }
        }
        await sleep(250);
    }
    if (!main.dead) await saveProfiles();
    if (pageAnalysis) await pageAnalysis;
    // The end state, after a full GC: what each process RETAINS (not what it churned).
    for (const [name, c] of [['main', main], ['host', host]]) {
        if (c.dead) continue;
        try { await c.request('HeapProfiler.collectGarbage', {}, 120000); summary[`${name}AfterGc`] = await c.evaluate(MEMORY, 20000); } catch (e) { summary.errors.push(e.message); }
    }
    code = summary.died ? 2 : 0;
} catch (error) {
    summary.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
    code = 1;
} finally {
    // The curves, as numbers: per process, rss and heap at min / median / p95 / max.
    try {
        const rows = existsSync(samplesFile) ? readFileSync(samplesFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
        const stat = (xs) => { const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); if (v.length === 0) return null; const q = (p) => mb(v[Math.min(v.length - 1, Math.floor(p * v.length))]); return { min: mb(v[0]), p50: q(0.5), p95: q(0.95), max: mb(v.at(-1)), n: v.length }; };
        for (const name of ['main', 'host']) summary[name] = { rss: stat(rows.map((r) => r[name]?.rss)), heapUsed: stat(rows.map((r) => r[name]?.heapUsed)), external: stat(rows.map((r) => r[name]?.external)), wire: rows.at(-1)?.[name]?.wire ?? null };
        const counts = (xs) => { const v = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return v.length === 0 ? null : { p50: v[Math.floor(v.length / 2)], max: v.at(-1), n: v.length }; };
        summary.page = { heapUsed: stat(rows.map((r) => r.page?.used)), estateQueued: counts(rows.map((r) => r.page?.react?.estateQueued)), maxQueued: counts(rows.map((r) => r.page?.react?.maxQueued)), pendingLanes: counts(rows.map((r) => r.page?.react?.pendingLanes)) };
        // Ten points of the curve: rss of each process every tenth of the run.
        summary.curve = rows.filter((_, k) => k % Math.max(1, Math.floor(rows.length / 12)) === 0).map((r) => ({ t: r.t, main: r.main?.rss ? mb(r.main.rss) : null, host: r.host?.rss ? mb(r.host.rss) : null, page: r.page ? mb(r.page.used) : null }));
    } catch (e) { summary.errors.push(`summary: ${e.message}`); }
    try { if (root) { const crash = join(root, 'home', '.genie', 'runtime', 'crash'); summary.crashRecords = existsSync(crash) ? readdirSync(crash) : []; } } catch { /* none */ }
    try { if (root) { const life = join(root, 'home', '.genie', 'runtime', 'lifecycle.log'); if (existsSync(life)) writeFileSync(join(OUT, `${LABEL}-lifecycle.log`), readFileSync(life)); } } catch { /* none */ }
    writeFileSync(join(OUT, `${LABEL}-summary.json`), JSON.stringify(summary, null, 2));
    console.log(`SOAK_RESULT ${JSON.stringify({ label: LABEL, head: summary.head, died: summary.died, failedSurfaces: summary.failedSurfaces, surfaceRetries: summary.surfaceRetries ?? 0, pageErrors: summary.pageErrors.length, switches: summary.switches, dismissals: summary.dismissals, main: summary.main, host: summary.host, page: summary.page })}`);
    try { await main?.evaluate("process.getBuiltinModule('node:module').createRequire(process.execPath)('electron').app.quit();true", 5000); } catch { /* gone */ }
    for (const c of [page, main, host]) c?.close();
    await sleep(5000);
    if (app?.pid) { try { if (WIN) execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(-app.pid, 'SIGKILL'); } catch { /* gone */ } }
    // genie-host outlives its window by design: ended by its pid file in the soak's own home.
    try { const rec = JSON.parse(readFileSync(join(root, 'home', '.genie', 'runtime', 'host.json'), 'utf8')); if (rec?.pid) { if (WIN) execFileSync('taskkill', ['/PID', String(rec.pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(rec.pid, 'SIGKILL'); } } catch { /* gone */ }
    try { rmSync(resolve('scripts/perf-lag/.busy-ms'), { force: true }); } catch { /* none */ }
    process.exit(code);
}
