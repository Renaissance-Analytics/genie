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
