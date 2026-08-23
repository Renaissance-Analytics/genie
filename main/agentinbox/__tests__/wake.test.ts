import { describe, expect, it } from 'vitest';
import { shouldWakeAgent, wakeNudgeText, WAKE_QUIET_MS, type WakeState } from '../wake';

/**
 * Wake-on-DM decision (issue #9) — the safety-critical core. The invariant under
 * test: it NEVER wakes into a live turn, only a provably-idle prompt, and fails
 * closed on every ambiguous signal. `T` is a turn-end far enough in the past to
 * clear the quiet window; output "since" the turn is the corruption tripwire.
 */
const NOW = 1_000_000;
const OLD_TURN = NOW - WAKE_QUIET_MS - 5_000; // ended well past the quiet window

function state(over: Partial<WakeState> = {}): WakeState {
    return {
        wakeOnDm: true,
        lastTurnEndAt: OLD_TURN,
        lastOutputAt: OLD_TURN - 1_000, // last output was DURING the ended turn
        lastUserInputAt: null,
        lastWokenAt: null,
        now: NOW,
        ...over,
    };
}

describe('shouldWakeAgent — the happy (idle) path', () => {
    it('wakes an opted-in agent that has been idle at its prompt past the window', () => {
        expect(shouldWakeAgent(state())).toBe(true);
    });

    it('wakes when no output was ever recorded but the turn ended long ago', () => {
        expect(shouldWakeAgent(state({ lastOutputAt: null }))).toBe(true);
    });
});

describe('shouldWakeAgent — fail-closed safety gates (NEVER inject mid-turn)', () => {
    it('refuses when not opted in (default OFF)', () => {
        expect(shouldWakeAgent(state({ wakeOnDm: false }))).toBe(false);
    });

    it('refuses when the agent never finished a turn (unknown state)', () => {
        expect(shouldWakeAgent(state({ lastTurnEndAt: null }))).toBe(false);
    });

    it('CORE GATE: refuses while output is still arriving — the agent is mid-turn', () => {
        // Rewritten for the real contract. This used to assert that ANY output
        // after the turn end blocks forever, which killed the feature outright:
        // imDone is called mid-turn, so the turn's own closing paint always lands
        // after `lastTurnEndAt`. What must block is output that has not SETTLED.
        expect(shouldWakeAgent(state({ lastOutputAt: NOW - 1 }))).toBe(false);
    });

    it('refuses on a human keystroke after the turn, with no output at all', () => {
        // The case the old ordering gate caught only by accident, via keystroke
        // ECHO. It is now its own signal, so it holds even for a TUI that echoes
        // nothing — and it no longer depends on the agent having emitted anything.
        expect(
            shouldWakeAgent(state({ lastOutputAt: null, lastUserInputAt: OLD_TURN + 1 })),
        ).toBe(false);
    });

    it('refuses while still inside the quiet window after a turn end (imDone flush tail)', () => {
        const justEnded = NOW - (WAKE_QUIET_MS - 1);
        expect(shouldWakeAgent(state({ lastTurnEndAt: justEnded, lastOutputAt: justEnded - 100 }))).toBe(false);
    });

    it('refuses when output is recent even if the turn-end is old', () => {
        // Output within the quiet window — the agent has not settled.
        const recentOut = NOW - 1_000;
        expect(
            shouldWakeAgent({
                wakeOnDm: true,
                lastTurnEndAt: recentOut, // turn ended right at that output
                lastOutputAt: recentOut,
                lastUserInputAt: null,
                lastWokenAt: null,
                now: NOW,
            }),
        ).toBe(false);
    });

    it('refuses a second wake in the same idle period (already woken since turn-end)', () => {
        expect(shouldWakeAgent(state({ lastWokenAt: OLD_TURN + 100 }))).toBe(false);
    });

    it('allows a wake again after a NEW turn ended past a prior wake', () => {
        // A prior wake, then the agent ran a turn and went idle again (new, later
        // turn-end) → eligible once more.
        const newerTurn = NOW - WAKE_QUIET_MS - 100;
        expect(
            shouldWakeAgent(state({ lastTurnEndAt: newerTurn, lastOutputAt: newerTurn - 50, lastWokenAt: OLD_TURN })),
        ).toBe(true);
    });

    it('is exactly at the boundary: quiet == window is not yet enough (strict >)', () => {
        expect(shouldWakeAgent(state({ lastTurnEndAt: NOW - WAKE_QUIET_MS, lastOutputAt: NOW - WAKE_QUIET_MS - 1 }))).toBe(true);
        // One ms short of the window → refuse.
        expect(shouldWakeAgent(state({ lastTurnEndAt: NOW - WAKE_QUIET_MS + 1, lastOutputAt: NOW - WAKE_QUIET_MS }))).toBe(false);
    });
});

describe('wakeNudgeText', () => {
    it('is a benign, self-describing one-liner (singular/plural)', () => {
        expect(wakeNudgeText(1)).toContain('1 unread AgentInbox message;');
        expect(wakeNudgeText(1)).toContain('receive');
        expect(wakeNudgeText(3)).toContain('3 unread AgentInbox messages;');
        // Never reports zero.
        expect(wakeNudgeText(0)).toContain('1 unread');
    });
});

/**
 * REGRESSION (owner: "the AgentInbox nudges aren't even firing anymore").
 *
 * The old gate was `lastOutputAt <= lastTurnEndAt` — ANY output after the turn
 * end blocked the wake forever. That reads as a safe fail-closed rule, but
 * `markTurnEnd` is called from the imDone MCP handler, i.e. MID-TURN: the TUI
 * then still has to paint the tool result, the agent's closing message and the
 * prompt. That trailing output ALWAYS lands after `lastTurnEndAt`, so the gate
 * latched shut on the very first turn and never reopened.
 *
 * Measured on a live idle Claude Code terminal in this workspace: 0 bytes over
 * ~10 minutes at the prompt, while a mid-turn sibling emitted ~99 KB in the same
 * window. So SILENCE, not output ordering, is what actually separates the two —
 * a working TUI paints its spinner continuously.
 */
describe('shouldWakeAgent — the turn TAIL must not latch the gate shut', () => {
    it('wakes an agent whose TUI painted the turn tail AFTER imDone, then went quiet', () => {
        // imDone at T; the TUI paints for another 1.5s; silence ever since.
        const turnEnd = NOW - 10 * 60_000;
        expect(
            shouldWakeAgent(state({ lastTurnEndAt: turnEnd, lastOutputAt: turnEnd + 1_500 })),
        ).toBe(true);
    });

    it('still REFUSES while the agent is actively painting (mid-turn)', () => {
        // The safety property that must survive the fix: recent output = working.
        const turnEnd = NOW - 10 * 60_000;
        expect(
            shouldWakeAgent(state({ lastTurnEndAt: turnEnd, lastOutputAt: NOW - 200 })),
        ).toBe(false);
    });

    it('refuses when output stopped only just inside the quiet window', () => {
        const turnEnd = NOW - 10 * 60_000;
        expect(
            shouldWakeAgent(
                state({ lastTurnEndAt: turnEnd, lastOutputAt: NOW - (WAKE_QUIET_MS - 1) }),
            ),
        ).toBe(false);
    });

    it('a HUMAN keystroke since the turn ended fails closed — a new turn may be in flight', () => {
        // Keystroke echo used to be caught only accidentally, via output. Now it is
        // its own signal, separate from "the agent is emitting output".
        const turnEnd = NOW - 10 * 60_000;
        expect(
            shouldWakeAgent(
                state({
                    lastTurnEndAt: turnEnd,
                    lastOutputAt: turnEnd + 1_500,
                    lastUserInputAt: turnEnd + 5_000,
                }),
            ),
        ).toBe(false);
    });

    it('a human keystroke from BEFORE the turn ended does not block', () => {
        const turnEnd = NOW - 10 * 60_000;
        expect(
            shouldWakeAgent(
                state({
                    lastTurnEndAt: turnEnd,
                    lastOutputAt: turnEnd + 1_500,
                    lastUserInputAt: turnEnd - 5_000,
                }),
            ),
        ).toBe(true);
    });
});
