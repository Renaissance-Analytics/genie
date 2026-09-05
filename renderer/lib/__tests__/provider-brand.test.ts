import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS } from '../../../main/agents/registry';
import { providerBrandMark, PROVIDER_BRAND_MARKS } from '../provider-brand';

/**
 * Which BRAND MARK stands for each TUI.
 *
 * The mapping this replaces was placeholder-grade and said so in its own
 * comment: `claude` rendered the TYNN mark, `genie` rendered it too, and `codex`
 * rendered a generic box. Three providers, two of them wearing someone else's
 * logo. The comment even said adding a fourth provider was the moment to fix all
 * of them — this is that fix, prompted by the owner wanting real provider logos
 * in the sidebar avatar stack.
 *
 * `@particle-academy/fancy-brand-icons` supplies the third-party marks
 * (`anthropic`, `openai`) as curated CC0 artwork. Genie's own TUI keeps Genie's
 * own mark, which is the one case where the existing icon was right.
 */
describe('provider brand marks', () => {
    it('gives Claude the Anthropic mark, not Tynn’s', () => {
        expect(providerBrandMark('claude')).toBe('anthropic');
    });

    it('gives Codex the OpenAI mark, not a generic box', () => {
        expect(providerBrandMark('codex')).toBe('openai');
    });

    it('never gives Genie’s TUI the TYNN mark', () => {
        // Different products; the logo is not shared. This is the bug the whole
        // change exists to remove, and it survived the first attempt because the
        // comment said one thing and the table said another.
        expect(PROVIDER_BRAND_MARKS.genie).toBe('genie');
    });

    it('gives a third-party CLI and custom NO borrowed mark', () => {
        // They have none of their own here, and wearing another vendor's asserts
        // a relationship that does not exist. Null means "fall back to the
        // initial", which is honest about not knowing.
        expect(providerBrandMark('kilo')).toBeNull();
        expect(providerBrandMark('custom')).toBeNull();
        expect(providerBrandMark('gemini')).toBeNull();
    });

    /**
     * ANSWERS for every provider — which is the property that matters, and is
     * not the same as an ENTRY for every provider.
     *
     * This used to require a row per provider in the table. That was right while
     * every provider needed a decision; with twenty of them it would have forced
     * seventeen identical `null`s, and a table of near-identical rows is where a
     * wrong one hides. What must never happen is `undefined` reaching the
     * caller, so that is what is asserted.
     */
    it('answers for every provider the registry knows, and never with undefined', () => {
        for (const id of PROVIDER_IDS) {
            const mark = providerBrandMark(id);
            expect(mark === null || typeof mark === 'string', id).toBe(true);
        }
    });

    it('has no provider claiming another’s mark', () => {
        // The exact failure being removed: two providers sharing one logo makes
        // the avatar stack unreadable, which is the whole point of the stack.
        const marks = PROVIDER_IDS.map((id) => PROVIDER_BRAND_MARKS[id]).filter(
            (m): m is string => !!m,
        );
        expect(new Set(marks).size).toBe(marks.length);
    });

    it('falls back rather than guessing for a TUI it does not know', () => {
        // A provider string can reach the renderer from an AGENT.md a human
        // typed. Badging it as Anthropic because that is first in the table
        // would be worse than showing nothing.
        expect(providerBrandMark('not-a-tui')).toBeNull();
    });
});
