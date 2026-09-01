import { PROVIDER_IDS, type AgentTuiId } from '../../main/agents/registry';

/**
 * The BRAND MARK that stands for each TUI.
 *
 * What this replaces was placeholder-grade and said so in its own comment:
 * `claude` rendered the TYNN mark, `genie` rendered it too, and `codex` rendered
 * a generic box — three providers, two of them wearing someone else's logo. That
 * comment also said adding a fourth provider was the moment to fix all of them.
 * This is that fix, prompted by the sidebar avatar stack, where an unreadable
 * logo defeats the entire point of stacking them.
 *
 * Names resolve through `@particle-academy/fancy-brand-icons`, which layers
 * curated CC0 third-party marks onto the active icon set so a bare
 * `<Icon name="anthropic"/>` renders the real thing. `genie` keeps Genie's own
 * mark — the one case where the existing icon was already right.
 *
 * A user-set avatar overrides all of this; these are only the defaults.
 */
export const PROVIDER_BRAND_MARKS: Record<AgentTuiId, string | null> = {
    claude: 'anthropic',
    codex: 'openai',
    // Genie's own TUI gets GENIE's mark, never Tynn's — different products, and
    // the logo is not shared.
    genie: 'genie',
    // Kiwi and a custom CLI have no mark of their own, and borrowing another
    // vendor's would assert a relationship that does not exist. NULL, so the
    // caller falls back to the agent's initial — honest about being unknown.
    //
    // These three said `'genie'` while the comment above them claimed they fell
    // back to an initial. The comment was the intent; the code was the bug, and
    // it put a borrowed logo on two providers that have none.
    kiwi: null,
    custom: null,
};

/**
 * The mark for a provider string, or null when it is not a TUI we know.
 *
 * Null rather than a default: a provider can reach the renderer from an
 * `AGENT.md` a human typed, and badging an unrecognised one as Anthropic
 * because that happens to be first in the table would be worse than showing
 * nothing.
 */
export function providerBrandMark(provider: string | null | undefined): string | null {
    if (!provider) return null;
    if (!(PROVIDER_IDS as readonly string[]).includes(provider)) return null;
    return PROVIDER_BRAND_MARKS[provider as AgentTuiId] ?? null;
}
