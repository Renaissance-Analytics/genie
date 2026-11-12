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

const median = (values) => { const v = values.filter(Number.isFinite).sort((a, b) => a - b); if (v.length === 0) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

/**
 * THE PAGE BUDGET, FROM A DISTRIBUTION (Tynn #536). The terminal's cost to the page, under the SAME build load: slices with
 * the terminal on screen against slices with it off screen, interleaved, each slice's mouse-to-frame p95 and worst frame
 * gap. The median of the "on" slices' p95 within `p95SlackMs` of the "off" slices' median, and the median of their worst
 * frame gaps within `maxFrameGapMs`. Too few slices with input on either side fails: nothing measured.
 *
 * Against the idle phase (Tynn #525's first form) it was a comparison with NO build running: on a slow runner the build's
 * own load was counted against the terminal (run 42450996960: 65 ms streaming, 45.1 idle, and 63.7 in the Files phase with
 * no terminal at all).
 */
export function sliceVerdict({ on, off }, { p95SlackMs = 10, maxFrameGapMs = 100, minSlices = 3 } = {}) {
    // PAIRED (the coordinator's (b)): slice k "on" against slice k "off", next to it in time, so a runner that slows down or
    // speeds up during the build moves both. Only pairs where both slices had input count.
    const pairs = on.map((x, k) => [x, off[k]]).filter(([a, b]) => a && b && a.count > 0 && b.count > 0);
    const diffs = pairs.map(([a, b]) => a.p95 - b.p95), reasons = [];
    const diff = median(diffs), onP95 = median(pairs.map(([a]) => a.p95)), offP95 = median(pairs.map(([, b]) => b.p95)), onGap = median(pairs.map(([a]) => a.worstGapMs));
    const r = (v) => (v === null ? null : Math.round(v * 10) / 10);
    if (pairs.length < minSlices) reasons.push(`too few pairs with input on both sides: ${pairs.length} (need ${minSlices})`);
    else {
        if (diff > p95SlackMs) reasons.push(`mouse to frame p95, median of ${pairs.length} paired differences: the terminal on screen ${r(diff)} ms over off (bound ${p95SlackMs}; on ${r(onP95)}, off ${r(offP95)})`);
        if (onGap > maxFrameGapMs) reasons.push(`worst frame gap, median of ${pairs.length} slices with the terminal on screen: ${r(onGap)} ms (bound ${maxFrameGapMs})`);
    }
    return { ok: reasons.length === 0, p95SlackMs, maxFrameGapMs, pairs: pairs.length, diffP95: r(diff), diffs: diffs.map(r), onP95: r(onP95), offP95: r(offP95), onWorstGapMs: r(onGap), reasons };
}

/**
 * THE THROUGHPUT BUDGET (Tynn #537): how much of the input the page keeps up with while the terminal is on screen, against
 * the slice beside it with it off. `count` is the mouse events whose frame came within the slice; the median of the paired
 * ratios on/off at least `minRatio`. The bound is from the Windows runner's recorded runs (run 42488024371: paired ratios
 * 0.92-0.99, median 0.96); the Linux runner in the same run kept up with about half (0.49-0.69). An "off" slice with no
 * input says nothing, and its pair is left out; an "on" slice with none is the worst case and counts as 0.
 */
/**
 * THE TERMINAL PAST ITS OUTPUT CAP (Tynn #542): slices with the terminal on screen while its output streams PAST the view's
 * cap, against the slices with it on screen below the cap in the same pass. Not paired: switching the terminal off and on
 * re-attaches it with a short snapshot, under the cap again. The median input acknowledged past the cap at least
 * `minRatio` of below it, and the median worst frame gap past it within `maxFrameGapMs`.
 */
/**
 * WHAT A TERMINAL VIEW HOLDS (Tynn #544): the page's heap after a flood, against before it, each after a forced
 * collection. A view that keeps its terminal's newest `capChars` holds that and `slackBytes` besides (xterm's own
 * scrollback, the page's churn); one that keeps everything holds the flood.
 */
export function heldVerdict({ floodBytes, growthBytes }, { capChars = 2_000_000, slackBytes = 4_000_000 } = {}) {
    const mb = (v) => Math.round(v / 100_000) / 10, bound = capChars + slackBytes, reasons = [];
    if (!Number.isFinite(growthBytes)) reasons.push('the heap was not read before and after the flood');
    else if (growthBytes > bound) reasons.push(`the view held ${mb(growthBytes)} MB more after a ${mb(floodBytes)} MB flood (bound ${mb(bound)} MB: the ${mb(capChars)} MB cap and ${mb(slackBytes)} MB besides)`);
    return { ok: reasons.length === 0, floodBytes, growthBytes, boundBytes: bound, reasons };
}

/**
 * PAST THE CAP, BY PAIR (Tynn #692): `past[k]` against `below[k]`, its control taken next to it in time (the same terminal
 * still streaming past the cap, its pane hidden). The mouse ratio is the median of the pairs' ratios and the script time
 * the median of the pairs' differences, so a machine that slows down during the phase moves both sides of every pair.
 * The bounds are the unpaired verdict's.
 */
function pairedCapVerdict(control, past, { minRatio, maxFrameGapMs, maxScriptOverMsPerS, minSlices, name }) {
    const reasons = [], r2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
    const pairs = past.map((x, k) => [x, control[k]]).filter(([a, b]) => a && b);
    const pastCount = median(past.map((x) => x.count)), controlCount = median(control.map((x) => x.count)), pastGap = median(past.map((x) => x.worstGapMs));
    const ratios = pairs.filter(([, b]) => b.count > 0).map(([a, b]) => a.count / b.count);
    const ratio = ratios.length ? median(ratios) : null;
    const pastScript = median(past.map((x) => x.scriptMsPerS)), controlScript = median(control.map((x) => x.scriptMsPerS));
    if (pairs.length < minSlices || control.length !== past.length) reasons.push(`too few pairs: ${pairs.length} past slices with a control beside them (need ${Math.max(minSlices, past.length)})`);
    else {
        if (ratio === null || ratio < minRatio) reasons.push(`mouse events acknowledged past the output cap: ${r2(ratio)} of ${name}, median of ${pairs.length} pairs (bound ${minRatio}; past ${pastCount}, control ${controlCount})`);
        if (pastGap > maxFrameGapMs) reasons.push(`worst frame gap past the output cap, median of ${past.length} slices: ${pastGap} ms (bound ${maxFrameGapMs})`);
        if (![...control, ...past].every((x) => Number.isFinite(x.scriptMsPerS))) reasons.push('page script time not measured in every slice');
        else {
            const over = median(pairs.map(([a, b]) => a.scriptMsPerS - b.scriptMsPerS));
            if (over > maxScriptOverMsPerS) reasons.push(`page script time past the output cap: ${Math.round(over)} ms per second over ${name}, median of ${pairs.length} pairs (bound ${maxScriptOverMsPerS}; past ${pastScript}, control ${controlScript})`);
        }
    }
    return { ok: reasons.length === 0, paired: true, control: name, minRatio, maxFrameGapMs, maxScriptOverMsPerS, ratio: r2(ratio), ratios: ratios.map(r2), belowCount: controlCount, pastCount, pastWorstGapMs: pastGap, pastScriptMsPerS: pastScript, belowScriptMsPerS: controlScript, reasons };
}

export function capVerdict({ below, past }, { minRatio = 0.9, maxFrameGapMs = 100, maxScriptOverMsPerS = 50, minSlices = 3, paired = false, control = 'its control' } = {}) {
    if (paired) return pairedCapVerdict(below, past, { minRatio, maxFrameGapMs, maxScriptOverMsPerS, minSlices, name: control });
    const reasons = [], r2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
    const belowCount = median(below.map((x) => x.count)), pastCount = median(past.map((x) => x.count)), pastGap = median(past.map((x) => x.worstGapMs));
    const ratio = belowCount ? pastCount / belowCount : null;
    if (below.length < minSlices || past.length < minSlices) reasons.push(`too few slices: ${below.length} below the cap and ${past.length} past it (need ${minSlices} each)`);
    else {
        if (ratio === null || ratio < minRatio) reasons.push(`mouse events acknowledged past the output cap: ${r2(ratio)} of the slices below it (bound ${minRatio}; past ${pastCount}, below ${belowCount})`);
        if (pastGap > maxFrameGapMs) reasons.push(`worst frame gap past the output cap, median of ${past.length} slices: ${pastGap} ms (bound ${maxFrameGapMs})`);
        // THE PAGE'S SCRIPT TIME (run 0d892cff): xterm parses a rewrite in slices of its own, so input can keep up while the
        // page burns its thread. Past the cap within `maxScriptOverMsPerS` (ms of script per second) of below it.
        if (![...below, ...past].every((x) => Number.isFinite(x.scriptMsPerS))) reasons.push('page script time not measured in every slice');
        else {
            const pastScript = median(past.map((x) => x.scriptMsPerS)), belowScript = median(below.map((x) => x.scriptMsPerS));
            if (pastScript - belowScript > maxScriptOverMsPerS) reasons.push(`page script time past the output cap: ${Math.round(pastScript - belowScript)} ms per second over below it, median (bound ${maxScriptOverMsPerS}; past ${pastScript}, below ${belowScript})`);
        }
    }
    return { ok: reasons.length === 0, minRatio, maxFrameGapMs, maxScriptOverMsPerS, ratio: r2(ratio), belowCount, pastCount, pastWorstGapMs: pastGap, pastScriptMsPerS: median(past.map((x) => x.scriptMsPerS)), belowScriptMsPerS: median(below.map((x) => x.scriptMsPerS)), reasons };
}

export function throughputVerdict({ on, off }, { minRatio = 0.9, minSlices = 3 } = {}) {
    const pairs = on.map((x, k) => [x, off[k]]).filter(([a, b]) => a && b && b.count > 0);
    const ratios = pairs.map(([a, b]) => a.count / b.count), reasons = [];
    const ratio = median(ratios), r2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
    if (pairs.length < minSlices) reasons.push(`too few pairs with input off screen: ${pairs.length} (need ${minSlices})`);
    else if (ratio < minRatio) reasons.push(`mouse events acknowledged, median of ${pairs.length} paired ratios: the terminal on screen ${r2(ratio)} of off (bound ${minRatio}; on ${median(pairs.map(([a]) => a.count))}, off ${median(pairs.map(([, b]) => b.count))})`);
    return { ok: reasons.length === 0, minRatio, pairs: pairs.length, ratio: r2(ratio), ratios: ratios.map(r2), reasons };
}

/**
 * A CHROMIUM TRACE, SUMMARISED (Tynn #537): what each thread spent its time on during one slice. Threads are named from the
 * trace's own `thread_name` events (else `pid:tid`). `threads` is each thread's time with nested events counted once;
 * `top` the events by their summed duration, nested ones included as their own rows. Only complete events (`X`) count.
 */
export function traceSummary(events, { top = 15 } = {}) {
    const names = new Map(), perThread = new Map(), perEvent = new Map();
    for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args?.name ?? `${e.pid}:${e.tid}`);
    const complete = events.filter((e) => e.ph === 'X' && typeof e.dur === 'number' && typeof e.ts === 'number').sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const reach = new Map();
    for (const e of complete) {
        const id = `${e.pid}:${e.tid}`, thread = names.get(id) ?? id, key = `${thread}\u0000${e.name}`;
        const row = perEvent.get(key) ?? { thread, name: e.name, us: 0, count: 0 };
        row.us += e.dur; row.count += 1; perEvent.set(key, row);
        // Top-level on its thread when it starts after the last top-level event there ended.
        const end = reach.get(id) ?? -Infinity;
        if (e.ts >= end) { perThread.set(thread, (perThread.get(thread) ?? 0) + e.dur); reach.set(id, e.ts + e.dur); }
        else if (e.ts + e.dur > end) { perThread.set(thread, perThread.get(thread) + (e.ts + e.dur - end)); reach.set(id, e.ts + e.dur); }
    }
    const ms = (us) => Math.round(us / 100) / 10;
    return {
        threads: [...perThread].sort((a, b) => b[1] - a[1]).map(([thread, us]) => ({ thread, ms: ms(us) })),
        top: [...perEvent.values()].sort((a, b) => b.us - a.us).slice(0, top).map((x) => ({ thread: x.thread, name: x.name, ms: ms(x.us), count: x.count })),
    };
}

/**
 * The row's own fixture git, bounded (Tynn #536: spawnSync git ETIMEDOUT on the Windows runner, genie#1718). `run` is
 * tried up to `attempts` times while it times out, `reset` between tries; any other failure is thrown at once.
 */
export function retryOnTimeout(run, { attempts = 2, reset = () => {} } = {}) {
    const tries = [];
    for (let i = 1; ; i += 1) {
        const started = Date.now();
        try { const value = run(i); tries.push({ attempt: i, ms: Date.now() - started, ok: true }); return { value, tries }; }
        catch (error) {
            const timedOut = error?.code === 'ETIMEDOUT' || /ETIMEDOUT/.test(String(error?.message ?? ''));
            tries.push({ attempt: i, ms: Date.now() - started, ok: false, timedOut });
            if (!timedOut || i >= attempts) { error.tries = tries; throw error; }
            reset(i);
        }
    }
}
