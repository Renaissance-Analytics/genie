import { describe, expect, it } from 'vitest';
import { shouldKillOnDetach, refuseRetainForCap } from '../ipc';

/**
 * Persistence contract: closing a Genie WINDOW must never kill the backend pty —
 * the detached host keeps it alive so a reopened window re-attaches the live
 * session. Only a deliberate per-panel detach of a non-retained terminal kills.
 */
describe('shouldKillOnDetach', () => {
    it('a window CLOSE never kills, even a non-retained pty (the bug fix)', () => {
        expect(
            shouldKillOnDetach({ lastOwner: true, retained: false, fromWindowClose: true }),
        ).toBe(false);
    });

    it('a window close never kills a retained pty either', () => {
        expect(
            shouldKillOnDetach({ lastOwner: true, retained: true, fromWindowClose: true }),
        ).toBe(false);
    });

    it('a DELIBERATE detach kills a non-retained pty (last owner) — unchanged', () => {
        expect(
            shouldKillOnDetach({ lastOwner: true, retained: false, fromWindowClose: false }),
        ).toBe(true);
    });

    it('a deliberate detach leaves a RETAINED (suspended) pty alive', () => {
        expect(
            shouldKillOnDetach({ lastOwner: true, retained: true, fromWindowClose: false }),
        ).toBe(false);
    });

    it('EYEBALL-HIDE: retaining before the hide-detach keeps the pty + agent alive', () => {
        // The hide path sets retained=true BEFORE the panel unmounts, so the
        // unmount's deliberate detach (lastOwner, not a window close) does NOT kill
        // — the shell/agent survives windowless. Without the retain it would kill.
        expect(
            shouldKillOnDetach({ lastOwner: true, retained: true, fromWindowClose: false }),
        ).toBe(false);
        expect(
            shouldKillOnDetach({ lastOwner: true, retained: false, fromWindowClose: false }),
        ).toBe(true);
    });

    it('never kills while other windows are still attached', () => {
        for (const fromWindowClose of [true, false]) {
            for (const retained of [true, false]) {
                expect(
                    shouldKillOnDetach({ lastOwner: false, retained, fromWindowClose }),
                ).toBe(false);
            }
        }
    });
});

/**
 * The MAX_RETAINED cap governs how many windowless-but-alive (retained) ptys may
 * exist. AGENT terminals are exempt so the owner can hide MANY live agents; plain
 * terminals are still capped among themselves.
 */
describe('refuseRetainForCap', () => {
    const max = 8;

    it('NEVER refuses an agent terminal, even far past the cap', () => {
        expect(
            refuseRetainForCap({
                isAgent: true,
                alreadyRetained: false,
                nonAgentRetainedCount: 999,
                max,
            }),
        ).toBe(false);
    });

    it('never refuses an already-retained terminal (idempotent)', () => {
        expect(
            refuseRetainForCap({
                isAgent: false,
                alreadyRetained: true,
                nonAgentRetainedCount: 999,
                max,
            }),
        ).toBe(false);
    });

    it('allows a plain terminal while under the cap', () => {
        expect(
            refuseRetainForCap({
                isAgent: false,
                alreadyRetained: false,
                nonAgentRetainedCount: max - 1,
                max,
            }),
        ).toBe(false);
    });

    it('refuses a plain terminal at/over the cap', () => {
        expect(
            refuseRetainForCap({
                isAgent: false,
                alreadyRetained: false,
                nonAgentRetainedCount: max,
                max,
            }),
        ).toBe(true);
    });

    it('agents are uncounted: a plain terminal is judged only by NON-agent retained count', () => {
        // Even with many agents retained, a plain terminal is allowed as long as
        // the non-agent retained count is under the cap (the caller excludes agents
        // from the count it passes).
        expect(
            refuseRetainForCap({
                isAgent: false,
                alreadyRetained: false,
                nonAgentRetainedCount: 2, // agents not included here
                max,
            }),
        ).toBe(false);
    });
});
