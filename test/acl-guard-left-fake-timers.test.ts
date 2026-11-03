import { afterAll, expect, it, vi } from 'vitest';

/**
 * A FILE THAT ENDS WITH FAKE TIMERS STILL ON. The proof is the file itself: test/setup-acl-guard.ts ends every file by waiting a moment, and that wait used the global setTimeout. Here
 * that never fires, so the old guard failed this file with "Hook timed out" though no test failed and no ACL line was printed. This file passing is the check; nothing in it can fail for
 * that reason on its own, so a probe removes the real timer and watches it go red (scripts/perf-lag/host-split-probes.sh).
 */
it('leaves fake timers on, as a file that forgot to restore them would', () => {
    vi.useFakeTimers();
    expect(vi.isFakeTimers()).toBe(true);
});

// CONTROL: this hook runs before the guard's (hooks run last-registered first), so they really are still on when the guard runs.
afterAll(() => { expect(vi.isFakeTimers()).toBe(true); });
