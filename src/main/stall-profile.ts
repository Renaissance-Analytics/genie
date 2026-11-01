/**
 * WHAT MAIN WAS DOING WHILE IT WAS HELD (beta.53: Windows logged AppHangTransient for Genie.exe five times on the owner's
 * machine on 2026-10-31 — main's thread not pumping for 5 s or more — and Genie itself said nothing about why).
 *
 * A block cannot be stacked after the fact: by the time the watchdog's heartbeat runs again, whatever held the loop has
 * returned. So main samples its OWN stack all the time, cheaply — V8's profiler through `node:inspector`, one sample per
 * {@link SAMPLE_US} µs, the profile restarted every {@link WINDOW_MS} so it stays small — and when the watchdog sees a block
 * it stops the profile, takes the longest run of busy samples at its end (the block), and writes the heaviest stack in
 * it to the lifecycle log as `stall main stack ms=… top=… stack=leaf < caller < …`.
 *
 * Moves to the host service with the watchdog when the host/client split lands; a window never runs this.
 */

export const SAMPLE_US = 10_000;
export const WINDOW_MS = 60_000;
const STACK_DEPTH = 12;

export interface CpuProfile {
    nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }>;
    startTime: number;
    endTime: number;
    samples: number[];
    timeDeltas: number[];
}

export interface BlockStack { readonly ms: number; readonly stack: readonly string[]; readonly line: string }

const IDLE = new Set(['(idle)', '(program)', '(root)']);

/**
 * The longest run of consecutive busy samples in `profile` that ENDS within its last second (the block the watchdog just
 * saw), if it is at least `minMs` long: its heaviest stack, leaf first. `null` when there is none.
 */
export function blockStack(profile: CpuProfile, minMs: number): BlockStack | null {
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map<number, number>();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const name = (id: number): string => byId.get(id)?.callFrame.functionName || '(anonymous)';
    const where = (id: number): string => {
        const f = byId.get(id)!.callFrame;
        const file = f.url ? f.url.split(/[\\/]/).pop() : '';
        return file ? `${name(id)} ${file}:${f.lineNumber + 1}` : name(id);
    };
    const times: number[] = [];
    let t = 0;
    for (let i = 0; i < profile.samples.length; i += 1) { t += profile.timeDeltas[i] ?? 0; times.push(t); }
    const end = times.at(-1) ?? 0;
    let best: { start: number; stop: number } | null = null;
    let start = -1;
    for (let i = 0; i <= profile.samples.length; i += 1) {
        const busy = i < profile.samples.length && !IDLE.has(name(profile.samples[i]!));
        if (busy && start === -1) start = i;
        if (!busy && start !== -1) {
            const stop = i - 1;
            const ms = (times[stop]! - times[start]!) / 1000;
            if (ms >= minMs && end - times[stop]! <= 1_000_000 && (!best || ms > (times[best.stop]! - times[best.start]!) / 1000)) best = { start, stop };
            start = -1;
        }
    }
    if (!best) return null;
    const count = new Map<number, number>();
    for (let i = best.start; i <= best.stop; i += 1) count.set(profile.samples[i]!, (count.get(profile.samples[i]!) ?? 0) + 1);
    const heaviest = [...count].sort((a, b) => b[1] - a[1])[0]![0];
    const stack: string[] = [];
    for (let id: number | undefined = heaviest; id !== undefined && name(id) !== '(root)' && stack.length < STACK_DEPTH; id = parent.get(id)) stack.push(where(id));
    const ms = Math.round((times[best.stop]! - times[best.start]!) / 1000);
    const line = `stall main stack ms=${ms} top=${stack[0] ?? '?'} stack=${stack.join(' < ')}`.replace(/[\r\n]+/g, ' ').slice(0, 1_500);
    return { ms, stack, line };
}

/** The part of `node:inspector`'s Session this uses. */
export interface InspectorSessionLike {
    connect(): void;
    post(method: string, params: object | undefined, callback: (error: Error | null, result?: { profile?: CpuProfile }) => void): void;
}

/**
 * Sample main's stack from now on, and answer `capture(ms)` — called by the watchdog on a block of `ms` — with the line
 * to log (or null). Never throws: a profiler that cannot start is said once and the watchdog runs without stacks.
 */
export function startStallProfiler(session: InspectorSessionLike, log: (line: string) => void, schedule: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms).unref?.(); }): { capture(ms: number): void } {
    let running = false;
    const begin = (): void => {
        session.post('Profiler.start', {}, (error) => { running = error === null; });
    };
    const restart = (then?: (profile: CpuProfile | null) => void): void => {
        if (!running) { then?.(null); begin(); return; }
        session.post('Profiler.stop', {}, (error, result) => {
            running = false;
            then?.(error === null ? result?.profile ?? null : null);
            begin();
        });
    };
    try {
        session.connect();
        session.post('Profiler.enable', {}, () => undefined);
        session.post('Profiler.setSamplingInterval', { interval: SAMPLE_US }, () => undefined);
        begin();
        const roll = (): void => { restart(); schedule(roll, WINDOW_MS); };
        schedule(roll, WINDOW_MS);
    } catch (error) {
        log(`stall profiler off: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
        capture(ms) {
            try {
                restart((profile) => {
                    const found = profile ? blockStack(profile, Math.min(ms, 1_000) * 0.8) : null;
                    if (found) log(found.line);
                });
            } catch { /* a stack is a bonus; the block itself is already logged */ }
        },
    };
}
