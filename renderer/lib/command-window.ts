/**
 * PURE. The Command Window's judgement (Tynn story #247).
 *
 * The palette itself is Fancy's `Command` — `@particle-academy/react-fancy`
 * already exports `Command`/`useCommand`, and Genie already depends on it, so the
 * overlay, the query state, the arrow-key navigation and Enter/Escape are not
 * Genie's to write. What Fancy cannot know is which of GENIE's things are on
 * offer and how a typed query narrows them, which is this file.
 *
 * Kept out of the component because the renderer's test environment has no DOM: a
 * decision inside a component is a decision nobody checks.
 */

import type { FeatureSurface } from './feature-reachability';

/**
 * `action` is a VERB the palette can run, as opposed to a thing it navigates to.
 * It exists because a verb reachable only from a settings panel is not reachable
 * — see the GApp launch entry in master.tsx.
 */
export type CommandCategory = 'workspace' | 'terminal' | 'prompt' | 'panel' | 'action';

export interface CommandItem {
    id: string;
    category: CommandCategory;
    /** What the user reads and what the query matches against. */
    label: string;
    /** Secondary text (a path, a workspace name). Not matched — a hint that
     *  silently changed the results would be worse than no hint. */
    hint?: string;
    /**
     * Set on a FEATURE entry, matching `FEATURE_SURFACES[].id`.
     *
     * It is how `feature-reachability` sees that the palette carries a feature, which is
     * what lets P7 delete a title-bar icon without stranding it.
     */
    featureId?: string;
}

export interface CommandQuery {
    /** The category a complete prefix selected, or null for "search everything". */
    category: CommandCategory | null;
    /** What is left to match on. */
    text: string;
}

/**
 * Type-ahead prefixes. `w> tynn` means "workspaces matching tynn".
 *
 * Every category has one: a category reachable only by scrolling is not reachable
 * at all in a keyboard-first palette.
 */
export const COMMAND_PREFIXES: Record<string, CommandCategory> = {
    w: 'workspace',
    t: 'terminal',
    p: 'prompt',
    s: 'panel',
    a: 'action',
};

/**
 * Split a raw input into a category filter and the text to match.
 *
 * A prefix counts only when COMPLETE — `p>`, not `p`. Someone typing "php" starts
 * with `p`, and swallowing that as a filter makes the palette feel like it is
 * fighting them. An unknown prefix (`z>`) is left as literal text rather than
 * matching nothing: an empty list reads as a broken palette, while a search at
 * least shows something.
 */
export function parseCommandQuery(raw: string): CommandQuery {
    const trimmed = raw.trim();
    const match = /^([A-Za-z])>\s*(.*)$/.exec(trimmed);
    if (!match) return { category: null, text: trimmed };

    const category = COMMAND_PREFIXES[match[1]!.toLowerCase()];
    if (!category) return { category: null, text: trimmed };

    return { category, text: match[2]!.trim() };
}

/**
 * The items to show, in the order they were given.
 *
 * Order is preserved deliberately: a list that re-sorts itself by score as you
 * type moves the row under your cursor, and in a palette driven by Enter that
 * means launching the wrong thing.
 */
export function filterCommandItems(items: readonly CommandItem[], query: CommandQuery): CommandItem[] {
    const needle = query.text.toLowerCase();
    return items.filter((item) => {
        if (query.category && item.category !== query.category) return false;
        if (!needle) return true;
        return item.label.toLowerCase().includes(needle);
    });
}

/** Heading for a group of items, so the list reads as sections not a flat wall. */
export const CATEGORY_HEADINGS: Record<CommandCategory, string> = {
    workspace: 'Workspaces',
    terminal: 'Terminals',
    prompt: 'Prompts',
    panel: 'Panels',
    action: 'Actions',
};

/** The items grouped for rendering, empty groups dropped. */
export function groupCommandItems(
    items: readonly CommandItem[],
): Array<{ category: CommandCategory; heading: string; items: CommandItem[] }> {
    // Actions sit second: they are the things you came to DO, but a saved prompt
    // is the thing people reach for most, and reordering that would move rows
    // under a cursor driven by Enter.
    const order: CommandCategory[] = ['prompt', 'action', 'workspace', 'terminal', 'panel'];
    return order
        .map((category) => ({
            category,
            heading: CATEGORY_HEADINGS[category],
            items: items.filter((i) => i.category === category),
        }))
        .filter((group) => group.items.length > 0);
}

/**
 * Every contracted feature, as palette entries.
 *
 * Built FROM `FEATURE_SURFACES` rather than hand-listed, so a feature cannot be added to
 * the reachability contract and then forgotten here. One source of truth: the contract
 * says what must stay reachable, and this makes the palette the thing that reaches it.
 *
 * Filed under `panel` — which already means "a place it navigates to" and already has the
 * `s>` type-ahead prefix. A new category with no prefix would not be reachable in a
 * keyboard-first palette, so inventing one would be a downgrade.
 */
export function featureCommandItems(features: readonly FeatureSurface[]): CommandItem[] {
    return features.map((f) => ({
        id: `feature:${f.id}`,
        category: 'panel' as const,
        label: f.label,
        featureId: f.id,
        ...(f.entry.contextual ? { hint: f.entry.contextual } : {}),
    }));
}

/**
 * Drop entries that cannot act in the current context.
 *
 * Unscoping the palette from terminal focus is what lets it open on the Deck — and it
 * introduces one defect if done naively. A `prompt` is SENT TO a terminal, and a
 * `terminal` entry is something to FOCUS; with none available both become rows that look
 * live and silently do nothing. A dead row is worse than an absent one, the same reason a
 * disabled control is an accusation while a different shape is a fact.
 *
 * Workspaces, features and actions are unaffected: none of them needs a shell, and the
 * Deck is exactly where someone reaches for Hosts, Knowledge or the App Store.
 */
/**
 * Features that belong to the workstation this window IS, not the one it is driving.
 *
 * The title-bar icons enforced this and nearly took it with them when they were deleted:
 * `onShowSharing` was withheld in a remote window because *"a share link is scoped to the
 * workstation that OWNS the workspace"*, the Hosts button refused to render in a host window at
 * all, and `master.tsx` skips the Genie OS first-run effect there for the same reason. Moving
 * every feature behind ⌘K moved them behind a surface that had no notion of a remote window — so
 * a remote window could have minted a link for the wrong host. `share-workspace-wiring.test.ts`
 * caught it, which is what it was written for.
 */
const LOCAL_ONLY_FEATURES = new Set(['sharing', 'remote-host', 'genie-os']);

/**
 * Features that need a TYNN ACCOUNT, which is optional.
 *
 * Owner decision, asked directly: *"fully local mode — everything local works, Tynn features say
 * 'sign in to use this'."* Until then Tynn was a hard gate on the whole app — signed out,
 * `master.tsx` rendered a sign-in prompt instead of Genie, so a workstation with no account could
 * not open a workspace, run an agent or see the Deck, none of which needs one.
 *
 * These rows are KEPT and ANNOTATED rather than dropped, and the distinction from
 * `LOCAL_ONLY_FEATURES` is the reason: a feature belonging to another machine is nothing a person
 * can act on from here, while signing in is. A dropped row teaches that the feature does not
 * exist, which is the one wrong lesson available.
 */
const TYNN_BACKED_FEATURES = new Set(['sites', 'remote-host', 'issuewatch', 'sharing']);

/** Appended rather than replacing: a contextual hint is a real route and worth more than this. */
const NEEDS_ACCOUNT = 'sign in to Tynn to use this';

export function dropUndeliverable(
    items: readonly CommandItem[],
    ctx: { hasTerminal: boolean; remote?: boolean; tynn?: boolean },
): CommandItem[] {
    const kept = ctx.remote
        ? items.filter((i) => !(i.featureId && LOCAL_ONLY_FEATURES.has(i.featureId)))
        : [...items];

    // `tynn === false` only. Omitted means the caller does not know — a remote window, a test — and
    // marking a row on a guess would be an accusation about an account nobody checked.
    const marked = ctx.tynn === false
        ? kept.map((i) =>
              i.featureId && TYNN_BACKED_FEATURES.has(i.featureId)
                  ? { ...i, hint: i.hint ? `${i.hint} · ${NEEDS_ACCOUNT}` : NEEDS_ACCOUNT }
                  : i,
          )
        : kept;

    if (ctx.hasTerminal) return marked;
    return marked.filter((i) => i.category !== 'prompt' && i.category !== 'terminal');
}
