/**
 * SAFE MODE'S SIGN OF LIFE, KEPT CURRENT (Tynn #386): which agents have a session, beaten into `runtime/alive.json` for the
 * next start to read if this run dies. genie-host beats its SessionHost; the no-host window (#1624) beats its own.
 */
export interface BeatPorts {
    /** The agents with a session now. */
    readonly started: () => readonly string[];
    /** Told on a session's change (a start, a stop, an exit, or any event); answers its stop. */
    readonly onChange: (listener: () => void) => () => void;
    readonly beat: (agents: readonly string[]) => void;
    /** The steady beat; default `setInterval`, unref'd. */
    readonly every?: (fn: () => void, ms: number) => () => void;
}

export const BEAT_EVERY_MS = 15_000;

export function startBeat(p: BeatPorts): () => void {
    const every = p.every ?? ((fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return () => clearInterval(t); });
    p.beat(p.started());
    return every(() => { p.beat(p.started()); }, BEAT_EVERY_MS);
}
