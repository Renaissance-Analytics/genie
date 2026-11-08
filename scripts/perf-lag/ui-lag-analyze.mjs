/**
 * THE UI-LAG ROW'S ARITHMETIC (Tynn #274 / #429), kept pure so a unit test can prove each number can come out the way it
 * is claimed: a gap gauge's worst gaps, input-latency percentiles, and what a V8 CPU profile says a thread was doing over
 * a window of time. Used by scripts/ui-lag-cdp.mjs; nothing in src/ imports it.
 */

/** Count, median, p95 and max of a list of milliseconds. Empty → zeros with count 0. */
export function summarize(values) {
    const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (sorted.length === 0) return { count: 0, p50: 0, p95: 0, max: 0 };
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
    const round = (v) => Math.round(v * 10) / 10;
    return { count: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1)) };
}

/**
 * A gap gauge: `beat(now)` every `intervalMs`; a beat later than the interval by more than `thresholdMs` is a gap (how
 * long the thread did not run its timers). Keeps every gap over the threshold, at most `cap` of them, and counts the rest.
 */
export function createGapGauge({ intervalMs, thresholdMs, cap = 4096, now }) {
    let last = now(), ticks = 0, dropped = 0, worst = 0;
    const gaps = [];
    return {
        beat() {
            const t = now(), lateness = t - last - intervalMs;
            ticks += 1;
            if (lateness > worst) worst = lateness;
            if (lateness > thresholdMs) { if (gaps.length < cap) gaps.push({ startedMs: last, endedMs: t, ms: lateness }); else dropped += 1; }
            last = t;
        },
        reset() { last = now(); ticks = 0; dropped = 0; worst = 0; gaps.length = 0; },
        snapshot: () => ({ ticks, dropped, worstMs: Math.max(0, worst), gaps: gaps.map((g) => ({ ...g })) }),
    };
}

/** The gaps of `snapshot` that fall inside [fromMs, toMs], the `n` longest first. */
export function worstGaps(gaps, fromMs, toMs, n = 10) {
    return gaps.filter((g) => g.endedMs >= fromMs && g.startedMs <= toMs).sort((a, b) => b.ms - a.ms).slice(0, n);
}

const IDLE = new Set(['(idle)']);
const PROGRAM = new Set(['(program)']);
const GC = new Set(['(garbage collector)']);

/**
 * Index a V8 CPU profile (`Profiler.stop`'s `profile`): each sample with its time (ms on the profile's own clock) and node,
 * and each node's stack as text, leaf first. `resolve(callFrame)` may rename a frame (a source map); it returns a string
 * or null for "as is".
 */
export function indexProfile(profile, resolve = () => null) {
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const names = new Map();
    const frameOf = (id) => {
        if (names.has(id)) return names.get(id);
        const f = byId.get(id)?.callFrame ?? { functionName: '?', url: '', lineNumber: -1, columnNumber: -1 };
        const mapped = resolve(f);
        const file = f.url ? f.url.split(/[\\/]/).pop().split('?')[0] : '';
        const text = mapped ?? (file ? `${f.functionName || '(anonymous)'} ${file}:${f.lineNumber + 1}` : (f.functionName || '(anonymous)'));
        names.set(id, text);
        return text;
    };
    const fnOf = (id) => byId.get(id)?.callFrame.functionName ?? '';
    const stack = (id, depth = 10) => {
        const out = [];
        for (let at = id; at !== undefined && fnOf(at) !== '(root)' && out.length < depth; at = parent.get(at)) out.push(frameOf(at));
        return out;
    };
    const has = (id, fn) => { for (let at = id; at !== undefined; at = parent.get(at)) if (fnOf(at) === fn) return true; return false; };
    const samples = [];
    let t = profile.startTime;
    for (let i = 0; i < profile.samples.length; i += 1) { t += profile.timeDeltas[i] ?? 0; samples.push({ t: t / 1000, id: profile.samples[i] }); }
    const kind = (id) => { const fn = fnOf(id); return IDLE.has(fn) ? 'idle' : PROGRAM.has(fn) ? 'program' : GC.has(fn) ? 'gc' : 'js'; };
    return { samples, stack, has, kind, fnOf };
}

/** The profile time (ms) of the first sample whose stack holds a frame named `fn`, or null (an alignment marker). */
export function firstSampleWith(index, fn) {
    for (const s of index.samples) if (index.has(s.id, fn)) return s.t;
    return null;
}

/**
 * What the thread was doing over [fromMs, toMs] of the profile's clock: how many ms of samples were JS, native
 * "(program)", GC or idle, the heaviest stacks (leaf first) and the frames most often seen anywhere on a JS stack whose
 * file is Genie's own (`isOwn(frameText)`), by sampled ms.
 */
export function windowProfile(index, fromMs, toMs, { top = 3, depth = 10, isOwn = () => false } = {}) {
    const inside = [];
    for (let i = 0; i < index.samples.length; i += 1) {
        const s = index.samples[i];
        if (s.t < fromMs || s.t > toMs) continue;
        const next = index.samples[i + 1];
        inside.push({ ...s, ms: next ? Math.max(0, next.t - s.t) : 0 });
    }
    const ms = { js: 0, program: 0, gc: 0, idle: 0 };
    const stacks = new Map(), own = new Map();
    for (const s of inside) {
        const k = index.kind(s.id);
        ms[k] += s.ms;
        if (k !== 'js' && k !== 'gc') continue;
        const st = index.stack(s.id, depth);
        const key = st.join(' < ');
        stacks.set(key, (stacks.get(key) ?? 0) + s.ms);
        const ownFrame = st.find(isOwn);
        if (ownFrame) own.set(ownFrame, (own.get(ownFrame) ?? 0) + s.ms);
    }
    const r = (v) => Math.round(v * 10) / 10;
    return {
        samples: inside.length,
        ms: { js: r(ms.js), program: r(ms.program), gc: r(ms.gc), idle: r(ms.idle) },
        stacks: [...stacks].sort((a, b) => b[1] - a[1]).slice(0, top).map(([stack, v]) => ({ ms: r(v), stack })),
        ownFrames: [...own].sort((a, b) => b[1] - a[1]).slice(0, top + 2).map(([frame, v]) => ({ ms: r(v), frame })),
    };
}

/** The budget row: did any gap inside the window pass `budgetMs`? */
export function budgetVerdict(gaps, budgetMs) {
    const over = gaps.filter((g) => g.ms > budgetMs);
    return { ok: over.length === 0, budgetMs, over: over.length, worstMs: Math.round(Math.max(0, ...gaps.map((g) => g.ms)) * 10) / 10 };
}

/**
 * THE FILES STATE BUDGET (Tynn #522, L2): per `files.state` call, how many metadata pages main served, in each pass's
 * build. Within `maxPerState`, and a later pass (a longer session: more paths changed before it) no costlier than
 * `growth`× the first plus `slack`. A pass with no `files.state` call fails: the Files panel never read, nothing measured.
 */
export function pagingVerdict(passes, { maxPerState = 16, growth = 1.5, slack = 2 } = {}) {
    const rows = passes.map((p) => ({ pass: p.pass, states: p.states, pageNext: p.pageNext, perState: p.states > 0 ? Math.round((p.pageNext / p.states) * 10) / 10 : null }));
    const first = rows[0]?.perState ?? null;
    const reasons = [];
    for (const r of rows) {
        if (r.perState === null) reasons.push(`${r.pass}: no files.state call during the build`);
        else if (r.perState > maxPerState) reasons.push(`${r.pass}: ${r.perState} pages per files.state (bound ${maxPerState})`);
    }
    for (const r of rows.slice(1)) if (first !== null && r.perState !== null && r.perState > first * growth + slack) reasons.push(`${r.pass}: ${r.perState} pages per files.state grew from ${first}`);
    return { ok: reasons.length === 0, maxPerState, rows, reasons };
}

/**
 * THE FILES PUSH BUDGET (Tynn #523, L3): bytes per Files push to the page during each pass's build, with the Files panel
 * open. The p95 within `p95Bytes` and the mean within `meanBytes`: a view's first push may carry a whole git tree, every
 * one after it only what changed. A pass with no push fails: nothing reached the page, nothing measured.
 */
export function pushVerdict(passes, { p95Bytes = 32 * 1024, meanBytes = 24 * 1024 } = {}) {
    const rows = passes.map((p) => {
        const sizes = p.sizes.filter((n) => Number.isFinite(n));
        return { pass: p.pass, count: sizes.length, meanBytes: sizes.length ? Math.round(sizes.reduce((a, n) => a + n, 0) / sizes.length) : null, p95Bytes: sizes.length ? summarize(sizes).p95 : null, maxBytes: sizes.length ? Math.max(...sizes) : null };
    });
    const reasons = [];
    for (const r of rows) {
        if (r.count === 0) { reasons.push(`${r.pass}: no Files push during the build`); continue; }
        if (r.p95Bytes > p95Bytes) reasons.push(`${r.pass}: p95 ${r.p95Bytes} bytes per Files push (bound ${p95Bytes})`);
        if (r.meanBytes > meanBytes) reasons.push(`${r.pass}: mean ${r.meanBytes} bytes per Files push (bound ${meanBytes})`);
    }
    return { ok: reasons.length === 0, p95Bytes, meanBytes, rows, reasons };
}

/**
 * THE PAGE BUDGET WHILE A TERMINAL STREAMS (Tynn #525, L5): against the same run's idle phase, so a slower runner is not a
 * failure of its own. The mouse's delay to the next frame (p95) no more than `p95SlackMs` over idle's, and no frame gap
 * over `maxFrameGapMs`. A phase the mouse never reached fails: nothing measured.
 */
export function pageVerdict({ idle, streaming }, { p95SlackMs = 10, maxFrameGapMs = 100 } = {}) {
    const reasons = [];
    if (!(idle?.count > 0) || !(streaming?.count > 0)) reasons.push('the mouse reached no frame in the idle or the streaming phase');
    else if (streaming.p95 > idle.p95 + p95SlackMs) reasons.push(`mouse to frame p95 ${streaming.p95} ms while the terminal streams, idle ${idle.p95} ms (bound idle + ${p95SlackMs})`);
    if (streaming?.worstFrameGapMs > maxFrameGapMs) reasons.push(`a frame gap of ${Math.round(streaming.worstFrameGapMs)} ms while the terminal streams (bound ${maxFrameGapMs})`);
    return { ok: reasons.length === 0, p95SlackMs, maxFrameGapMs, idleP95: idle?.p95 ?? null, streamingP95: streaming?.p95 ?? null, worstFrameGapMs: streaming?.worstFrameGapMs ?? null, reasons };
}
