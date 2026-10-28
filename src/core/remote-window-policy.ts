/**
 * WHAT "OPEN" DOES WITH A REMOTE WINDOW THAT ALREADY EXISTS (genie#1278, M0 finding 2).
 *
 * The two-VM proof (2026-10-28): a machine signed out of the owner's account and in as a guest, then pressed Open on a
 * workstation it had opened before. Open only brought forward the OWNER's window — its connection already dropped,
 * its grant the owner's — so nothing connected until the person found Reconnect. Genie 1 did the same: an existing
 * window was only focused (v0.7.0-beta.342 main/workmode/index.ts `openRemoteWindow`).
 *
 * The root cause is that a Tynn relay window was keyed by its target alone, while what it holds — a grant — belongs to
 * the ACCOUNT that minted it. So a relay window carries the account it was opened under:
 *   - an account change closes the relay windows opened under another account (a guest never inherits the owner's live
 *     session — this is the security half, not tidiness);
 *   - Open on a window of this account whose connection has dropped asks it to reconnect, under this account;
 *   - Open on a live window of this account brings it forward, as before.
 * A tailnet window (host and PIN) is not a Tynn grant and is not bound to the Tynn account.
 */

export interface RemoteWindowFacts {
    /** A window for this target is open. */
    readonly exists: boolean;
    /** It is a Tynn relay window (`relay:<id>`), whose connection stands on a Tynn grant. */
    readonly relay: boolean;
    /** Its relay connection is open right now. */
    readonly live: boolean;
    /** The Tynn account it was opened under (`accountKeyOf`), null = signed out then. */
    readonly openedBy: string | null;
    /** The Tynn account this Genie is signed in to now. */
    readonly account: string | null;
}

export type RemoteWindowAction = 'open' | 'focus' | 'reconnect' | 'replace';

export function remoteWindowAction(f: RemoteWindowFacts): RemoteWindowAction {
    if (!f.exists) return 'open';
    if (!f.relay) return 'focus';
    if (f.account === null || f.openedBy !== f.account) return 'replace';
    return f.live ? 'focus' : 'reconnect';
}

/** The relay windows an account change leaves behind: every one opened under an account that is no longer this one. */
export function windowsLeftByAccountChange(windows: ReadonlyArray<{ key: string; relay: boolean; openedBy: string | null }>, account: string | null): string[] {
    return windows.filter((w) => w.relay && (account === null || w.openedBy !== account)).map((w) => w.key);
}

/** Which Tynn account this is: its host and its user, never only one of them. Signed out = null. */
export function accountKeyOf(status: { signedIn: false } | { signedIn: true; host: string; user: { readonly email: string; readonly name?: string } }): string | null {
    return status.signedIn ? `${status.host}#${status.user.email}` : null;
}
