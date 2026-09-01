/**
 * The terminal-type registry the split Add-Terminal button renders from. Adding
 * a fifth type is one entry here — the split button, its dropdown, and the
 * last-used-type persistence all read this list. A "regular" entry is a plain
 * shell; the rest are SPECIALIZED (an AI TUI launched with a captured chat
 * session + an AgentInbox identity).
 */
import type { ComponentType } from 'react';
import { AnthropicIcon, OpenaiIcon } from '@particle-academy/fancy-brand-icons';
import { IconBox, IconCode, IconTerminal, IconWand } from '../components/Master/icons';
import type { AgentType } from './genie';
import { agentTuis, providerDef } from '../../main/agents/registry';

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

/**
 * The provider MARK. The only per-provider fact that cannot live in
 * `TUI_REGISTRY`, because the registry is dependency-free by contract and
 * these are React components.
 *
 * `Record<AgentType, …>` is what keeps it honest: add a provider to the registry
 * and this stops compiling until it has a mark. Note the current three are
 * placeholder-grade — `claude` renders the TYNN mark and `codex` a generic box —
 * and adding a fourth is the moment to fix all of them rather than add a fourth
 * placeholder.
 */
const PROVIDER_ICONS: Record<AgentType, ComponentType<{ size?: number; className?: string }>> = {
    // The REAL vendor marks. These were placeholders -- claude and genie both
    // rendered the TYNN logo and codex a generic box -- which is wrong twice: it
    // tells you the wrong vendor, and it makes two different agents look
    // identical in a grid whose whole job is telling them apart.
    claude: AnthropicIcon,
    codex: OpenaiIcon,
    // Genie's own TUI gets Genie's own mark, NOT Tynn's. They are different
    // products and the logo is not shared.
    genie: IconWand,
    // Kiwi and a custom CLI have no mark of their own here, and borrowing another
    // vendor's would assert a relationship that does not exist. A neutral glyph
    // is the honest answer.
    kiwi: IconCode,
    custom: IconCode,
};

/**
 * Regular first, then one entry per provider, DERIVED from `TUI_REGISTRY`
 * (genie#261) — so a provider added to the registry appears in the split button,
 * its dropdown and the last-used-type persistence with no edit here, carrying the
 * same label and hint the Settings rows show.
 */
export const TERMINAL_TYPES: TerminalTypeDef[] = [
    {
        id: 'regular',
        label: 'Terminal',
        icon: IconTerminal,
        specialized: false,
        hint: 'A plain shell',
    },
    ...agentTuis().map((id): TerminalTypeDef => {
        const def = providerDef(id);
        return {
            id,
            label: def.label,
            icon: PROVIDER_ICONS[id],
            agent: id,
            specialized: true,
            hint: def.hint,
        };
    }),
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

/** Provider choices for the dedicated AMS "New Agent" affordance. */
export function agentTerminalTypes(): TerminalTypeDef[] {
    return TERMINAL_TYPES.filter((type) => type.specialized && type.agent);
}

/** Built-in terminal-backed choices in the workspace Add Panel launcher. */
export function panelLauncherTypes(): TerminalTypeDef[] {
    return TERMINAL_TYPES.filter((type) => !type.specialized);
}
