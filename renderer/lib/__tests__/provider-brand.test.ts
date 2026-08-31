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

    it('gives kiwi and custom NO borrowed mark', () => {
        // They have none of their own, and wearing another vendor's asserts a
        // relationship that does not exist. Null means "fall back to the initial".
        expect(PROVIDER_BRAND_MARKS.kiwi).toBeNull();
        expect(PROVIDER_BRAND_MARKS.custom).toBeNull();
        expect(providerBrandMark('kiwi')).toBeNull();
    });

    it('covers every provider the registry knows', () => {
        // The registry is the source of truth for what a provider IS. A provider
        // added there and missed here would render as a blank avatar in the
        // stack, which reads as "no agent" rather than "unknown TUI".
        for (const id of PROVIDER_IDS) {
            expect(id in PROVIDER_BRAND_MARKS, id).toBe(true);
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
