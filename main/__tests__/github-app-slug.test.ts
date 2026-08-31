import { describe, expect, it } from 'vitest';
import {
    GENIE_GITHUB_APP_SLUG,
    GENIE_GITHUB_BOT_USER_ID,
    genieInstallUrl,
    genieAppPermissionsUrl,
} from '../config';
import { GENIE_FALLBACK_IDENTITY } from '../workspace/commit-identity';

/**
 * The App's SLUG follows its NAME, and the App was renamed.
 *
 * It was "Genie IDE" (`genie-ide`); it is now "Genie AOS" (`genie-aos`).
 * GitHub re-slugs on rename and does not redirect the old one, so every URL
 * Genie built from the stale constant was a 404 — verified live:
 * `github.com/apps/genie-ide` → 404, `github.com/apps/genie-aos` → 200.
 *
 * That is the worst shape of broken link, because each one is the fix path for
 * something ELSE that is already wrong: "install the App", "add the missing
 * permission". A user sent to a 404 while trying to repair a permission gap has
 * no way forward at all.
 *
 * The bot's login follows the rename too, so the fallback commit identity moves
 * with it. The numeric account id does NOT change — that is why the address is
 * built from the id and the login together.
 */

describe('the GitHub App slug', () => {
    it('is the CURRENT slug, not the pre-rename one', () => {
        expect(GENIE_GITHUB_APP_SLUG).toBe('genie-aos');
        // The old slug 404s. Naming it here means a future rename that forgets
        // this file fails loudly instead of shipping dead links again.
        expect(GENIE_GITHUB_APP_SLUG).not.toBe('genie-ide');
    });

    it('is the single source for every App URL', () => {
        // A second hard-coded copy is how one of these gets updated and the
        // others quietly keep 404ing.
        expect(genieInstallUrl()).toContain(`/apps/${GENIE_GITHUB_APP_SLUG}/`);
        expect(genieAppPermissionsUrl()).toContain(`/apps/${GENIE_GITHUB_APP_SLUG}/`);
        expect(GENIE_FALLBACK_IDENTITY.name).toBe(`${GENIE_GITHUB_APP_SLUG}[bot]`);
    });

    it('builds a noreply address GitHub can resolve to the bot account', () => {
        // `{id}+{login}@users.noreply.github.com`. The ID is what GitHub matches
        // on and does not change on rename; the login must still agree or the
        // commit shows as an unattributed author.
        expect(GENIE_FALLBACK_IDENTITY.email).toBe(
            `${GENIE_GITHUB_BOT_USER_ID}+${GENIE_GITHUB_APP_SLUG}[bot]@users.noreply.github.com`,
        );
        expect(GENIE_FALLBACK_IDENTITY.email).toMatch(/^\d+\+/);
    });

    it('carries the suggested target through the install URL', () => {
        // POSITIVE CONTROL: the URL still has to WORK, not merely contain the
        // right slug.
        expect(genieInstallUrl(1234)).toContain('suggested_target_id=1234');
        expect(genieInstallUrl(null)).not.toContain('suggested_target_id');
    });
});
