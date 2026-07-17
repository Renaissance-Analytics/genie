/**
 * Opt-in WAKE-ON-DM decision (issue #9) — the FAIL-SAFE core.
 *
 * AgentInbox delivery is pull-based: nothing is ever injected into a running
 * agent, so an in-flight turn can't be corrupted. The gap: an IDLE agent never
 * polls, so a governing agent can't reach a dormant child. Wake-on-DM closes it
 * by submitting a tiny nudge to a genuinely-idle agent's TUI — but injecting into
 * a MIS-detected mid-turn agent would re-introduce the exact pty-race the design
 * avoids. So this decision errs HARD toward NOT waking:
 *
 *   - A missed wake is harmless — the sender still sees the DM unseen via read-
 *     receipts and can nudge manually.
 *   - A wrong wake corrupts a live agent.
 *
 * The load-bearing signal is `lastOutputAt <= lastTurnEndAt`: the agent's last
 * turn ENDED (it called imDone), and NO output has appeared since. A new turn —
 * or even a human typing at the prompt (keystroke echo is output) — pushes
 * `lastOutputAt` past `lastTurnEndAt` and gates the wake out. This can only fail
 * toward not-waking (if the TUI emits any idle redraw, we simply don't wake),
 * NEVER into a live turn. Plus a conservative quiet window and a one-wake-per-idle
 * -period guard. Pure so every branch is unit-tested.
 */

/** Minimum quiet time (ms) since the turn ended before a wake — a margin past the
 *  imDone output flush, and long enough that a genuinely-working turn would have
 *  emitted SOMETHING. Conservative on purpose. */
export const WAKE_QUIET_MS = 15_000;

export interface WakeState {
    /** The agent opted in (default OFF — no surprise turns). */
    wakeOnDm: boolean;
    /** Epoch ms the agent's last turn ended (imDone). null = never finished a turn. */
    lastTurnEndAt: number | null;
    /** Epoch ms of the agent terminal's last output byte. null = no output seen. */
    lastOutputAt: number | null;
    /** Epoch ms we last woke this agent. null = never. */
    lastWokenAt: number | null;
    /** Now (epoch ms). */
    now: number;
}

/**
 * Should a DM to this agent inject a wake nudge? True ONLY when the agent is
 * provably idle at its prompt (see the module doc). Fail-closed on any missing or
 * ambiguous signal.
 */
export function shouldWakeAgent(s: WakeState): boolean {
    // Opt-in only.
    if (!s.wakeOnDm) return false;
    // Never finished a turn → we don't know it's at a prompt. Don't touch it.
    if (s.lastTurnEndAt == null) return false;
    // ANY output since the turn ended means a new turn (or a human typing) began
    // — NOT idle. This is the core safety gate; fail closed.
    if (s.lastOutputAt != null && s.lastOutputAt > s.lastTurnEndAt) return false;
    // The turn must have ended at least the quiet window ago (skip the imDone
    // output-flush tail, and require sustained quiet).
    if (s.now - s.lastTurnEndAt < WAKE_QUIET_MS) return false;
    // And no output at all within the quiet window (belt-and-suspenders with the
    // gate above, in case lastOutputAt is null).
    const quietSince = s.lastOutputAt ?? s.lastTurnEndAt;
    if (s.now - quietSince < WAKE_QUIET_MS) return false;
    // One wake per idle period — don't re-nudge an agent we already woke since its
    // last turn ended (it's now processing our nudge, or chose not to).
    if (s.lastWokenAt != null && s.lastWokenAt >= s.lastTurnEndAt) return false;
    return true;
}

/** The canned nudge submitted to a woken agent — benign + self-describing, so a
 *  turn it starts is obviously an AgentInbox wake, not smuggled instructions. */
export function wakeNudgeText(unread: number): string {
    const n = Math.max(1, unread);
    return `You have ${n} unread AgentInbox message${n === 1 ? '' : 's'}; read ${
        n === 1 ? 'it' : 'them'
    } with the agentinbox tool (action: "receive").`;
}
