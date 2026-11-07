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

/**
 * Beats at once, on EVERY CHANGE to the started set (a start, a stop, an exit: an agent started just before this run dies
 * is on the beat the next start reads — the owner's crash loop came as a restore brought agents back), and every 15 s. A
 * session event that leaves the set as it was writes nothing. Answers its stop.
 */
export function startBeat(p: BeatPorts): () => void {
    const every = p.every ?? ((fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return () => clearInterval(t); });
    let last: string | null = null;
    const keyOf = (ids: readonly string[]) => JSON.stringify([...ids].sort());
    const beat = () => { const ids = p.started(); last = keyOf(ids); p.beat(ids); };
    beat();
    const stopChanges = p.onChange(() => { if (keyOf(p.started()) !== last) beat(); });
    const stopTimer = every(beat, BEAT_EVERY_MS);
    return () => { stopChanges(); stopTimer(); };
}
