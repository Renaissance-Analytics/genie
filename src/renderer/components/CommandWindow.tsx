import { Command, useCommand } from '@particle-academy/react-fancy';
import { useMemo } from 'react';
import { filterCommandItems, groupCommandItems, parseCommandQuery, type CommandItem } from '../../core/command-window.js';

/**
 * CTRL/CMD+K — THE COMMAND WINDOW (Tynn #757; Genie 1's GenieCommandWindow). Fancy's `Command` draws it and keeps the
 * input, the active row and the keys; `core/command-window.ts` decides what is on offer for a query.
 */
export interface CommandWindowProps {
    readonly open: boolean;
    readonly items: readonly CommandItem[];
    readonly onClose: () => void;
    /** The person chose an item (Enter or click); the window closes after. */
    readonly onActivate: (item: CommandItem) => void;
}

export function CommandWindow({ open, items, onClose, onActivate }: CommandWindowProps) {
    if (!open) return null;
    return (
        <div data-command-window="">
            <Command open={open} onClose={onClose}>
                <Command.Input placeholder="Search prompts, actions, workspaces, agents…  (p> a> w> @>)" />
                <CommandBody items={items} onActivate={(item) => { onActivate(item); onClose(); }} />
            </Command>
        </div>
    );
}

function CommandBody({ items, onActivate }: { items: readonly CommandItem[]; onActivate: (item: CommandItem) => void }) {
    const { query } = useCommand();
    const groups = useMemo(() => groupCommandItems(filterCommandItems(items, parseCommandQuery(query))), [items, query]);
    return (
        <Command.List>
            <Command.Empty>Nothing matches that.</Command.Empty>
            {groups.map((group) => (
                <Command.Group key={group.category} heading={group.heading}>
                    {group.items.map((item) => (
                        // TEMPORARY (asked of the fancy agent 2026-10-17: an opt-out of Command.Item's own filter): Item hides
                        // itself unless its value contains the RAW query, which a prefixed query (`w> tynn`) never is. Genie
                        // has already decided this item matches, so its value carries the query — Fancy's check then passes.
                        <Command.Item key={`${item.category}:${item.id}`} value={`${query} ${item.label}`} onSelect={() => onActivate(item)}>
                            <span data-command-item={`${item.category}:${item.id}`}>{item.label}</span>
                            {item.hint ? <span className="ml-2 text-xs text-[var(--fg-4)]">{item.hint}</span> : null}
                        </Command.Item>
                    ))}
                </Command.Group>
            ))}
        </Command.List>
    );
}
