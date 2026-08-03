/**
 * PURE. The authentication + git-safety DEFAULTS every production BUILD gets
 * (genie #119).
 *
 * A hosted site's build runs by `exec`ing into the workspace's long-lived
 * sandbox container (see `site-build.ts`), and two things there break a build
 * that works everywhere else:
 *
 *  1. **Dubious ownership.** The build runs as a uid that does not own the
 *     bind-mounted repo, so modern git refuses every command in it —
 *     `fatal: detected dubious ownership in repository at '/workspace/repos/…'`
 *     — and `composer install` dies at its first `git show-ref`. Marking the
 *     repo a `safe.directory` (for ANY owner, `*`) is git's sanctioned way to
 *     say "this mount is trusted", and injecting it through the environment
 *     (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`) applies it
 *     process-wide WITHOUT writing anything into the checked-out repo's config.
 *     This is unconditional — it is needed even for a build that never
 *     authenticates.
 *
 *  2. **Unauthenticated github.com.** Once git works, composer and npm fetch
 *     dist tarballs from github.com; unauthenticated they are rate-limited into
 *     `Could not authenticate against github.com` failures en masse. When Genie
 *     holds a managed token (the App device-flow user-to-server token — the same
 *     one `git-auth.ts`/`github/api.ts` resolve for clones), it is injected as
 *     `COMPOSER_AUTH` (what composer reads) and `GITHUB_TOKEN` (what npm's git
 *     deps read). With NO token, NEITHER is injected and the build proceeds on
 *     public access — degrading gracefully rather than failing to start.
 *
 * ## Layered UNDER the user's env, and never surfaced
 *
 * The caller merges this env beneath the site's own `env`, so a value the user
 * pinned always wins (these are defaults, not overrides). And the token is a
 * secret: {@link BuildAuth.secrets} carries it back so the caller can scrub it
 * from the build log — which the UI shows verbatim — exactly as
 * `git-auth.ts`'s `redactSecrets` scrubs it from a clone error.
 *
 * ## Build-only
 *
 * This env is for the BUILD stage alone. It is never persisted into the serving
 * container (whose env is inspectable), never written to the repo's
 * `.git/config` or `.env`.
 */

/**
 * The env that marks the bind-mounted repo a git `safe.directory`, defeating the
 * dubious-ownership refusal. Unconditional — returned even with no token.
 *
 * `safe.directory=*` trusts a repo of ANY owner: the build container's uid is
 * not knowable here, and the mount is already inside the workspace sandbox, so a
 * wildcard is the right scope. Passed as git's `GIT_CONFIG_COUNT` environment
 * protocol so nothing is written to disk.
 */
const GIT_SAFE_DIRECTORY_ENV: Readonly<Record<string, string>> = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
};

export interface BuildAuth {
    /** The build-env defaults: git safe.directory always, plus COMPOSER_AUTH +
     *  GITHUB_TOKEN when a token was supplied. Merged UNDER the site's own env. */
    env: Record<string, string>;
    /** Secret substrings to scrub from any surfaced/captured build output.
     *  `[]` when there is no token. */
    secrets: string[];
}

/**
 * The build-env defaults for `token` (the managed GitHub token, or absent).
 *
 *  - Always: the git safe.directory triplet.
 *  - With a token: `COMPOSER_AUTH={"github-oauth":{"github.com":"<token>"}}` and
 *    `GITHUB_TOKEN=<token>`, plus the token as a secret to scrub.
 *  - Without one (null / undefined / blank): neither auth var, and no secrets —
 *    a public-only build that still works up to GitHub's anonymous rate limit.
 */
export function buildAuthEnv(token?: string | null): BuildAuth {
    const env: Record<string, string> = { ...GIT_SAFE_DIRECTORY_ENV };

    const trimmed = token?.trim();
    if (!trimmed) return { env, secrets: [] };

    const composerAuth = JSON.stringify({ 'github-oauth': { 'github.com': trimmed } });
    env.COMPOSER_AUTH = composerAuth;
    env.GITHUB_TOKEN = trimmed;
    // Scrub BOTH the raw token (covers GITHUB_TOKEN and the value inside
    // COMPOSER_AUTH) and the whole COMPOSER_AUTH blob, in case a tool echoes it
    // verbatim.
    return { env, secrets: [trimmed, composerAuth] };
}
