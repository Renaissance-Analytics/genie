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
 * The GitHub App's public slug, used to build the "install this App on an
 * account" URL. Derived from the App name "Genie IDE". If GitHub assigned a
 * different slug, change it here — it's the only place the slug lives.
 */
export const GENIE_GITHUB_APP_SLUG = 'genie-ide';

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
