/**
 * CLOSE ON SHIP (the owner's choice, 2026-10-21; moic's `issues:close-shipped`). For Genie a merge is not a release: an
 * issue a merged fix names is not in anybody's hands until the release that carries it. At release
 * (.github/workflows/release.yml, scripts/close-shipped.ts) every issue a shipped commit says it FIXES or CLOSES is told
 * "Shipped in vX" and closed if it is still open.
 *
 * ONLY GitHub's closing keywords — fix, fixes, fixed, close, closes, closed, resolve, resolves, resolved — and only for
 * this repository. A passing mention ("same trap as #812", "refs #900", a squash title's "(#1085)") is not a claim that
 * the issue is fixed; closing on any mention would close the wrong issues. A keyword after "not" is a hedge, not a claim.
 */

const KEYWORD = /(?<!\bnot\s)\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gi;

/** The issue numbers the commit messages say they fix or close, in this repository: sorted, each once. */
export function shippedIssues(messages: readonly string[], repo: string): number[] {
    const found = new Set<number>();
    for (const message of messages) {
        for (const match of message.matchAll(KEYWORD)) {
            const other = match[1];
            if (other !== undefined && other.toLowerCase() !== repo.toLowerCase()) continue;
            found.add(Number(match[2]));
        }
    }
    return [...found].sort((a, b) => a - b);
}

/**
 * The release before `current`: the next `v*` tag after it in `tags` (newest first, as `git tag --sort=-creatordate`
 * lists them), or the newest `v*` tag when `current` is not listed. `null` for the first release — nothing to compare.
 */
export function previousReleaseTag(tags: readonly string[], current: string): string | null {
    const releases = tags.filter((t) => /^v\d/.test(t));
    const at = releases.indexOf(current);
    const rest = at === -1 ? releases : releases.slice(at + 1);
    return rest.find((t) => t !== current) ?? null;
}

/** A hidden line in the comment, so a re-run of the same release comments once. */
export const SHIPPED_MARKER = (tag: string): string => `<!-- genie:shipped ${tag} -->`;

/** What a shipped issue is told. */
export function shippedComment(tag: string, repo: string): string {
    return `Shipped in [${tag}](https://github.com/${repo}/releases/tag/${tag}).\n\n${SHIPPED_MARKER(tag)}`;
}
