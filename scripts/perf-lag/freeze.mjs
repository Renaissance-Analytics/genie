#!/usr/bin/env node
/**
 * THE PERIODIC FREEZES, MEASURED BY VIEW (beta.53; the owner, 2026-10-31: "periodic whole UI freezes where my typing stops
 * and I get a msg asking me to quit genie" … "the UI lag I get is only when I am in a workspace"). Run against a Genie
 * launched with `--inspect=9229 --remote-debugging-port=9222` after `seed.mjs` + `seed-extra.mjs`:
 *
 *   node scripts/perf-lag/freeze.mjs <label> [phaseSeconds=90] [phases=dashboard,workspace,dashboard,workspace]
 *
 * Under the same load (eleven agents streaming, the owner's attention and mail stores, an app posting into an agent's
 * AgentInbox every 15 s) it alternates the open VIEW — the Dashboard, then the workspace's page — with the chat open on
 * the agent with the longest thread, typing into its composer every 250 ms, and per phase records:
 *
 *  - MAIN's event loop: `perf_hooks.monitorEventLoopDelay` (p99, max) and every stall over 50 ms from a 10 ms interval;
 *  - the RENDERER's long tasks (PerformanceObserver `longtask`);
 *  - keystroke → paint;
 *  - CPU profiles of both, and every BUSY RUN over 200 ms found in them — consecutive samples that are not idle — with the
 *    heaviest stack inside it. A stall is named by its stack, not guessed at.
 *
 * Writes <label>-freeze.json; prints the summary.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const label = process.argv[2] ?? 'run';
const PHASE_S = Number(process.argv[3] ?? 90);
const PHASES = (process.argv[4] ?? 'dashboard,workspace,dashboard,workspace').split(',');
const launchedAt = Number(process.env.LAUNCHED_AT_MS ?? Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const since = (t) => Math.round(t - launchedAt);
const agents = JSON.parse(readFileSync(join(homedir(), 'lag-agents.json'), 'utf8'));
const subject = agents[0];
const WORKSPACE = 'lag';
const COMPOSER = '[data-chat-composer] :is([contenteditable="true"][role="textbox"], textarea:not([disabled]))';

class Cdp {
    #ws; #id = 1; #pending = new Map();
    static async connect(url) {
        const c = new Cdp();
        c.#ws = new WebSocket(url);
        c.#ws.addEventListener('message', (e) => {
            const f = JSON.parse(e.data);
            if (typeof f?.id !== 'number' || !c.#pending.has(f.id)) return;
            const resolve = c.#pending.get(f.id);
            c.#pending.delete(f.id);
            resolve(f);
        });
        await new Promise((res, rej) => { c.#ws.addEventListener('open', res, { once: true }); c.#ws.addEventListener('error', () => rej(new Error('cdp socket')), { once: true }); });
        return c;
    }
    /** Two minutes at most per call: a target that never answers (a held thread) fails the call instead of the run. */
    send(method, params = {}) {
        const id = this.#id++;
        return new Promise((r, rej) => {
            const timer = setTimeout(() => { this.#pending.delete(id); rej(new Error(`cdp ${method} timed out`)); }, 120_000);
            this.#pending.set(id, (f) => { clearTimeout(timer); r(f); });
            this.#ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async eval(expression, awaitPromise = false) {
        const f = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
        if (f.result?.exceptionDetails) throw new Error(JSON.stringify(f.result.exceptionDetails).slice(0, 400));
        return f.result?.result?.value;
    }
    /** A FIXED function called in the page with data as arguments — never code built from data. */
    async call(fn, args = [], awaitPromise = false) {
        this.global ??= (await this.send('Runtime.evaluate', { expression: 'globalThis' })).result.result.objectId;
        const f = await this.send('Runtime.callFunctionOn', { functionDeclaration: fn.toString(), objectId: this.global, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise });
        if (f.result?.exceptionDetails) throw new Error(JSON.stringify(f.result.exceptionDetails).slice(0, 400));
        return f.result?.result?.value;
    }
    close() { this.#ws.close(); }
}

async function target(port, pick) {
    // Ten minutes at most: a target list that does not answer (main held) is waited for, then said.
    for (const until = Date.now() + 600_000; Date.now() < until;) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
            const t = list.find(pick);
            if (t) return t.webSocketDebuggerUrl;
        } catch { /* not up yet */ }
        await sleep(100);
    }
    throw new Error(`no target on ${port}`);
}

/**
 * Where profile time 0 is on the wall clock: a function of a known name spins 40 ms at a known Date.now(); its first
 * sample is that moment. (A CPU profile's clock is monotonic and has its own origin.)
 */
const ALIGN = `(() => { const at = Date.now(); (function genieFreezeAlign() { const end = Date.now() + 40; while (Date.now() < end) { /* spin */ } })(); return at; })()`;

const main = await Cdp.connect(await target(9229, (t) => t.webSocketDebuggerUrl));
await main.send('Profiler.enable');
await main.send('Profiler.setSamplingInterval', { interval: 1000 });
await main.send('Profiler.start');
const mainAlignAt = await main.eval(ALIGN);
await main.eval(`(() => {
    const { monitorEventLoopDelay } = process.getBuiltinModule('node:perf_hooks');
    globalThis.__fz = { lag: [], h: monitorEventLoopDelay({ resolution: 10 }) };
    globalThis.__fz.h.enable();
    let last = Date.now();
    setInterval(() => { const n = Date.now(); if (n - last > 60) globalThis.__fz.lag.push([n, n - last - 10]); last = n; }, 10);
    return true;
})()`);
console.log(`main attached at +${since(Date.now())} ms`);

const page = await Cdp.connect(await target(9222, (t) => t.type === 'page' && t.webSocketDebuggerUrl && /index\.html/.test(t.url)));
await page.send('Profiler.enable');
await page.send('Profiler.setSamplingInterval', { interval: 1000 });
await page.send('Profiler.start');
const pageAlignAt = await page.eval(ALIGN);
await page.eval(`(() => { window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([performance.timeOrigin + e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); return true; })()`);
console.log(`renderer attached at +${since(Date.now())} ms`);

const routeFor = (phase) => (phase === 'workspace' ? `#genie://workspace/${WORKSPACE}?chat=${subject.id}` : `#genie://dashboard?group=workspace&chat=${subject.id}`);
async function openPhase(phase) {
    for (let i = 0; i < 600; i += 1) {
        try {
            const ok = await page.call(function go(hash, composer, phase) {
                if (location.hash !== hash) location.hash = hash;
                const onView = phase === 'workspace' ? Boolean(document.querySelector('[data-workspace-body]')) : !document.querySelector('[data-workspace-body]');
                return onView && Boolean(document.querySelector(composer));
            }, [routeFor(phase), COMPOSER, phase]);
            if (ok) return since(Date.now());
        } catch { /* navigating */ }
        await sleep(100);
    }
    return null;
}

// The boot settles first: the chat composer on the Dashboard.
const composerAt = await openPhase('dashboard');
console.log(`composer ready at +${composerAt} ms`);
await sleep(30_000);

// AN APP REPORTING TO AN AGENT (genie#1345): a script key of the workspace, posting into an agent's AgentInbox every 15 s.
let appKey = null;
try {
    const made = await page.call(function key(ws) { return window.genie.appInbox.createKey(ws, 'perf'); }, [WORKSPACE], true);
    if (made?.ok) appKey = made.token;
    else console.log(`no app key: ${JSON.stringify(made)}`);
} catch (error) { console.log(`no app key: ${error.message}`); }
// A BUSY TERMINAL IN THE WORKSPACE (a build log, a TUI redrawing): 2 KB every 50 ms, open through both views alike.
let terminal = null;
try {
    terminal = await page.call(async function openTerm(ws) {
        const t = await window.genie.terminals.open(ws, { cols: 120, rows: 30 });
        setTimeout(() => window.genie.terminals.write(t.id, `node -e "setInterval(()=>process.stdout.write('x'.repeat(2000)+'\\n'),50)"\r`), 3000);
        return t.id;
    }, [WORKSPACE], true);
    console.log(`busy terminal ${terminal}`);
} catch (error) { console.log(`no terminal: ${error.message}`); }
const appEndpoint = (() => { try { return JSON.parse(readFileSync(join(homedir(), '.genie', 'app-inbox-endpoint.json'), 'utf8')).url; } catch { return null; } })();
const posts = [];
let posted = 0;
async function postApp() {
    if (!appKey || !appEndpoint) return;
    const to = agents[(posted += 1) % agents.length].name;
    const t0 = Date.now();
    try {
        const r = await fetch(`${appEndpoint.replace(/\/$/, '')}/v1/inbox`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${appKey}` }, body: JSON.stringify({ to, subject: `Build ${posted} finished`, body: 'The nightly build finished; 3 suites ran, all green. '.repeat(20) }) });
        posts.push([since(t0), r.status, Date.now() - t0]);
    } catch (error) { posts.push([since(t0), String(error.message), Date.now() - t0]); }
}

const phases = [];
const keys = [];
let typed = 0;
for (const phase of PHASES) {
    const ready = await openPhase(phase);
    await main.eval('(globalThis.__fz.h.reset(), true)');
    const from = Date.now();
    const until = from + PHASE_S * 1000;
    let nextPost = from + 5_000;
    while (Date.now() < until) {
        if (Date.now() >= nextPost) { void postApp(); nextPost += 15_000; }
        await page.call(function focus(composer) { document.querySelector(composer)?.focus(); return true; }, [COMPOSER]).catch(() => undefined);
        const ch = 'abcdefghij'[typed % 10];
        const t0 = Date.now();
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
        let shown = false;
        try {
            shown = await page.call(function painted(composer, typed) {
                return new Promise((r) => requestAnimationFrame(() => { const el = document.querySelector(composer); const v = el ? (el.value ?? el.textContent ?? '') : ''; r(v.endsWith(typed)); }));
            }, [COMPOSER, ch], true);
        } catch { shown = false; }
        keys.push([since(t0), Date.now() - t0, shown, phase]);
        typed += 1;
        if (typed % 40 === 0) {
            await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
            await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
            await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
            await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        }
        await sleep(250);
    }
    const h = JSON.parse(await main.eval('JSON.stringify({ p50: globalThis.__fz.h.percentile(50) / 1e6, p99: globalThis.__fz.h.percentile(99) / 1e6, max: globalThis.__fz.h.max / 1e6, mean: globalThis.__fz.h.mean / 1e6 })'));
    phases.push({ phase, readyAt: ready, from: since(from), to: since(Date.now()), loopDelayMs: Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Math.round(v)])) });
}

const lag = (await main.eval('globalThis.__fz.lag')).map(([t, d]) => [since(t), d]);
const long = (await page.eval('window.__long')).map(([t, d]) => [since(t), Math.round(d)]);
const mainProfile = (await main.send('Profiler.stop')).result.profile;
const pageProfile = (await page.send('Profiler.stop')).result.profile;
writeFileSync(`${label}-main.cpuprofile`, JSON.stringify(mainProfile));
writeFileSync(`${label}-renderer.cpuprofile`, JSON.stringify(pageProfile));

/** Every run of consecutive non-idle samples longer than `minMs`, with its heaviest stack and its top self frames. */
function busyRuns(profile, alignAt, minMs = 200) {
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const name = (n) => n.callFrame.functionName || '(anonymous)';
    const where = (n) => { const f = n.callFrame; return `${name(n)} ${f.url ? f.url.split(/[\\/]/).slice(-2).join('/') : ''}:${f.lineNumber + 1}`; };
    const idle = (n) => { const x = name(n); return x === '(idle)' || x === '(program)' || x === '(root)'; };
    // Sample times, µs from profile start.
    const times = [];
    let t = 0;
    for (let i = 0; i < profile.samples.length; i += 1) { t += profile.timeDeltas[i] ?? 0; times.push(t); }
    const alignSample = profile.samples.findIndex((id) => { let n = byId.get(id); while (n) { if (name(n) === 'genieFreezeAlign') return true; n = byId.get(parent.get(n.id)); } return false; });
    const wallOf = (us) => (alignSample === -1 ? null : since(alignAt + (us - times[alignSample]) / 1000));
    const runs = [];
    let start = -1;
    const close = (end) => {
        const ms = (times[end] - times[start]) / 1000;
        if (ms >= minMs) {
            const count = new Map();
            const self = new Map();
            for (let i = start; i <= end; i += 1) {
                const id = profile.samples[i];
                count.set(id, (count.get(id) ?? 0) + 1);
                const w = where(byId.get(id));
                self.set(w, (self.get(w) ?? 0) + 1);
            }
            const heaviest = [...count].sort((a, b) => b[1] - a[1])[0][0];
            const stack = [];
            for (let n = byId.get(heaviest); n && name(n) !== '(root)'; n = byId.get(parent.get(n.id))) stack.push(where(n));
            // Inclusive: the frames most of the run was under (the call path, not only the leaf).
            const incl = new Map();
            for (let i = start; i <= end; i += 1) {
                const seen = new Set();
                for (let n = byId.get(profile.samples[i]); n && name(n) !== '(root)'; n = byId.get(parent.get(n.id))) { const w = where(n); if (!seen.has(w)) { seen.add(w); incl.set(w, (incl.get(w) ?? 0) + 1); } }
            }
            const n = end - start + 1;
            runs.push({
                at: wallOf(times[start]), ms: Math.round(ms),
                self: [...self].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w, c]) => `${Math.round((100 * c) / n)}% ${w}`),
                inclusive: [...incl].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([w, c]) => `${Math.round((100 * c) / n)}% ${w}`),
                heaviestStack: stack.slice(0, 22),
            });
        }
        start = -1;
    };
    for (let i = 0; i < profile.samples.length; i += 1) {
        const busy = !idle(byId.get(profile.samples[i]));
        if (busy && start === -1) start = i;
        // A run ends at an idle sample; a single idle sample between busy ones (a sampler tick in the pump) ends it too.
        if (!busy && start !== -1) close(i - 1);
    }
    if (start !== -1) close(profile.samples.length - 1);
    return runs;
}
const phaseAt = (t) => phases.find((p) => t >= p.from && t < p.to)?.phase ?? (t < (phases[0]?.from ?? 0) ? 'boot' : 'after');
const mainRuns = busyRuns(mainProfile, mainAlignAt).map((r) => ({ ...r, phase: r.at === null ? '?' : phaseAt(r.at) }));
const pageRuns = busyRuns(pageProfile, pageAlignAt).map((r) => ({ ...r, phase: r.at === null ? '?' : phaseAt(r.at) }));

const q = (v, p) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null);
const perPhase = phases.map((p) => {
    const ks = keys.filter((k) => k[0] >= p.from && k[0] < p.to).map((k) => k[1]).sort((a, b) => a - b);
    const lg = lag.filter(([t]) => t >= p.from && t < p.to).map(([, d]) => d);
    const lt = long.filter(([t]) => t >= p.from && t < p.to).map(([, d]) => d);
    return {
        ...p,
        keys: { n: ks.length, p50: q(ks, 0.5), p95: q(ks, 0.95), p99: q(ks, 0.99), max: ks.at(-1) ?? null, over1000: ks.filter((d) => d > 1000).length },
        mainStalls: { over200: lg.filter((d) => d > 200).length, over1000: lg.filter((d) => d > 1000).length, max: Math.max(0, ...lg), totalMs: lg.reduce((a, b) => a + b, 0) },
        rendererLong: { n: lt.length, over200: lt.filter((d) => d > 200).length, over1000: lt.filter((d) => d > 1000).length, max: Math.max(0, ...lt), totalMs: lt.reduce((a, b) => a + b, 0) },
        mainRunsOver200: mainRuns.filter((r) => r.phase === p.phase && r.at >= p.from && r.at < p.to).length,
        rendererRunsOver200: pageRuns.filter((r) => r.phase === p.phase && r.at >= p.from && r.at < p.to).length,
    };
});
const result = {
    label, composerAt, appPosts: posts, perPhase,
    worstMainStalls: [...lag].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, d]) => [t, d, phaseAt(t)]),
    worstLongTasks: [...long].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, d]) => [t, d, phaseAt(t)]),
    mainRuns: mainRuns.sort((a, b) => b.ms - a.ms).slice(0, 12),
    rendererRuns: pageRuns.sort((a, b) => b.ms - a.ms).slice(0, 12),
};
writeFileSync(`${label}-freeze.json`, JSON.stringify({ ...result, keys, lag, long }));
console.log(`=== FREEZE ${label}`);
console.log(JSON.stringify(result, null, 1));
main.close();
page.close();
process.exit(0);
