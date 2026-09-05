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
 * Only the providers with a mark Genie can actually render are named; the rest
 * fall to {@link FALLBACK_PROVIDER_ICON}. This was an exhaustive `Record`, which
 * was the right shape while there were five providers and every one of them
 * needed a decision — but a table of twenty forced eighteen copies of the same
 * decision, and an exhaustive table of near-identical rows is where a wrong one
 * hides. The fallback is what the exhaustive version would have made you type.
 */
const PROVIDER_ICONS: Partial<
    Record<AgentType, ComponentType<{ size?: number; className?: string }>>
> = {
    // The REAL vendor marks. These were placeholders -- claude and genie both
    // rendered the TYNN logo and codex a generic box -- which is wrong twice: it
    // tells you the wrong vendor, and it makes two different agents look
    // identical in a grid whose whole job is telling them apart.
    claude: AnthropicIcon,
    codex: OpenaiIcon,
    // Genie's own TUI gets Genie's own mark, NOT Tynn's. They are different
    // products and the logo is not shared.
    genie: IconWand,
};

/**
 * The glyph for a provider with no vendor mark wired here.
 *
 * Every third-party CLI lands on this rather than borrowing another vendor's
 * logo — which was already the rule for `custom`, and the reason `kiwi` carried
 * a neutral glyph rather than a pretty one. Real marks can be added per vendor
 * the moment the icon set is CONFIRMED to carry them; guessing an icon name that
 * does not exist renders nothing at all, which is a worse outcome than a plain
 * glyph and a harder one to notice.
 */
const FALLBACK_PROVIDER_ICON = IconCode;

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
            icon: PROVIDER_ICONS[id] ?? FALLBACK_PROVIDER_ICON,
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
