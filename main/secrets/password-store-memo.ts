import fs from 'node:fs';
import path from 'node:path';
import {
    isRememberablePasswordStore,
    switchValueForSelectedBackend,
} from './linux-password-store';

/**
 * The Chromium password store Genie has SEEN working on this machine, kept
 * across launches (genie#588).
 *
 * Selecting a backend on Linux had exactly one input: a `busctl` / `dbus-send`
 * probe of the session bus, run before app-ready. That probe is a subprocess,
 * and when it answers nothing there is no way to tell "this machine has no
 * keyring" (where forcing a backend would be wrong) from "the probe could not
 * run" (where not forcing one is the bug). The reported machine is the second:
 * its keyring is healthy — the default collection unlocked, `secret-tool`
 * round-tripping, `gh` keeping its token there — and Genie still lands on the
 * plaintext store and blames the computer's keychain.
 *
 * Electron knows the answer with no subprocess at all:
 * `safeStorage.getSelectedStorageBackend()` reports which store the running
 * process ended up on. On any launch that reached a real backend — because a
 * `.desktop` entry passed the flag, because the probe worked once, because the
 * desktop was one Chromium recognises — that report is written here, and every
 * later launch re-asserts it. Which is what makes the fix survive a self-restart
 * that re-execs with an EMPTY argv (electron-updater's AppImage install spawns
 * the new binary with no arguments at all).
 *
 * Only ever WRITTEN from a launch that worked: a launch on the plaintext store
 * reports `basic_text`, and recording that would make the failure permanent.
 */

/** Lives beside the other small userData JSON stores (remote tokens, hosts). */
const MEMO_FILE = 'linux-password-store.json';

function memoPath(userDataDir: string): string {
    return path.join(userDataDir, MEMO_FILE);
}

/**
 * The remembered `--password-store` value, or null when there isn't a usable
 * one. Runs BEFORE app-ready on every Linux launch, so it must be cheap and
 * must never throw — a missing, empty, corrupt or unrecognised memo is simply
 * no memo.
 */
export function readRememberedPasswordStore(userDataDir: string): string | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(memoPath(userDataDir), 'utf8')) as {
            store?: unknown;
        };
        return isRememberablePasswordStore(parsed?.store) ? parsed.store : null;
    } catch {
        return null;
    }
}

/**
 * Record the backend this launch is actually using, given Electron's own
 * `safeStorage.getSelectedStorageBackend()` value.
 *
 * A no-op unless that value maps to a real backend — `basic_text` and `unknown`
 * are the states this memo exists to escape, and clearing a good memo on a
 * launch that failed to select anything would throw away the only evidence of
 * what works here.
 */
export function rememberPasswordStore(
    userDataDir: string,
    selectedBackend: string | null | undefined,
): void {
    const store = switchValueForSelectedBackend(selectedBackend);
    if (!store) return;
    if (readRememberedPasswordStore(userDataDir) === store) return;
    try {
        fs.writeFileSync(memoPath(userDataDir), JSON.stringify({ store }), 'utf8');
    } catch {
        /* best-effort: an unwritable userData dir must not break a launch */
    }
}
