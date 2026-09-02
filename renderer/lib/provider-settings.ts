import { agentTuis, TUI_REGISTRY, type AgentTuiId, type TuiDef } from '../../main/agents/registry';

/**
 * The Providers settings section, DERIVED from the registry (genie#261).
 *
 * `registry.ts` was written because the provider set had been restated in ~37
 * places and only ~11 of them were compiler-enforced — the rest "do not fail to
 * BUILD, they fail to WORK". The settings page was one of the unenforced ones,
 * and it had drifted exactly as predicted: hand-rolled command and flags rows
 * for `claude`, `codex` and `custom`, and nothing at all for `kiwi` or `genie`.
 *
 * That mattered. `agent_command_kiwi`, `agent_flags_kiwi`, `agent_command_genie`
 * and `agent_flags_genie` are real keys the launcher reads, so both providers
 * were launchable with no way for the owner to set their command or flags —
 * which is the one thing those providers most need, since neither ships a
 * working binary by default. The GApp provider select had drifted the same way,
 * offering three of five.
 *
 * PURE, and free of React, so the model is testable without a window and the
 * page cannot hold a fifth copy of the provider list. Adding a provider to the
 * registry adds it here, and a structural guard in the tests fails the build if
 * the page ever names one of these keys directly again.
 */

/** A settings key holding an owner override, as declared by the registry. */
export type ProviderCommandKey = TuiDef['commandSettingKey'];
export type ProviderFlagsKey = TuiDef['flagsSettingKey'];

export interface ProviderSettingsGroup {
    id: AgentTuiId;
    /** Human-facing name — the group heading. */
    label: string;
    /** One line, from the registry, shown under the heading. */
    hint: string;
    commandKey: ProviderCommandKey;
    flagsKey: ProviderFlagsKey;
    /**
     * What an empty command falls back to. For every provider but `custom` this
     * is the registry's real default, so the placeholder tells the truth about
     * what will run. `custom` has `defaultCommand: ''` deliberately — "a custom
     * agent IS its command" — so showing a real command there would be the
     * guess the registry refused to make; it gets an example instead.
     */
    commandPlaceholder: string;
    /** Whether Genie owns this binary, and so may detect or install it. */
    ownedBinary: boolean;
    /** Search terms for the settings search box. */
    keywords: string;
}

/** Extra search terms per provider, so searching a vendor's name finds its rows. */
const EXTRA_KEYWORDS: Record<AgentTuiId, string> = {
    claude: 'anthropic claude code',
    codex: 'openai codex',
    kiwi: 'kiwi code native cli',
    genie: 'genie tui local first',
    custom: 'custom own binary bring your own',
};

export function providerSettingsGroups(): ProviderSettingsGroup[] {
    return agentTuis().map((id) => {
        const def = TUI_REGISTRY[id];
        return {
            id,
            label: def.label,
            hint: def.hint,
            commandKey: def.commandSettingKey,
            flagsKey: def.flagsSettingKey,
            commandPlaceholder:
                id === 'custom' ? 'e.g. my-agent --interactive' : def.defaultCommand,
            ownedBinary: def.ownedBinary,
            keywords: `${id} ${def.label} ${EXTRA_KEYWORDS[id]} agent tui command flags launch specialized terminal`,
        };
    });
}

export interface GappProviderOption {
    value: '' | AgentTuiId;
    label: string;
}

/**
 * The GApp AI-provider choices.
 *
 * Every provider, not a curated three. A Genie App declares that it needs an
 * agent; which agent is the owner's call, because it runs on their machine
 * under their subscription. Leaving `kiwi` and `genie` out of the list made
 * that choice for them.
 */
export function gappProviderOptions(): GappProviderOption[] {
    return [
        { value: '', label: 'Follow my default agent' },
        ...agentTuis().map((id) => ({ value: id, label: TUI_REGISTRY[id].label })),
    ];
}
