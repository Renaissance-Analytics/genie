import { describe, expect, it } from 'vitest';
import { describeDroppedSiteFields } from '../sites-config';

/**
 * A field the sanitiser REFUSES is currently dropped in silence.
 *
 * `sanitizeDevSitePatch` builds its output by copying only values that pass a
 * check. Anything that fails is simply never assigned — so a caller passing
 * `repo: "repos/thing"` gets a site minted with NO repo, no error, and nothing
 * to read that would explain it.
 *
 * Found while an agent was preparing a GApp: it noticed that the obvious
 * workaround for a layout problem — naming the repo with a path — would "pass
 * the folder check and break hosting instead", silently.
 *
 * THE RULES THEMSELVES ARE CORRECT AND ARE NOT TOUCHED. A repo name becomes a
 * path segment inside the workspace mount, so a separator or `..` there climbs
 * out of it; a `genName` that is not a `*.gen` label would mint a certificate
 * for a name the session must not trust. Those refusals should happen. Only the
 * silence is wrong.
 *
 * So this REPORTS rather than relaxes: the sanitiser keeps its contract (several
 * callers depend on its return type), and this says what a patch would lose so
 * the caller can surface it.
 */
describe('describeDroppedSiteFields', () => {
    it('says nothing about a patch that is entirely acceptable', () => {
        const dropped = describeDroppedSiteFields({ name: 'web', repo: 'my-app', port: 3000 });

        expect(dropped).toEqual([]);
    });

    it('names a repo with a path separator, and says why', () => {
        const dropped = describeDroppedSiteFields({ repo: 'repos/thing' });

        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toContain('repo');
        expect(dropped[0]).toContain('repos/thing');
        // The REASON, not just the rejection — a caller told only "invalid" tries
        // a different spelling of the same illegal thing.
        expect(dropped[0].toLowerCase()).toMatch(/segment|separator|inside/);
    });

    it('names a repo that tries to climb out', () => {
        expect(describeDroppedSiteFields({ repo: '..' })).toHaveLength(1);
        expect(describeDroppedSiteFields({ repo: '../escape' })).toHaveLength(1);
    });

    it('treats an EMPTY repo as deliberate, not as a refusal', () => {
        // `repo: ''` is how a caller says "the workspace root". The sanitiser
        // accepts it, so reporting it as dropped would be a false alarm on a
        // legitimate value.
        expect(describeDroppedSiteFields({ repo: '' })).toEqual([]);
    });

    it('names a genName that is not a .gen label', () => {
        const dropped = describeDroppedSiteFields({ genName: 'evil.example.com' });

        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toContain('genName');
    });

    it('reports EVERY dropped field, not just the first', () => {
        // A caller fixing one and re-submitting only to lose another is the same
        // silence in slow motion.
        const dropped = describeDroppedSiteFields({ repo: 'a/b', genName: 'nope.com' });

        expect(dropped).toHaveLength(2);
    });

    it('survives junk without throwing', () => {
        expect(describeDroppedSiteFields(null)).toEqual([]);
        expect(describeDroppedSiteFields(undefined)).toEqual([]);
        expect(describeDroppedSiteFields({} as never)).toEqual([]);
    });
});
