/**
 * PURE. Which git identity a Genie-made commit should be authored under
 * (genie#215).
 *
 * ## Why this is worth a module
 *
 * GitHub renders an avatar, a profile link and a Follow button beside a commit
 * author only when the commit's EMAIL resolves to a GitHub account. `claude`
 * gets that because its `Co-Authored-By` trailer carries an address GitHub maps
 * to a real account. `Genie` did not, because scaffolding an envelope set
 * `user.email=genie@localhost` unconditionally — an address that belongs to
 * nobody — so every envelope's first commit showed a bare, unclickable name even
 * on machines with a perfectly good identity configured.
 *
 * The fallback has to exist: a fresh install, a CI runner or a sandbox may have
 * no git identity, and committing without one fails outright with "Please tell
 * me who you are". The bug was applying it over an identity that was already
 * there. Two other call sites in `create-agi.ts` already had this right; the
 * scaffold path did not, and this puts the rule in one place so they cannot
 * drift again.
 *
 * ## What this does NOT do
 *
 * Give Genie its own linkable identity. That needs an address tied to a real
 * GitHub account — a `genie[bot]` App identity
 * (`<app-id>+genie[bot]@users.noreply.github.com`) or a dedicated machine user —
 * and neither exists yet. Until one does, attributing to the human whose machine
 * made the commit is both accurate and linkable, which is strictly better than
 * an address that resolves to nothing.
 */

/** Name/email as git reports them; either may be absent or blank. */
export interface GitIdentity {
    name?: string;
    email?: string;
}

/**
 * Used ONLY when the machine has nothing. Deliberately a `.localhost` address:
 * it is unmistakably not a real mailbox, so it can never collide with a person's
 * account, and it makes an unattributable commit obvious rather than plausible.
 */
export const GENIE_FALLBACK_IDENTITY = {
    name: 'Genie',
    email: 'genie@localhost',
} as const;

const missing = (v: string | undefined): boolean => !v || v.trim() === '';

/**
 * The identity fields to SET, given what git already has — `{}` when the machine
 * is already configured.
 *
 * A blank configured value counts as missing: `git config user.email ""` reads
 * back as an empty string and fails a commit exactly as an absent one does.
 */
export function identityToApply(existing: GitIdentity): Partial<GitIdentity> {
    const patch: Partial<GitIdentity> = {};
    if (missing(existing.name)) patch.name = GENIE_FALLBACK_IDENTITY.name;
    if (missing(existing.email)) patch.email = GENIE_FALLBACK_IDENTITY.email;

    return patch;
}
