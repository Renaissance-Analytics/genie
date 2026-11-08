/**
 * A TERMINAL'S OUTPUT, ONE RENDER PER BATCH (Tynn #525, UI lag L5). The Workspace re-rendered, synchronously (`flushSync`),
 * on every chunk a terminal sent: measured in the real window while a build streamed (scripts/ui-lag-cdp.mjs, Linux), the
 * page spent ~800-970 ms of JS in 10 s on it, the mouse's delay to the next frame went from 44 ms idle to a p95 of 60-74
 * ms, and frames were missed for up to 133 ms. The top frame was that data handler.
 *
 * Now the chunks a terminal sends within {@link BATCH_MS} are joined, and applied once, in an ordinary task. Not in the
 * animation frame: measured on the Windows runner, applying them there made the frame itself longer and the mouse's delay
 * to it worse (p95 25 ms against 15 ms idle), where a task between frames leaves the frame alone. What is held for one
 * terminal never grows past `cap` (the output the view keeps anyway). An exit applies what is held first, so the output
 * before it is never lost or reordered; a snapshot replaces the output, so what was held before it is dropped.
 */
export const BATCH_MS = 33;

export interface OutputBatchPorts {
    /** Apply the joined output of each terminal, in one state update. */
    readonly apply: (batch: ReadonlyArray<readonly [string, string]>) => void;
    readonly later?: (fn: () => void, ms: number) => () => void;
    /** How much one terminal's held output may be (its tail is kept). */
    readonly cap: number;
}

export interface OutputBatch {
    data(id: string, text: string): void;
    /** Apply what is held now (before an exit). */
    flush(): void;
    /** Forget what is held for `id` (a snapshot replaces its output). */
    drop(id: string): void;
    /** Stop: nothing held is applied. */
    close(): void;
}

export function outputBatch(ports: OutputBatchPorts): OutputBatch {
    const later = ports.later ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
    const held = new Map<string, string>();
    let cancel: (() => void) | null = null;
    let closed = false;
    const unschedule = () => { cancel?.(); cancel = null; };
    const flush = () => {
        unschedule();
        if (closed || held.size === 0) return;
        const batch = [...held];
        held.clear();
        ports.apply(batch);
    };
    return {
        data(id, text) {
            if (closed) return;
            const joined = (held.get(id) ?? '') + text;
            held.set(id, joined); // PROBE
            cancel ??= later(flush, BATCH_MS);
        },
        flush,
        drop(id) { held.delete(id); if (held.size === 0) unschedule(); },
        close() { closed = true; held.clear(); unschedule(); },
    };
}
