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
export const PROVIDER_IDS = ['claude', 'codex', 'kiwi', 'genie', 'custom'] as const;

export type AgentProviderId = (typeof PROVIDER_IDS)[number];

/**
 * How Genie installs an OWNED provider's binary when it is missing (genie#313).
 * Only `npm` today; a future provider may need another kind, at which point
 * this becomes a union rather than growing optional fields on one shape.
 */
export interface ProviderInstallSpec {
    manager: 'npm';
    /** The npm package that provides the binary. */
    package: string;
}

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
    /**
     * True when GENIE ITSELF ships or owns this provider's binary, as opposed
     * to `claude`/`codex` — the owner's own installs, which Genie must never
     * try to `npm install` over — or `custom`, which names no fixed binary at
     * all (genie#313). Only an owned provider is a candidate for the boot-time
     * detect-and-install pass in `agents/availability.ts`.
     */
    ownedBinary: boolean;
    /**
     * How to install this provider automatically when `ownedBinary` is true and
     * the binary is missing. Left `undefined` — even for an owned provider —
     * when Genie has no WORKING installer for it yet: that still runs the
     * detect pass and surfaces the gap (grey the provider out with a reason)
     * rather than opening a terminal that fails, it just cannot close the gap
     * automatically. See the per-provider comments below for why `genie` and
     * `kiwi` are in exactly that state today.
     */
    install?: ProviderInstallSpec;
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
        // The owner's own install — Genie must never touch it.
        ownedBinary: false,
    },
    codex: {
        id: 'codex',
        label: 'Codex',
        hint: 'Launch the Codex TUI',
        defaultCommand: 'codex',
        commandSettingKey: 'agent_command_codex',
        flagsSettingKey: 'agent_flags_codex',
        ownedBinary: false,
    },
    kiwi: {
        id: 'kiwi',
        label: 'Kiwi Code',
        hint: 'Launch the native Kiwi Code CLI',
        defaultCommand: 'kiwi',
        commandSettingKey: 'agent_command_kiwi',
        flagsSettingKey: 'agent_flags_kiwi',
        // Genie ships this one (genie#313) — same "command not found" gap the
        // `genie` provider had. No `install`: there is no known public source
        // for the `kiwi` binary this codebase can point npm (or anything else)
        // at, so the detect pass can only surface the gap, not close it.
        ownedBinary: true,
    },
    genie: {
        id: 'genie',
        label: 'Genie TUI',
        hint: 'Launch the local-first Genie TUI',
        // The binary is `genie`. This said `genie-tui`, which does not exist --
        // selecting the Genie TUI produced `bash: genie-tui: command not found`,
        // so the provider was unusable from the moment it was listed.
        defaultCommand: 'genie',
        commandSettingKey: 'agent_command_genie',
        flagsSettingKey: 'agent_flags_genie',
        // Genie ships this one (genie#313) — it is the SAME "command not found"
        // gap as above, just moved from a wrong name to a missing binary. No
        // `install`, deliberately: the upstream package (`@genie/tui`, at
        // github.com/Renaissance-Analytics/genie-tui) is `private: true` and has
        // never been published, and its shipped `bin` is still named
        // `genie-tui` — an `npm install -g` today would put `genie-tui` on
        // PATH, not `genie`, silently reproducing the exact naming bug this
        // ticket's sibling already fixed, one layer later. Wire `install` up
        // once that package is public AND its bin matches `defaultCommand`.
        ownedBinary: true,
    },
    custom: {
        id: 'custom',
        label: 'Custom agent',
        hint: 'Launch your own agent command',
        defaultCommand: '',
        commandSettingKey: 'agent_command_custom',
        flagsSettingKey: 'agent_flags_custom',
        // No fixed binary to detect or install — the owner IS the installer.
        ownedBinary: false,
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
