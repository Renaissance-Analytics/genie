/**
 * Build-time constants baked into the Genie binary.
 *
 * The GitHub App Client ID is intentionally NOT a secret — Device Flow is
 * designed for public clients where the client_id can ship in the binary.
 * The GitHub App's "Enable Device Flow" toggle is what makes Device Flow
 * legal for the client_id; without it, GitHub rejects the device-code
 * request regardless of who's holding the ID.
 *
 * Genie authenticates as a **GitHub App** ("Genie IDE"), not the older
 * OAuth App. GitHub App IDs start with `Iv` (the legacy OAuth App ID
 * started with `Ov`). The difference that matters at runtime: a GitHub
 * App's permissions are fine-grained and declared ON THE APP, not requested
 * as scopes at sign-in, and they only apply to accounts/repos where the App
 * is INSTALLED. So the device flow takes no `scope`, and Genie discovers
 * what it can reach via `GET /user/installations` rather than `/user/orgs`.
 *
 * Replace the value below with the Client ID GitHub assigned to the App.
 * Commit it — that's the point: every Genie installer in the wild needs to
 * Device-Flow against this exact ID.
 *
 * Override at runtime via the Settings → GitHub → "GitHub App Client ID"
 * field. That path stays in for self-hosters and devs who want to point
 * Genie at their own GitHub App without rebuilding.
 */
export const GENIE_GITHUB_CLIENT_ID = 'Iv23liPssWsCpaUIxtIT';

/**
 * The App's client SECRET — required to REFRESH a user token, and empty here.
 *
 * genie#263. GitHub waives the secret for the device_code grant, which is how
 * Genie signs in; it does NOT waive it for the `refresh_token` grant, which
 * shares the same endpoint and is a different grant. A secret-less refresh is
 * answered `incorrect_client_credentials` — the exact value recorded in
 * `github_reauth_detail` on the install that issue was filed from, against a
 * refresh token with five months left. Until this change the refresh call could
 * not send one at all, so no install could recover: re-authenticating succeeds
 * (device grant) and the next refresh fails identically.
 *
 * DELIBERATELY EMPTY, and not the same kind of value as the Client ID above.
 * The ID is public and commits happily. A secret in a desktop binary is not a
 * secret — anyone can read it out of the app — so shipping one is a decision
 * with real consequences, and this file is not the place to make it quietly.
 *
 * TWO WAYS to close the gap, both open:
 *
 *   1. Turn "Expire user authorization tokens" OFF on the App. Then GitHub
 *      issues non-expiring tokens with no refresh token, this path is never
 *      reached, and one Reconnect fixes each install permanently.
 *      `storage.ts`'s {@link TokenSet} already handles that shape. No secret,
 *      no code, and the option this codebase is best placed to take.
 *   2. Supply a secret — per machine via the Settings → GitHub field
 *      ({@link getClientSecret}), or baked in here for a build that accepts the
 *      exposure. Self-hosters pointing Genie at their own App take this one.
 *
 * The plumbing is inert while this is empty; what changes is that the code CAN
 * now send a secret, and says so honestly when it has none to send.
 */
export const GENIE_GITHUB_CLIENT_SECRET = '';

/**
 * The GitHub App's public slug, used to build the "install this App on an
 * account" URL. Derived from the App name "Genie AOS". If GitHub assigned a
 * different slug, change it here — it's the only place the slug lives.
 */
export const GENIE_GITHUB_APP_SLUG = 'genie-aos';

/**
 * The App's numeric ID, and the user ID of the BOT ACCOUNT it commits as.
 *
 * THREE different identifiers name this one App, and mixing them up is the whole
 * of genie#215:
 *
 *   - `GENIE_GITHUB_CLIENT_ID` (`Iv23…`) — what Device Flow authenticates with.
 *     This is the only one the workstation GitHub connection ever needs, which is
 *     why that connection working tells you nothing about the two below.
 *   - `GENIE_GITHUB_APP_ID` (4083762) — the App itself. Used to sign the JWT for
 *     app-level auth. NOT part of any commit address.
 *   - `GENIE_GITHUB_BOT_USER_ID` (294734720) — the `genie-aos[bot]` ACCOUNT
 *     (`GET /users/genie-aos[bot]`). This is the one GitHub's noreply commit
 *     address is built from, and using the App id there produces an address that
 *     resolves to nobody — the exact failure #215 is about.
 */
export const GENIE_GITHUB_APP_ID = 4083762;
export const GENIE_GITHUB_BOT_USER_ID = 294734720;

/**
 * Where to send the user to install the App. With no argument this is the
 * account chooser: GitHub's `installations/new` lists the personal account
 * plus every org the user can install on, then lets them pick repositories.
 *
 * When the caller knows WHICH account the install needs to land on (e.g. the
 * owner of a repo being forked), pass that account's numeric id as
 * `targetId`. GitHub honours `suggested_target_id` to pre-select that account
 * in the chooser — the user still confirms, and the plain chooser is shown if
 * the hint is ignored, so this is a convenience, never load-bearing.
 */
export function genieInstallUrl(targetId?: number | null): string {
    const base = `https://github.com/apps/${GENIE_GITHUB_APP_SLUG}/installations/new`;
    return targetId ? `${base}?suggested_target_id=${targetId}` : base;
}

/**
 * Where the App OWNER adds a missing permission to the App itself. This is the
 * REAL first step when a feature is gated on a permission the App doesn't
 * DECLARE (e.g. `contents`): there's nothing pending to approve on any
 * installation until the owner adds the permission here. GitHub serves the
 * App's permission-settings page at `settings/apps/<slug>/permissions` and
 * redirects to the org-owned variant automatically for an org-owned App.
 *
 * Only the App's owner can open this; for a non-owner it 404s, which is why the
 * resolve flow frames it as "ask the App owner" rather than a self-serve fix.
 */
export function genieAppPermissionsUrl(): string {
    return `https://github.com/settings/apps/${GENIE_GITHUB_APP_SLUG}/permissions`;
}

/**
 * The GitHub page where ONE installation's owner reviews + approves a pending
 * permission update for the App. Each installation has its own page keyed by the
 * INSTALLATION id; GitHub has no "approve for all", so the resolve flow links
 * each missing install to its own page.
 *
 *   - Personal install → `github.com/settings/installations/<id>`
 *   - Org install      → `github.com/organizations/<org>/settings/installations/<id>`
 *     (the org-owned variant; the owner manages org installs there).
 *
 * Falls back to the generic installations list when the installation id is
 * unknown (so the link is never dead).
 */
export function genieInstallationReviewUrl(
    installationId?: number | null,
    orgLogin?: string | null,
): string {
    if (!installationId) return 'https://github.com/settings/installations';
    if (orgLogin) {
        return `https://github.com/organizations/${orgLogin}/settings/installations/${installationId}`;
    }
    return `https://github.com/settings/installations/${installationId}`;
}
