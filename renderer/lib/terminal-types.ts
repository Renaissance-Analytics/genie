/**
 * The terminal-type registry the split Add-Terminal button renders from. Adding
 * a fifth type is one entry here — the split button, its dropdown, and the
 * last-used-type persistence all read this list. A "regular" entry is a plain
 * shell; the rest are SPECIALIZED (an AI TUI launched with a captured chat
 * session + a WhisperChat identity).
 */
import type { ComponentType } from 'react';
import { IconBox, IconCode, IconTerminal, IconTynn } from '../components/Master/icons';
import type { AgentType } from './genie';

/** The registry key: `regular` for a plain shell, else the agent kind. */
export type TerminalTypeId = 'regular' | AgentType;

export interface TerminalTypeDef {
    id: TerminalTypeId;
    label: string;
    icon: ComponentType<{ size?: number; className?: string }>;
    /** The AI-TUI kind for a specialized terminal (absent for `regular`). */
    agent?: AgentType;
    /** Whether this launches an AI agent (vs a plain shell). */
    specialized: boolean;
    /** One-line hint shown under the label in the type dropdown. */
    hint?: string;
}

export const TERMINAL_TYPES: TerminalTypeDef[] = [
    {
        id: 'regular',
        label: 'Terminal',
        icon: IconTerminal,
        specialized: false,
        hint: 'A plain shell',
    },
    {
        id: 'claude',
        label: 'Claude Code',
        icon: IconTynn,
        agent: 'claude',
        specialized: true,
        hint: 'Launch the Claude Code TUI',
    },
    {
        id: 'codex',
        label: 'Codex',
        icon: IconBox,
        agent: 'codex',
        specialized: true,
        hint: 'Launch the Codex TUI',
    },
    {
        id: 'custom',
        label: 'Custom agent',
        icon: IconCode,
        agent: 'custom',
        specialized: true,
        hint: 'Launch your own agent command',
    },
];

export const DEFAULT_TERMINAL_TYPE: TerminalTypeId = 'regular';

/** Resolve a stored id (e.g. `settings.last_terminal_type`) to its definition,
 *  falling back to the regular terminal for an unknown / missing value. */
export function terminalTypeById(id: string | null | undefined): TerminalTypeDef {
    return TERMINAL_TYPES.find((t) => t.id === id) ?? TERMINAL_TYPES[0];
}

/** The definition for an agent kind (claude / codex / custom). */
export function terminalTypeForAgent(agent: AgentType): TerminalTypeDef {
    return TERMINAL_TYPES.find((t) => t.agent === agent) ?? TERMINAL_TYPES[0];
}
