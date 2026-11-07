export interface ComposeStageSample { readonly stage: string; readonly elapsedMs: number; readonly totalMs: number }
export interface ComposeStageDiagnostics { begin(stage: string): void; end(): void; ready(): void }

/** Checkpoints only: diagnostics never wrap an operation, add an await, or decide whether composition succeeds. */
export function composeStageDiagnostics(
    observer: ((sample: ComposeStageSample) => void) | undefined,
    now: () => number = () => performance.now(),
): ComposeStageDiagnostics | null {
    if (!observer) return null;
    const started = now(); let last = started, current: { stage: string; started: number } | null = null;
    const emit = (sample: ComposeStageSample): void => {
        try { observer(sample); } catch { /* An optional diagnostic listener cannot control service composition. */ }
    };
    return {
        begin(stage) {
            const at = now(); current = { stage, started: at };
            emit({ stage: `${stage}:begin`, elapsedMs: 0, totalMs: at - started });
        },
        end() {
            if (!current) return;
            const at = now(), entry = current; current = null; last = at;
            emit({ stage: entry.stage, elapsedMs: at - entry.started, totalMs: at - started });
        },
        ready() {
            const at = now(); emit({ stage: 'ready', elapsedMs: at - last, totalMs: at - started });
        },
    };
}
