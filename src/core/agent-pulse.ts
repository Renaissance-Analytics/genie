import type { StreamEvent } from './stream-event.js';
import type { TimedEvent } from './stream-view.js';

/**
 * THE AGENT PULSE (beta.64): the last minute of one agent's work, drawn small in its agent view.
 *
 * Genie 1 drew a pulse behind each workspace in its sidebar (`renderer/components/Master/AgentPulse.tsx` at
 * v0.7.0-beta.342): a 60 x 1 s byte ring per workspace kept in the renderer, fed by a main-process counter that
 * pushed up to four events a second per workspace, shifted by a 1 s timer that re-rendered the whole sidebar, plus an
 * endless CSS "breathe" animation and inbox markers drawn over the line. It replaced the SESSION lane bar here
 * because the owner wanted that pulse back, cheaper.
 *
 * What makes this one cheaper:
 *
 * - **No buffer.** The minute is DERIVED from the rows the agent view already holds, so nothing accumulates, nothing
 *   is pushed over IPC, and there is no ring to shift.
 * - **A bounded read.** Rows are in time order, so the scan walks back from the newest and stops at the first row
 *   older than the minute: a session of ten thousand rows costs what its last minute costs.
 * - **A clock only while something can move** ({@link pulseTickMs}): every 2 s while the agent works or the minute
 *   still holds events, and none at all for an idle agent, or while the window is hidden.
 *
 * The markers are Genie 1's idea in Genie 2's terms: an edit, mail from another agent (a `peer` message, Genie 1's
 * "delivered"), and a question the agent asked (an approval). Counted per slot, so two in one slot read as two.
 */

export const PULSE_SLOTS = 30;
export const PULSE_SLOT_MS = 2_000;
export const PULSE_WINDOW_MS = PULSE_SLOTS * PULSE_SLOT_MS;
/** One tick per slot: a faster clock would redraw a picture that cannot have changed. */
export const PULSE_TICK_MS = PULSE_SLOT_MS;

export type PulseMarkerKind = 'edit' | 'mail' | 'question';
/** The order a slot's markers are listed in, so the picture reads the same way every time. */
export const PULSE_MARKER_KINDS: readonly PulseMarkerKind[] = ['edit', 'mail', 'question'];

export interface PulseMarker { slot: number; kind: PulseMarkerKind; n: number }

export interface AgentPulseModel {
    /** Events per slot, oldest first; the last slot ends now. */
    counts: readonly number[];
    markers: readonly PulseMarker[];
    /** Nothing happened in the minute. */
    quiet: boolean;
}

/** Work the agent did: what it said, thought, ran, edited, and asked. Turn markers, usage and notices are not work. */
function isWork(event: StreamEvent): boolean {
    return event.kind === 'message' || event.kind === 'think' || event.kind === 'tool' || event.kind === 'approval';
}

function markerOf(event: StreamEvent): PulseMarkerKind | null {
    if (event.kind === 'tool' && event.toolKind === 'edit') return 'edit';
    if (event.kind === 'message' && event.speaker === 'peer') return 'mail';
    if (event.kind === 'approval') return 'question';
    return null;
}

export function agentPulse(rows: readonly TimedEvent[], now: number): AgentPulseModel {
    const counts = new Array<number>(PULSE_SLOTS).fill(0);
    const marks = new Map<string, PulseMarker>();
    let any = false;
    for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i]!;
        if (row.at === null) continue;
        const age = Math.max(0, now - row.at);
        if (age >= PULSE_WINDOW_MS) break;
        if (!isWork(row.event)) continue;
        const slot = PULSE_SLOTS - 1 - Math.floor(age / PULSE_SLOT_MS);
        counts[slot] = (counts[slot] ?? 0) + 1;
        any = true;
        const kind = markerOf(row.event);
        if (kind) {
            const key = `${slot}:${kind}`;
            const m = marks.get(key);
            if (m) m.n += 1;
            else marks.set(key, { slot, kind, n: 1 });
        }
    }
    const markers = [...marks.values()].sort((a, b) => a.slot - b.slot || PULSE_MARKER_KINDS.indexOf(a.kind) - PULSE_MARKER_KINDS.indexOf(b.kind));
    return { counts, markers, quiet: !any };
}

/** How often the pulse redraws on its own, or `null` for not at all. New rows redraw it anyway, as a prop change. */
export function pulseTickMs(pulse: AgentPulseModel, working: boolean, visible: boolean): number | null {
    if (!visible) return null;
    return working || !pulse.quiet ? PULSE_TICK_MS : null;
}
