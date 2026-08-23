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
 * ## Why the ordering test had to go
 *
 * The original load-bearing signal was `lastOutputAt <= lastTurnEndAt` — the
 * turn ended and NO output has appeared since. It read as the safest possible
 * rule, and it was in fact DEAD: `markTurnEnd` is called from the imDone MCP
 * handler, which runs MID-TURN. After it, the TUI still has to paint the tool
 * result, the agent's closing message and the prompt. That trailing output
 * always lands after `lastTurnEndAt`, so the gate latched shut on the very first
 * turn and never reopened — a fail-safe that failed all the way to a dead
 * feature, silently.
 *
 * ## What replaces it: SILENCE, and a separate signal per meaning
 *
 * Measured on live terminals: an idle Claude Code agent emitted 0 bytes over ten
 * minutes at its prompt, while a mid-turn sibling emitted ~99 KB in the same
 * window — a working TUI repaints its spinner continuously. So sustained
 * silence, not output ordering, is what actually distinguishes them.
 *
 * The old rule also conflated two very different things behind one timestamp:
 *
 *   - "the agent is mid-turn emitting output" → {@link WakeState.lastOutputAt},
 *     which must still block absolutely; and
 *   - "a human is typing at an idle prompt" → {@link WakeState.lastUserInputAt},
 *     which used to be caught only by accident, through keystroke ECHO.
 *
 * They are now separate inputs. Plus a conservative quiet window and a
 * one-wake-per-idle-period guard. Pure so every branch is unit-tested.
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
    /** Epoch ms of the last REAL human keystroke at this terminal, or null. Not
     *  the emulator's replies — see `containsHumanInput` in ./notify. */
    lastUserInputAt: number | null;
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
    // The turn must have ended at least the quiet window ago (skip the imDone
    // output-flush tail, and require sustained quiet).
    if (s.now - s.lastTurnEndAt < WAKE_QUIET_MS) return false;
    // THE MID-TURN TRIPWIRE. A working agent's TUI paints continuously — its
    // spinner, elapsed clock and status footer — so an unbroken quiet window is
    // what proves the turn actually stopped. Output that arrived just after
    // imDone is the ENDING turn's own tail and is allowed to have happened; what
    // is never allowed is output that has not yet settled.
    const quietSince = s.lastOutputAt ?? s.lastTurnEndAt;
    if (s.now - quietSince < WAKE_QUIET_MS) return false;
    // A human keystroke since the turn ended may have started a NEW turn that has
    // not painted anything yet, and in any case means someone is at this prompt.
    // Fail closed — the sender still sees the DM unseen in read-receipts.
    if (s.lastUserInputAt != null && s.lastUserInputAt > s.lastTurnEndAt) return false;
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
