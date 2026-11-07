/**
 * HOW LONG A TEST WAITS FOR WHAT IT WROTE TO READ BACK FROM DISK (#1636's sampler, 2026-11-06). vi.waitFor's default is
 * 1 s. On GitHub's Windows runners the disk is shared with the runner's own Storage Service, Windows Update servicing and
 * Defender — the sampler caught a disk queue of 4 to 9 and svchost[StorSvc] busy while a settings write took over 1 s to
 * land (tray-residence:77). The wait is for a write the code under test has already made; 10 s there, 1 s elsewhere,
 * polled every 50 ms. What is asserted does not change.
 */
export const READ_BACK_WAIT = { timeout: process.platform === 'win32' ? 10_000 : 1_000, interval: 50 } as const;
