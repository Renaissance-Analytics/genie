import type { BackendUser } from './genie';

/**
 * IS THERE A TYNN ACCOUNT — answered without ever being able to block the app.
 *
 * ## Why this is its own module
 *
 * Owner decision, asked directly on 2026-10-08: *"fully local mode — everything local works, Tynn
 * features say 'sign in to use this'."* The sign-in wall came down — `master.tsx` no longer returns
 * `SignInPrompt` instead of the app — but the gate IN FRONT of it stayed:
 *
 * ```ts
 * const [t, tHost] = await Promise.all([api().auth.whoami('tynn'), api().tynnHost.get()]);
 * ```
 *
 * No catch, no timeout, and `setAuthChecked(true)` after it. The window renders
 * *"Checking sign-in…"* until that flag flips, so a REJECTED probe leaves Genie on that screen for
 * good. Offline, a misconfigured `tynnHost`, Tynn down for maintenance: the account is optional and
 * the window still never opens. The same wall reached by failure instead of by being signed out —
 * which is worse, because being signed out at least looked deliberate.
 *
 * ## The rule, and why it inverts this codebase's usual one
 *
 * **A failed probe means NOT SIGNED IN, never UNKNOWN.** The session model is emphatic in the other
 * direction — `null` is "cannot see", `[]` is "none", never a confident zero — so the difference is
 * worth naming. That rule protects a human from a number Genie invented. This answer is never shown
 * as a number; it decides whether four palette rows say *"sign in to Tynn to use this"* and whether
 * the system menu offers sign-in. For a probe that failed, that sentence is true and that route is
 * the right next step. **Guessing wrong costs a hint; refusing to guess costs the app.**
 *
 * The two reads also fail INDEPENDENTLY — the host is a local settings read, the account is a
 * network call — so `Promise.all` rejecting the pair on either threw away a good answer for an
 * unrelated reason. Settled one at a time.
 */

/** Where Tynn lives when nothing better is known. Never `''`: a blank base URL builds requests
 *  against the renderer's own origin, which 404s in a way that reads as Tynn being broken. */
export const TYNN_HOST_FALLBACK = 'https://tynn.ai';

export interface AuthProbePorts {
    /** `api().auth.whoami('tynn')`. */
    whoami: () => Promise<BackendUser | null>;
    /** `api().tynnHost.get()`. */
    host: () => Promise<string>;
}

export interface AuthProbe {
    signedIn: boolean;
    /** The account's NAME, for the menu — a workstation can be signed into the wrong account and
     *  nothing else in the window says so. Null when there is no account to name. */
    name: string | null;
    host: string;
}

/** Call a port and settle it, whatever it does — including throwing synchronously, which is why
 *  the call itself is inside the `try` rather than only the `await`. */
async function settled<T>(call: () => Promise<T>, fallback: T): Promise<T> {
    try {
        return await call();
    } catch {
        return fallback;
    }
}

export async function probeTynnAuth(ports: AuthProbePorts): Promise<AuthProbe> {
    const [user, host] = await Promise.all([
        settled(ports.whoami, null),
        settled<unknown>(ports.host, TYNN_HOST_FALLBACK),
    ]);
    return {
        signedIn: !!user,
        name: user?.name ?? null,
        host: typeof host === 'string' && host.trim() !== '' ? host : TYNN_HOST_FALLBACK,
    };
}
