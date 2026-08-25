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
