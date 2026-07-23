import { describe, expect, it } from 'vitest';
import { resolveBindingMode } from '../genie';

/**
 * genie#50 — a REMOTE (Work-Mode host) window's file reads were running on the
 * Windows CLIENT against the host's POSIX path, producing `stat 'C:\data\…'`
 * ENOENT on a Linux host. Root cause: `ensureRemoteBinding`'s async `myBinding()`
 * confirm could flip a URL-confirmed `?host=` window back to LOCAL on a transient
 * / mismatched main binding, after which `api()` returned the local bridge and
 * `api().files.read` hit the local `files:read` IPC (`path.win32` resolve).
 *
 * The fix: a URL host window is authoritatively remote for its whole lifetime —
 * the async confirm may only CORRECT a no-hint window that main says is remote
 * (local → remote), never turn a host window local.
 */
describe('resolveBindingMode (remote binding — genie#50)', () => {
    it('keeps a URL host window (?host=) REMOTE even when main transiently reports local', () => {
        expect(resolveBindingMode(true, 'local')).toBe('remote');
        expect(resolveBindingMode(true, 'remote')).toBe('remote');
    });

    it('follows main’s authoritative binding for a no-hint (non-host) window', () => {
        // local → remote correction is allowed; a genuine local stays local.
        expect(resolveBindingMode(false, 'remote')).toBe('remote');
        expect(resolveBindingMode(false, 'local')).toBe('local');
    });
});
