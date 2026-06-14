import { describe, expect, it } from 'vitest';

import { isQuittingForUpdate, markQuittingForUpdate } from '../quit-state';

/**
 * The "quitting for update" flag is what the before-quit teardown branches on:
 *   - flag UNSET → normal quit → host-backed leaves the host running
 *     (disconnectHostLeaveRunning), in-process kills its own ptys.
 *   - flag SET (auto-updater apply) → host-backed snapshots + KILLS the host so
 *     NSIS can replace the pinned binary.
 *
 * It's a one-way latch: once an update apply is initiated the process is going
 * to quit-and-install, so there's no un-set path (and none is needed).
 */
describe('quit-state', () => {
    it('defaults to false (normal quit) and latches true once marked', () => {
        expect(isQuittingForUpdate()).toBe(false);
        markQuittingForUpdate();
        expect(isQuittingForUpdate()).toBe(true);
    });
});
