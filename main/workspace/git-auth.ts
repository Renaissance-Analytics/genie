/**
 * Token-authenticated clone helpers.
 *
 * When Genie holds a GitHub token (the App device-flow user-to-server token), a
 * recursive clone of a PRIVATE envelope + its private submodules must
 * authenticate over HTTPS with that token — the user needn't have SSH keys or an
 * ambient credential helper configured. These pure helpers build (a) the URL to
 * hand `git clone` and (b) the global `-c` config that authenticates the WHOLE
 * recursive tree (top-level repo + every submodule, whether their URLs are SSH
 * or HTTPS), WITHOUT ever writing the token into a checked-out repo's config.
 *
 * With NO token, the helpers hand the URL back unchanged and add no config, so
 * the caller preserves the exact ambient-auth behavior (SSH agent / credential
 * helper, local `file://` submodules) for users who haven't connected GitHub.
 */

const GITHUB_HTTPS = 'https://github.com/';

/**
 * Rewrite a github.com SSH remote URL to its HTTPS equivalent so a
 * token-authenticated clone can fetch it over HTTPS. Handles both the scp-style
 * (`git@github.com:owner/repo(.git)`) and the `ssh://git@github.com/owner/repo`
 * forms. Any other URL — a non-github host, an already-HTTPS URL, a local path —
 * is returned unchanged (only trimmed): our GitHub token can't and shouldn't
 * rewrite it.
 */
export function githubSshToHttps(url: string): string {
    const trimmed = url.trim();
    const scp = /^git@github\.com:(.+)$/i.exec(trimmed);
    if (scp) return GITHUB_HTTPS + scp[1];
    const ssh = /^ssh:\/\/git@github\.com\/(.+)$/i.exec(trimmed);
    if (ssh) return GITHUB_HTTPS + ssh[1];
    return trimmed;
}

/**
 * Base64 the `x-access-token:<token>` basic-auth credential GitHub expects for
 * an App/OAuth token over HTTPS git. Used to build the extraheader value; the
 * result carries the token, so it is NEVER logged and is scrubbed from surfaced
 * errors (see {@link githubCloneAuth}'s `secrets`).
 */
function basicAuthValue(token: string): string {
    return Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
}

/**
 * The global git `-c` config entries that authenticate a recursive github.com
 * clone with `token`:
 *
 *  - `url.https://github.com/.insteadOf` rewrites SSH submodule URLs (both
 *    scp-style `git@github.com:` and `ssh://git@github.com/`) to HTTPS AT FETCH
 *    TIME, so a submodule pinned to an SSH URL is fetched over HTTPS where the
 *    token applies — without rewriting the URL recorded in `.gitmodules` /
 *    `.git/config`.
 *  - `http.https://github.com/.extraheader` supplies the token as a basic-auth
 *    header for every `https://github.com/` fetch. This is the GitHub-Actions
 *    checkout pattern: passed as a per-command `-c` (never `git config
 *    --local`), git forwards it to submodule fetches via GIT_CONFIG_PARAMETERS
 *    yet it is NEVER persisted into any checked-out repo's config, so the token
 *    can't linger on disk in every submodule's `.git/config`.
 *
 * simple-git applies these via its `config` option — one leading `-c <entry>`
 * per array element, before the git subcommand.
 */
export function githubAuthConfig(token: string): string[] {
    return [
        `url.${GITHUB_HTTPS}.insteadOf=git@github.com:`,
        `url.${GITHUB_HTTPS}.insteadOf=ssh://git@github.com/`,
        `http.${GITHUB_HTTPS}.extraheader=AUTHORIZATION: basic ${basicAuthValue(token)}`,
    ];
}

export interface GitHubCloneAuth {
    /** URL to pass to `git clone` — a github SSH URL rewritten to HTTPS when a
     *  token is present, otherwise the input unchanged (trimmed). */
    url: string;
    /** Global `-c` entries for simple-git's `config` option; `[]` with no token. */
    config: string[];
    /** Secret substrings to scrub from any surfaced error / log; `[]` with no token. */
    secrets: string[];
}

/**
 * Resolve how to clone `rawUrl` given the (possibly absent) GitHub token:
 *
 *  - WITH a token: rewrite a github SSH URL to HTTPS and authenticate the whole
 *    recursive tree over HTTPS with the token (see {@link githubAuthConfig}).
 *  - WITHOUT a token: hand back the trimmed URL and NO config, preserving the
 *    exact ambient-auth behavior (SSH agent / credential helper, local
 *    `file://` submodules) for users who haven't connected GitHub to Genie.
 */
export function githubCloneAuth(
    rawUrl: string,
    token: string | null | undefined,
): GitHubCloneAuth {
    const trimmed = rawUrl.trim();
    if (!token) return { url: trimmed, config: [], secrets: [] };
    return {
        url: githubSshToHttps(trimmed),
        config: githubAuthConfig(token),
        // Scrub BOTH the raw token and its base64 basic-auth form: a leaked
        // error could carry either.
        secrets: [token, basicAuthValue(token)],
    };
}

/**
 * Redact known secrets from a message before it's surfaced or logged.
 * simple-git's GitError can echo the spawned argv — which includes the
 * `-c …extraheader=…` token — so any error from a token-authed clone MUST pass
 * through here first. No-op when `secrets` is empty (the no-token path).
 */
export function redactSecrets(text: string, secrets: string[]): string {
    let out = text;
    for (const s of secrets) {
        if (s) out = out.split(s).join('***');
    }
    return out;
}
