import { Command } from '@particle-academy/react-fancy';
import { useEffect, useMemo, useState } from 'react';
import { filterCommandItems, firstMatch, groupCommandItems, parseCommandQuery, type CommandItem } from '../../core/command-window.js';

/**
 * CTRL/CMD+K — THE COMMAND WINDOW (Tynn #757; Genie 1's GenieCommandWindow). Fancy's `Command` draws it (in a portal on
 * <body>) and keeps the input, the active row and the keys; `core/command-window.ts` decides what is on offer for a
 * query. `shouldFilter={false}` (react-fancy 5.40.0, asked for by Genie): Genie filters for itself — a prefixed query
 * (`w> tynn`) is never a substring of an item's text — and reads the query through `query` / `onQueryChange`.
 */
export interface CommandWindowProps {
    readonly open: boolean;
    readonly items: readonly CommandItem[];
    readonly onClose: () => void;
    /** The person chose an item (Enter or click); the window closes after. */
    readonly onActivate: (item: CommandItem) => void;
}

export function CommandWindow({ open, items, onClose, onActivate }: CommandWindowProps) {
    const [query, setQuery] = useState('');
    const groups = useMemo(() => groupCommandItems(filterCommandItems(items, parseCommandQuery(query))), [items, query]);
    const close = (): void => { setQuery(''); onClose(); };
    // ENTER IN THE SEARCH BOX opens the first match (core/command-window `firstMatch`): Fancy's Command takes Enter only on
    // a focused item. An item the arrows focused keeps its own Enter (a button's click) — this is the box's alone.
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent): void => {
            const box = e.target as HTMLInputElement | null;
            if (e.key !== 'Enter' || !box || box.tagName !== 'INPUT' || !box.placeholder.startsWith('Search prompts')) return;
            const first = firstMatch(items, query);
            if (!first) return;
            e.preventDefault();
            onActivate(first);
            close();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    });
    if (!open) return null;
    const shown = groups.reduce((n, g) => n + g.items.length, 0);
    return (
        <div data-command-window="">
            <Command open={open} onClose={close} shouldFilter={false} query={query} onQueryChange={setQuery}>
                <Command.Input placeholder="Search prompts, actions, workspaces, agents…  (p> a> w> @>)" />
                <Command.List>
                    {/* Fancy's Empty does not know what is shown; Genie does. */}
                    {shown === 0 ? <Command.Empty>Nothing matches that.</Command.Empty> : null}
                    {groups.map((group) => (
                        <Command.Group key={group.category} heading={group.heading}>
                            {group.items.map((item) => (
                                <Command.Item key={`${item.category}:${item.id}`} value={item.label} onSelect={() => { onActivate(item); close(); }}>
                                    <span data-command-item={`${item.category}:${item.id}`}>{item.label}</span>
                                    {item.hint ? <span className="ml-2 text-xs text-[var(--fg-4)]">{item.hint}</span> : null}
                                </Command.Item>
                            ))}
                        </Command.Group>
                    ))}
                </Command.List>
            </Command>
        </div>
    );
}
