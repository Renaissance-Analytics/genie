/**
 * PURE, and DEPENDENCY-FREE. The one place a coding-agent provider is defined
 * (genie#261).
 *
 * ## Why this module exists
 *
 * The provider set used to be a string-literal union restated in ~37 places, of
 * which only ~11 were compiler-enforced. The enforced ones were merely tedious.
 * The unenforced ones were the problem, because they do not fail to BUILD, they
 * fail to WORK:
 *
 *   - `identity.ts` carried `const PROVIDERS: readonly string[]`, typed
 *     deliberately OUTSIDE the union so no compiler could check it. A provider
 *     missing from it was silently dropped by `savedAgentsOf` — the agent
 *     launched, ran, and simply never appeared in the roster. No error.
 *   - `protocol.ts` carried the `runAgent.agent` JSON-Schema `enum`. A provider
 *     missing from it could not be NAMED over MCP, whatever the types said.
 *   - `provider.ts` carried `AGENT_PROVIDERS`, re-exported as `GAPP_PROVIDERS`.
 *
 * Everything that names the providers now derives from this table, so adding one
 * is a DATA change and an incomplete one is a compile error rather than a
 * silence. `Record<AgentProvider, ProviderDef>` is what buys that.
 *
 * ## Why it imports nothing
 *
 * `AgentType` in `main/mcp/protocol.ts` derives from these keys, and the renderer
 * reads this table directly (as it already reads `main/terminal/agent-cap` and
 * `main/dev-server/serve-recipe`). Both are only safe while this module stays
 * free of imports — anything node-only reached from here would follow it into the
 * renderer bundle. Keep it that way.
 *
 * ## What is deliberately NOT here yet
 *
 * LAUNCH behaviour — `LAUNCH_PROFILES`, the resume/continue templates, and argv
 * ordering — stays in `agentinbox/session-capture.ts` and `agents/startup.ts`.
 * This refactor was written alongside #259, which owned those surfaces; it has
 * since merged (`099fd30`), so folding them in is now the natural SECOND pass
 * rather than a collision. The fields it wants — `sessionStrategy`,
 * `flagTemplate`, `resumeTemplate`, `continueTemplate`, `lateBindAllowed`,
 * `launchGrammar` — belong on `ProviderDef`.
 *
 * That second pass is where a third provider stops being second-class:
 * `renderAgentResume` / `renderAgentContinue` still hardcode `agent === 'claude'`,
 * so anything else gets NO graceful restart. `withStartupInstructions` remains
 * the single owner of shell quoting regardless.
 */

/** The AI TUIs Genie can launch. Adding one starts here and nowhere else. */
export const PROVIDER_IDS = ['claude', 'codex', 'custom'] as const;

export type AgentProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderDef {
    /** Must equal the table key. Asserted, so a copy-paste slip cannot survive. */
    id: AgentProviderId;
    /** Human-facing name. The rail, the panel header, the settings row. */
    label: string;
    /** One line, shown where a person is choosing between providers. */
    hint: string;
    /**
     * The command when the owner has set no override. `custom` has none on
     * purpose — a custom agent IS its command, so an empty default is the honest
     * answer rather than a guess that would launch the wrong thing.
     */
    defaultCommand: string;
    /** Settings key holding the owner's command override. */
    commandSettingKey: `agent_command_${AgentProviderId}`;
    /** Settings key holding the owner's extra launch flags. */
    flagsSettingKey: `agent_flags_${AgentProviderId}`;
}

/**
 * `Record<AgentProviderId, ProviderDef>` is the load-bearing part: add an id to
 * `PROVIDER_IDS` and this stops compiling until the entry exists. That is the
 * property the ~26 unenforced sites lacked.
 */
export const PROVIDER_REGISTRY: Record<AgentProviderId, ProviderDef> = {
    claude: {
        id: 'claude',
        label: 'Claude Code',
        hint: 'Launch the Claude Code TUI',
        defaultCommand: 'claude',
        commandSettingKey: 'agent_command_claude',
        flagsSettingKey: 'agent_flags_claude',
    },
    codex: {
        id: 'codex',
        label: 'Codex',
        hint: 'Launch the Codex TUI',
        defaultCommand: 'codex',
        commandSettingKey: 'agent_command_codex',
        flagsSettingKey: 'agent_flags_codex',
    },
    custom: {
        id: 'custom',
        label: 'Custom agent',
        hint: 'Launch your own agent command',
        defaultCommand: '',
        commandSettingKey: 'agent_command_custom',
        flagsSettingKey: 'agent_flags_custom',
    },
};

/** The providers, in a stable order every derived surface shares. */
export function agentProviders(): AgentProviderId[] {
    return [...PROVIDER_IDS];
}

/** True when `value` names a provider. The one membership test. */
export function isProviderId(value: unknown): value is AgentProviderId {
    return typeof value === 'string' && Object.hasOwn(PROVIDER_REGISTRY, value);
}

/** A provider's definition. Callers hold an `AgentProviderId`, so it exists. */
export function providerDef(id: AgentProviderId): ProviderDef {
    return PROVIDER_REGISTRY[id];
}

/**
 * The provider half of the settings shape. Intersected into `Settings` in
 * `db.ts`, so adding a provider adds its two keys with no edit there.
 */
export type ProviderSettingKeys = {
    [K in `agent_command_${AgentProviderId}` | `agent_flags_${AgentProviderId}`]?: string;
};

/**
 * The default value for every provider setting.
 *
 * `db.ts` listed all six by hand; a provider added without its two lines got
 * `undefined` where a string was expected. Commands default to the registry's
 * `defaultCommand` (empty for `custom`, deliberately), flags to ''.
 */
export function providerSettingDefaults(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of agentProviders()) {
        const def = PROVIDER_REGISTRY[id];
        out[def.commandSettingKey] = def.defaultCommand;
        out[def.flagsSettingKey] = '';
    }
    return out;
}

/**
 * The per-provider settings keys, for the places that must enumerate them —
 * the defaults in `db.ts`, the mobile allow-list, the settings search index.
 */
export function providerSettingKeys(): {
    id: AgentProviderId;
    command: string;
    flags: string;
}[] {
    return agentProviders().map((id) => ({
        id,
        command: PROVIDER_REGISTRY[id].commandSettingKey,
        flags: PROVIDER_REGISTRY[id].flagsSettingKey,
    }));
}
