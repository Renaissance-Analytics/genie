#!/usr/bin/env node
/**
 * THE RESTART, MEASURED IN THE REAL WINDOW (genie#1340). Run against a Genie launched with `--remote-debugging-port=9222
 * --inspect=9229` right after `seed.mjs`:
 *
 *   node scripts/perf-lag/measure.mjs <label> [seconds=240]
 *
 * From launch to the end it records:
 *  - KEYSTROKE → PAINT in the chat composer of the agent with the longest thread: a real key event through the browser
 *    process (Input.dispatchKeyEvent, the path a keyboard takes), then the next animation frame with the character in
 *    the composer. One every 250 ms, back to back, so a blocked second is a slow sample, not a skipped one;
 *  - MAIN's event loop: every gap over 50 ms in a 10 ms interval running in the main process. Main is the browser UI
 *    thread: a gap there is input that waits;
 *  - the RENDERER's long tasks (PerformanceObserver `longtask`);
 *  - a CPU profile of main and of the renderer, written to <label>-main.cpuprofile / <label>-renderer.cpuprofile and
 *    summarised (top self time).
 * Results: <label>-result.json and a summary on stdout.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const label = process.argv[2] ?? 'run';
const SECONDS = Number(process.argv[3] ?? 240);
const launchedAt = Number(process.env.LAUNCHED_AT_MS ?? Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const since = (t) => t - launchedAt;
const agents = JSON.parse(readFileSync(join(homedir(), 'lag-agents.json'), 'utf8'));
const subject = agents[0];
if (!/^agent_[0-9a-f]{32}$/.test(subject.id)) throw new Error(`not an agent id: ${subject.id}`);
const COMPOSER = '[data-chat-composer] :is([contenteditable="true"][role="textbox"], textarea:not([disabled]))';

class Cdp {
    #ws; #id = 1; #pending = new Map();
    static async connect(url) {
        const c = new Cdp();
        c.#ws = new WebSocket(url);
        c.#ws.addEventListener('message', (e) => {
            const f = JSON.parse(e.data);
            // Only a reply to a request this client sent: a numeric id it holds a resolver for.
            if (typeof f?.id !== 'number' || !c.#pending.has(f.id)) return;
            const resolve = c.#pending.get(f.id);
            c.#pending.delete(f.id);
            if (typeof resolve === 'function') resolve(f);
        });
        await new Promise((res, rej) => { c.#ws.addEventListener('open', res, { once: true }); c.#ws.addEventListener('error', () => rej(new Error('cdp socket')), { once: true }); });
        return c;
    }
    send(method, params = {}) { const id = this.#id++; return new Promise((r) => { this.#pending.set(id, r); this.#ws.send(JSON.stringify({ id, method, params })); }); }
    async eval(expression, awaitPromise = false) {
        const f = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
        if (f.result?.exceptionDetails) throw new Error(JSON.stringify(f.result.exceptionDetails).slice(0, 400));
        return f.result?.result?.value;
    }
    /**
     * Call a FIXED function in the page with data as arguments — never code built from data. Its source is `fn`'s own
     * text; the values travel as CDP call arguments.
     */
    async call(fn, args = [], awaitPromise = false) {
        this.global ??= (await this.send('Runtime.evaluate', { expression: 'globalThis' })).result.result.objectId;
        const f = await this.send('Runtime.callFunctionOn', { functionDeclaration: fn.toString(), objectId: this.global, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise });
        if (f.result?.exceptionDetails) throw new Error(JSON.stringify(f.result.exceptionDetails).slice(0, 400));
        return f.result?.result?.value;
    }
    close() { this.#ws.close(); }
}

async function target(port, pick) {
    for (let i = 0; i < 600; i += 1) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            const t = list.find(pick);
            if (t) return t.webSocketDebuggerUrl;
        } catch { /* not up yet */ }
        await sleep(100);
    }
    throw new Error(`no target on ${port}`);
}

// MAIN first: the boot's work starts before any window exists.
const main = await Cdp.connect(await target(9229, (t) => t.webSocketDebuggerUrl));
const mainAttached = since(Date.now());
await main.send('Profiler.enable');
await main.send('Profiler.setSamplingInterval', { interval: 1000 });
await main.send('Profiler.start');
await main.eval(`(() => { globalThis.__lag = []; let last = Date.now(); setInterval(() => { const n = Date.now(); if (n - last > 60) globalThis.__lag.push([n, n - last - 10]); last = n; }, 10); return true; })()`);
console.log(`main attached at +${mainAttached} ms`);

const page = await Cdp.connect(await target(9222, (t) => t.type === 'page' && t.webSocketDebuggerUrl && !/devtools/.test(t.url)));
console.log(`renderer attached at +${since(Date.now())} ms`);
await page.send('Profiler.enable');
await page.send('Profiler.setSamplingInterval', { interval: 1000 });
await page.send('Profiler.start');
await page.eval(`(() => { window.__long = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([performance.timeOrigin + e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch (e) { return String(e); } return true; })()`);

// The long thread's chat, as the person had it.
let composerAt = null;
for (let i = 0; i < 1200 && composerAt === null; i += 1) {
    try {
        const ok = await page.call(function openChat(id, composer) {
            if (!location.hash.includes(id)) location.hash = `#genie://agent/${id}?tab=stream`;
            if (!document.querySelector(composer)) document.querySelector('[data-action="chat"]')?.click();
            return Boolean(document.querySelector(composer));
        }, [subject.id, COMPOSER]);
        if (ok) composerAt = since(Date.now());
    } catch { /* page navigating */ }
    if (composerAt === null) await sleep(100);
}
console.log(`composer ready at +${composerAt} ms`);

const keys = [];
const until = launchedAt + SECONDS * 1000;
let typed = 0;
// The render probe's counters (probe-renders.mjs; absent in an unprobed build), read where the steady phase starts and at the end.
// The views' own render counts (src/renderer/render-count.ts) are kept once __genieRenders is an object.
await page.eval('(globalThis.__genieRenders = {}, true)').catch(() => undefined);
const counters = () => page.eval('JSON.stringify({ ...(globalThis.__r ?? {}), ...Object.fromEntries(Object.entries(globalThis.__genieRenders ?? {}).map(([k, v]) => [`render:${k}`, v])) })').then((v) => JSON.parse(v)).catch(() => null);
let steadyFrom = null;
let steadyAt = null;
while (Date.now() < until) {
    if (steadyFrom === null && since(Date.now()) >= 120_000) { steadyFrom = await counters(); steadyAt = Date.now(); }
    await page.call(function focus(composer) { document.querySelector(composer)?.focus(); return true; }, [COMPOSER]).catch(() => undefined);
    const ch = 'abcdefghij'[typed % 10];
    const t0 = Date.now();
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
    const tDown = Date.now();
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
    const tUp = Date.now();
    let shown = false;
    try {
        shown = await page.call(function painted(composer, typed) {
            return new Promise((r) => requestAnimationFrame(() => { const el = document.querySelector(composer); const v = el ? (el.value ?? el.textContent ?? '') : ''; r(v.endsWith(typed)); }));
        }, [COMPOSER, ch], true);
    } catch { shown = false; }
    const t1 = Date.now();
    // Where the time went: the key down handled (browser process → renderer → ack), the key up, then the next frame.
    keys.push([since(t0), t1 - t0, shown, tDown - t0, tUp - tDown, t1 - tUp]);
    typed += 1;
    if (typed % 40 === 0) {
        // Clear the composer the way a person does, so the draft stays small.
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    }
    await sleep(250);
}

const steadyTo = await counters();
const perSecond = steadyFrom && steadyTo ? Object.fromEntries(Object.keys(steadyTo).sort().map((k) => [k, Math.round(((steadyTo[k] - (steadyFrom[k] ?? 0)) / ((Date.now() - steadyAt) / 1000)) * 10) / 10])) : null;
const lag = (await main.eval('globalThis.__lag')).map(([t, d]) => [since(t), d]);
const long = (await page.eval('window.__long')).map(([t, d]) => [since(Math.round(t)), Math.round(d)]);
const mainProfile = (await main.send('Profiler.stop')).result.profile;
const pageProfile = (await page.send('Profiler.stop')).result.profile;
writeFileSync(`${label}-main.cpuprofile`, JSON.stringify(mainProfile));
writeFileSync(`${label}-renderer.cpuprofile`, JSON.stringify(pageProfile));
const memory = await main.eval('JSON.stringify(process.memoryUsage())').catch(() => null);

function top(profile, n = 18) {
    const byId = new Map(profile.nodes.map((x) => [x.id, x]));
    const self = new Map();
    const dt = profile.timeDeltas;
    profile.samples.forEach((id, i) => { const node = byId.get(id); const f = node.callFrame; const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`; self.set(key, (self.get(key) ?? 0) + (dt[i + 1] ?? 0) / 1000); });
    const total = [...self.values()].reduce((a, b) => a + b, 0);
    return { totalMs: Math.round(total), top: [...self].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, ms]) => [k, Math.round(ms)]) };
}

const phase = (from, to) => {
    const ks = keys.filter(([t]) => t >= from && t < to).map(([, d]) => d).sort((a, b) => a - b);
    const q = (p) => (ks.length ? ks[Math.min(ks.length - 1, Math.floor(p * ks.length))] : null);
    const lg = lag.filter(([t]) => t >= from && t < to);
    const lt = long.filter(([t]) => t >= from && t < to);
    return {
        keys: { n: ks.length, p50: q(0.5), p95: q(0.95), max: ks.at(-1) ?? null, over100: ks.filter((d) => d > 100).length, over1000: ks.filter((d) => d > 1000).length },
        phases: Object.fromEntries(['down', 'up', 'frame'].map((name, j) => { const v = keys.filter(([t]) => t >= from && t < to).map((k) => k[3 + j]).filter((x) => x !== undefined).sort((a, b) => a - b); return [name, v.length ? { p50: v[Math.floor(0.5 * v.length)], p95: v[Math.min(v.length - 1, Math.floor(0.95 * v.length))] } : null]; })),
        mainLag: { gaps: lg.length, totalMs: lg.reduce((a, [, d]) => a + d, 0), maxMs: Math.max(0, ...lg.map(([, d]) => d)) },
        rendererLong: { n: lt.length, totalMs: lt.reduce((a, [, d]) => a + d, 0), maxMs: Math.max(0, ...lt.map(([, d]) => d)) },
    };
};
const result = {
    label, seconds: SECONDS, mainAttached, composerAt, memory,
    boot: phase(0, 90_000), steady: phase(120_000, SECONDS * 1000), all: phase(0, SECONDS * 1000),
    keysMissed: keys.filter(([, , s]) => !s).length,
    steadyPerSecond: perSecond,
    mainTop: top(mainProfile), rendererTop: top(pageProfile),
    worstMainGaps: [...lag].sort((a, b) => b[1] - a[1]).slice(0, 15),
    worstLongTasks: [...long].sort((a, b) => b[1] - a[1]).slice(0, 15),
    keys, lag, long,
};
writeFileSync(`${label}-result.json`, JSON.stringify(result));
const { keys: _k, lag: _l, long: _lt, ...summary } = result;
console.log(JSON.stringify(summary, null, 1));
main.close();
page.close();
process.exit(0);
