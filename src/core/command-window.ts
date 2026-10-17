/**
 * THE COMMAND WINDOW'S JUDGEMENT (Tynn #757; Genie 1 story #247 — its renderer/lib/command-window.ts at
 * v0.7.0-beta.342, ported). The palette itself is Fancy's `Command`: the overlay, the query, the arrows and Enter are not
 * Genie's to write. What Fancy cannot know is which of GENIE's things are on offer and how a typed query narrows them,
 * which is this file — pure, so the decisions are tested without a DOM.
 *
 * Genie 2's categories: an agent is a session here, not a terminal, so `t>` (terminals) became `@>` (agents).
 */

export type CommandCategory = 'prompt' | 'action' | 'workspace' | 'agent';

export interface CommandItem {
    readonly id: string;
    readonly category: CommandCategory;
    /** What the person reads and what the query matches against. */
    readonly label: string;
    /** Secondary text (a path, a workspace). NOT matched — a hint that silently changed the results would be worse. */
    readonly hint?: string;
}

export interface CommandQuery {
    /** The category a COMPLETE prefix selected, or null for "search everything". */
    readonly category: CommandCategory | null;
    readonly text: string;
}

/** Type-ahead prefixes: every category has one — a category reachable only by scrolling is not reachable at all. */
export const COMMAND_PREFIXES: Readonly<Record<string, CommandCategory>> = { p: 'prompt', a: 'action', w: 'workspace', '@': 'agent' };

/**
 * A prefix counts only when COMPLETE — `p>`, not `p`: someone typing "php" starts with `p`, and swallowing it as a filter
 * makes the palette fight them. An unknown prefix (`z>`) stays literal text: an empty list reads as a broken palette.
 */
export function parseCommandQuery(raw: string): CommandQuery {
    const trimmed = raw.trim();
    const match = /^([A-Za-z@])>\s*(.*)$/.exec(trimmed);
    if (!match) return { category: null, text: trimmed };
    const category = COMMAND_PREFIXES[match[1]!.toLowerCase()];
    if (!category) return { category: null, text: trimmed };
    return { category, text: match[2]!.trim() };
}

/** The items to show, in the order given: a list that re-sorts as you type moves the row under Enter. */
export function filterCommandItems(items: readonly CommandItem[], query: CommandQuery): CommandItem[] {
    const needle = query.text.toLowerCase();
    return items.filter((item) => (query.category === null || item.category === query.category) && (needle === '' || item.label.toLowerCase().includes(needle)));
}

export const CATEGORY_HEADINGS: Readonly<Record<CommandCategory, string>> = { prompt: 'Prompts', action: 'Actions', workspace: 'Workspaces', agent: 'Agents' };

/** Grouped for rendering, empty groups dropped. Prompts first — the thing people reach for most — then the verbs. */
export function groupCommandItems(items: readonly CommandItem[]): Array<{ category: CommandCategory; heading: string; items: CommandItem[] }> {
    const order: CommandCategory[] = ['prompt', 'action', 'workspace', 'agent'];
    return order
        .map((category) => ({ category, heading: CATEGORY_HEADINGS[category], items: items.filter((i) => i.category === category) }))
        .filter((g) => g.items.length > 0);
}
