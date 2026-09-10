import { safeStorage } from 'electron';
import {
    SECRET_SERVICE_NAME,
    probeOwnedBusNames,
    type KeychainHintInput,
} from './linux-password-store';

/**
 * The live facts behind "secrets can't be encrypted right now", read once and
 * shared by everything that has to explain it (genie#588).
 *
 * Two surfaces used to ask this question and only one of them could answer it:
 * the GitHub panel probed the bus and named the selected store, while the remote
 * pairing prompt had nothing but a boolean and told every user their computer's
 * keychain was unavailable — including the ones whose keychain was fine and
 * whose Genie had simply failed to select it. One reader means they cannot drift
 * apart again.
 *
 * Cached briefly because the pairing prompt and `github:status` are both polled
 * while a flow is on screen and {@link probeOwnedBusNames} spawns a process. A
 * session's bus state does not change on that timescale; a keyring the user just
 * started is noticed within the TTL.
 */

const TTL_MS = 10_000;
let cache: { at: number; state: KeychainHintInput } | null = null;

/** Which store Electron says this process ended up on (Linux only, and only
 *  meaningful after app-ready — before that it answers `'unknown'`). */
export function selectedKeychainBackend(): string | null {
    if (process.platform !== 'linux') return null;
    try {
        // Linux-only Electron API; absent on other platforms and older builds.
        const get = (safeStorage as { getSelectedStorageBackend?: () => string })
            .getSelectedStorageBackend;
        return typeof get === 'function' ? (get.call(safeStorage) ?? null) : null;
    } catch {
        /* a diagnostic must never throw into the caller */
        return null;
    }
}

/** Everything {@link classifyKeychainFault} / {@link keychainUnavailableHint}
 *  need about this machine right now. */
export function currentKeychainState(): KeychainHintInput {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.state;
    let secretServiceOwned = false;
    try {
        secretServiceOwned =
            process.platform === 'linux' &&
            probeOwnedBusNames([SECRET_SERVICE_NAME]).includes(SECRET_SERVICE_NAME);
    } catch {
        /* no bus / no tooling — treated as "nothing is answering" */
    }
    const state: KeychainHintInput = {
        platform: process.platform,
        desktop: process.env.XDG_CURRENT_DESKTOP,
        secretServiceOwned,
        selectedBackend: selectedKeychainBackend(),
    };
    cache = { at: Date.now(), state };
    return state;
}

/** Drop the cache (tests, and after anything that could change the answer). */
export function resetKeychainStateCache(): void {
    cache = null;
}
