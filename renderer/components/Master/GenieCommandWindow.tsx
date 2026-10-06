import { useMemo } from 'react';
import { Command, Text, useCommand } from '@particle-academy/react-fancy';
import {
    dropUndeliverable,
    featureCommandItems,
    filterCommandItems,
    groupCommandItems,
    parseCommandQuery,
    type CommandItem,
} from '../../lib/command-window';
import { FEATURE_SURFACES } from '../../lib/feature-reachability';

/**
 * Genie's Command Window — Ctrl+K (Tynn story #247).
 *
 * Built on Fancy's `Command`, which owns the overlay, the query state, arrow-key
 * navigation and Enter/Escape. Genie supplies only what Fancy cannot know: its own
 * things, and how a typed query narrows them (lib/command-window.ts, unit-tested).
 *
 * Opened by the shared terminal-scoped hotkey layer, so it appears only while a
 * terminal panel has focus, and the keypress never reaches the shell — Ctrl+K is
 * kill-to-end-of-line in readline, and typing that into the user's prompt while
 * opening a palette would be its own bug.
 *
 * The window remembers WHICH terminal was focused when it opened, so a prompt goes
 * to the agent the user was looking at rather than whatever is focused by the time
 * they press Enter.
 */
export interface SavedPrompt {
    id: string;
    label: string;
    /** The text sent to the terminal. Multi-line is fine — main's write path
     *  handles the paste/submit split. */
    text: string;
}

/**
 * A VERB the palette can run — as opposed to a place it navigates to.
 *
 * The first of them is launching a Genie App from the workspace it is built in,
 * which was previously reachable only by opening Workspace Settings and knowing
 * that a section appears there for some workspaces and not others.
 */
export interface CommandAction {
    id: string;
    label: string;
    /** Where it will happen — a workspace name. Shown, never matched. */
    hint?: string;
    run: () => void;
}

export interface GenieCommandWindowProps {
    open: boolean;
    onClose: () => void;
    /** The terminal focused when the window opened; prompts are sent here. */
    terminalId: string | null;
    workspaces: Array<{ id: string; name: string }>;
    terminals: Array<{ id: string; label: string; hint?: string }>;
    prompts: SavedPrompt[];
    /** Verbs on offer right now. Empty is normal — the group simply disappears. */
    actions?: CommandAction[];
    onActivateWorkspace: (workspaceId: string) => void;
    onFocusTerminal: (terminalId: string) => void;
    onSendPrompt: (terminalId: string, text: string) => void;
    /** Open one of Genie's features. The palette is where they live once the
     *  title bar stops carrying an icon for each. */
    onActivateFeature: (featureId: string) => void;
}

export default function GenieCommandWindow({
    open,
    onClose,
    terminalId,
    workspaces,
    terminals,
    prompts,
    actions = [],
    onActivateWorkspace,
    onFocusTerminal,
    onSendPrompt,
    onActivateFeature,
}: GenieCommandWindowProps) {
    const items = useMemo<CommandItem[]>(
        () =>
            // Everything undeliverable in the CURRENT context is dropped rather than shown
            // dead. With no terminal focused a prompt has nowhere to be sent and a terminal
            // entry has nothing to focus, and a row that looks live and silently does
            // nothing is worse than an absent one.
            dropUndeliverable(
                [
                    ...prompts.map((p) => ({ id: p.id, category: 'prompt' as const, label: p.label })),
                    ...actions.map((a) => ({
                        id: a.id,
                        category: 'action' as const,
                        label: a.label,
                        ...(a.hint ? { hint: a.hint } : {}),
                    })),
                    // Genie's own features. Built FROM the reachability contract, so a
                    // feature cannot be added there and forgotten here — which is what lets
                    // a title-bar icon be deleted without stranding what it opened.
                    ...featureCommandItems(FEATURE_SURFACES),
                    ...workspaces.map((w) => ({ id: w.id, category: 'workspace' as const, label: w.name })),
                    ...terminals.map((t) => ({
                        id: t.id,
                        category: 'terminal' as const,
                        label: t.label,
                        ...(t.hint ? { hint: t.hint } : {}),
                    })),
                ],
                { hasTerminal: terminalId !== null },
            ),
        [prompts, actions, workspaces, terminals, terminalId],
    );

    if (!open) return null;

    return (
        <Command open={open} onClose={onClose} className="genie-cmdk">
            <Command.Input placeholder="Search prompts, actions, workspaces, terminals…  (p&gt; a&gt; w&gt; t&gt;)" />
            <CommandBody
                items={items}
                prompts={prompts}
                actions={actions}
                terminalId={terminalId}
                onClose={onClose}
                onActivateWorkspace={onActivateWorkspace}
                onFocusTerminal={onFocusTerminal}
                onSendPrompt={onSendPrompt}
                onActivateFeature={onActivateFeature}
            />
        </Command>
    );
}

/**
 * Separate child because `useCommand()` only has a context to read INSIDE
 * `<Command>` — the live query lives there, and the filtering has to react to it.
 */
function CommandBody({
    items,
    prompts,
    actions,
    terminalId,
    onClose,
    onActivateWorkspace,
    onFocusTerminal,
    onSendPrompt,
    onActivateFeature,
}: {
    items: CommandItem[];
    prompts: SavedPrompt[];
    actions: CommandAction[];
    terminalId: string | null;
    onClose: () => void;
    onActivateWorkspace: (id: string) => void;
    onFocusTerminal: (id: string) => void;
    onSendPrompt: (terminalId: string, text: string) => void;
    onActivateFeature: (featureId: string) => void;
}) {
    const { query } = useCommand();
    const groups = useMemo(
        () => groupCommandItems(filterCommandItems(items, parseCommandQuery(query))),
        [items, query],
    );

    const activate = (item: CommandItem) => {
        if (item.category === 'prompt') {
            const prompt = prompts.find((p) => p.id === item.id);
            // No terminal means nothing to send to — close rather than silently
            // discard, so it never looks like the prompt was delivered.
            if (prompt && terminalId) onSendPrompt(terminalId, prompt.text);
        } else if (item.category === 'workspace') {
            onActivateWorkspace(item.id);
        } else if (item.category === 'terminal') {
            onFocusTerminal(item.id);
        } else if (item.category === 'action') {
            actions.find((a) => a.id === item.id)?.run();
        } else if (item.category === 'panel' && item.featureId) {
            // A feature. Dispatched by featureId, never by the row's own id, which is
            // prefixed (`feature:<id>`) to keep it distinct from a workspace or terminal id.
            onActivateFeature(item.featureId);
        }
        onClose();
    };

    return (
        <Command.List>
            <Command.Empty>Nothing matches that.</Command.Empty>
            {groups.map((group) => (
                <Command.Group key={group.category} heading={group.heading}>
                    {group.items.map((item) => (
                        <Command.Item key={item.id} value={item.label} onSelect={() => activate(item)}>
                            <span>{item.label}</span>
                            {item.hint && (
                                <Text size="xs" className="text-zinc-500">
                                    {item.hint}
                                </Text>
                            )}
                        </Command.Item>
                    ))}
                </Command.Group>
            ))}
        </Command.List>
    );
}
