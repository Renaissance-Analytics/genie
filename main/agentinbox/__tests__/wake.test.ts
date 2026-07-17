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

    it('CORE GATE: refuses when ANY output appeared since the turn ended (a new turn started)', () => {
        expect(shouldWakeAgent(state({ lastOutputAt: OLD_TURN + 1 }))).toBe(false);
    });

    it('refuses on a human keystroke echo after the turn (output just past turn-end)', () => {
        // Even a single output byte 1ms after the turn ended gates the wake out.
        expect(shouldWakeAgent(state({ lastOutputAt: OLD_TURN + 1, now: NOW + 100 }))).toBe(false);
    });

    it('refuses while still inside the quiet window after a turn end (imDone flush tail)', () => {
        const justEnded = NOW - (WAKE_QUIET_MS - 1);
        expect(shouldWakeAgent(state({ lastTurnEndAt: justEnded, lastOutputAt: justEnded - 100 }))).toBe(false);
    });

    it('refuses when output is recent even if the turn-end is old', () => {
        // lastOutputAt <= lastTurnEndAt (no new turn) but within the quiet window.
        const recentOut = NOW - 1_000;
        expect(
            shouldWakeAgent({
                wakeOnDm: true,
                lastTurnEndAt: recentOut, // turn ended right at that output
                lastOutputAt: recentOut,
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
