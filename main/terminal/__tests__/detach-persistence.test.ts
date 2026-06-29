import { describe, expect, it } from 'vitest';
import { shouldKillOnDetach } from '../ipc';

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
