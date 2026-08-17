import { describe, expect, it } from 'vitest';
import { GENIE_FALLBACK_IDENTITY, identityToApply } from '../commit-identity';

/**
 * Who a Genie-made commit is attributed to (genie#215).
 *
 * On GitHub, a commit shows an avatar, a profile link and a Follow button only
 * when its email RESOLVES to a GitHub account. `claude` gets that treatment
 * because its `Co-Authored-By` trailer carries an email GitHub maps to a real
 * account; `Genie` did not, because scaffolding an envelope set
 * `user.email=genie@localhost` — an address that belongs to nobody — so GitHub
 * rendered a bare name with no avatar and nothing to click.
 *
 * The fallback itself is fine and has to exist: a fresh install, a CI runner or
 * a sandbox may have no git identity at all, and a commit with no identity
 * fails outright. The bug was applying it UNCONDITIONALLY, overriding the
 * perfectly good identity the machine already had. Two other call sites in the
 * same file already treated it as a fallback; the envelope scaffold did not.
 */
describe('the identity a Genie commit is made under', () => {
    it('uses the machine’s own identity when it has one — that is what GitHub can link', () => {
        const patch = identityToApply({ name: 'Wish Born', email: 'glenn@impactivism.net' });

        // Nothing to set: git already knows who this is, and overriding it is
        // what stripped the avatar off every envelope's first commit.
        expect(patch).toEqual({});
    });

    it('fills in ONLY what is missing', () => {
        expect(identityToApply({ name: 'Wish Born' })).toEqual({
            email: GENIE_FALLBACK_IDENTITY.email,
        });
        expect(identityToApply({ email: 'glenn@impactivism.net' })).toEqual({
            name: GENIE_FALLBACK_IDENTITY.name,
        });
    });

    it('supplies both when the machine has no identity at all', () => {
        // A fresh install / CI runner / sandbox. Without this the commit fails
        // with "Please tell me who you are", which is worse than an unlinkable
        // author.
        expect(identityToApply({})).toEqual(GENIE_FALLBACK_IDENTITY);
    });

    it('treats a blank configured value as missing', () => {
        // `git config user.email ""` reads back as an empty string, and committing
        // with it fails the same way as having none.
        expect(identityToApply({ name: '  ', email: '' })).toEqual(GENIE_FALLBACK_IDENTITY);
    });
});
