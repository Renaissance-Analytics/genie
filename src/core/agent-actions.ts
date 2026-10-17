import type { StreamEvent } from './stream-event.js';

/**
 * WHAT AN AGENT DID, AS AN ACTION A SOUND CAN BE CHOSEN FOR (Tynn #766 row C; the owner, 2026-10-17: "Every kind of
 * action an agent can take needs to have a sound setting").
 *
 * Read from the session's own stream. A tool call is filed by the CATEGORY the provider gave it (prism-acp's `kind`):
 * an edit, a command, a read or search, a fetch. A call the provider did not categorise is not an action here — Genie
 * does not second-guess the provider's table from a tool's name. A message is not one either: a reply sounds when the
 * turn ENDS (session-host's turn end), not on every chunk.
 *
 * The `key` is what the host sounds ONCE: a tool call streams several updates under one id; a plan is rewritten many
 * times in a turn and sounds once in it.
 */
export type AgentActionKind = 'edits' | 'runs' | 'reads' | 'fetches' | 'plans' | 'stopped';

export interface AgentAction {
    readonly kind: AgentActionKind;
    readonly key: string;
}

export function agentActionOf(event: StreamEvent): AgentAction | null {
    switch (event.kind) {
        case 'tool': {
            const kind = event.toolKind === 'edit' ? 'edits'
                : event.toolKind === 'execute' ? 'runs'
                : event.toolKind === 'read' || event.toolKind === 'search' ? 'reads'
                : event.toolKind === 'fetch' ? 'fetches'
                : null;
            return kind === null || event.toolCallId === '' ? null : { kind, key: `tool:${event.toolCallId}` };
        }
        case 'plan':
            return { kind: 'plans', key: 'plan' };
        case 'stopped':
            return { kind: 'stopped', key: `stopped:${event.n}` };
        default:
            return null;
    }
}
