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
 *   - `provider.ts` carried `AGENT_TUIS`, re-exported as `GAPP_PROVIDERS`.
 *
 * Everything that names the providers now derives from this table, so adding one
 * is a DATA change and an incomplete one is a compile error rather than a
 * silence. `Record<AgentTui, TuiDef>` is what buys that.
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
 * LAUNCH behaviour — `LAUNCH_PROFILES`, the session-capture strategy, and argv
 * ordering — stays in `agentinbox/session-capture.ts` and `agents/startup.ts`.
 * This refactor was written alongside #259, which owned those surfaces; it has
 * since merged (`099fd30`), so folding them in is now the natural SECOND pass
 * rather than a collision. The fields it wants — `sessionStrategy`,
 * `flagTemplate`, `lateBindAllowed`, `launchGrammar` — belong on `TuiDef`.
 *
 * RESUME has already made that move (`TuiDef.resume`), because it was not merely
 * untidy: `renderAgentResume` rendered a real `codex resume <id>` while the
 * terminal context menu hid "Restart agent" from every provider but `claude`,
 * under a comment asserting codex could not resume. A codex agent was therefore
 * denied a restart that works. Rendering still lives in `session-capture.ts`;
 * only the GRAMMAR moved here. `withStartupInstructions` remains the single owner
 * of shell quoting regardless.
 */

/**
 * The AI TUIs Genie can launch. Adding one starts here and nowhere else.
 *
 * `claude`, `codex` and Genie's own TUI lead; the rest are alphabetical, because
 * any other ordering is an editorial claim about which vendor matters and
 * nothing here is qualified to make one. `custom` is last: it is not a product.
 *
 * `kiwi` USED TO BE HERE and is gone. It was labelled "Kiwi Code" and its own
 * registry comment admitted no public source for a `kiwi` binary could be found.
 * There is a reason for that: no such product exists. Searching the npm registry
 * and the open web turns up nothing — the `kiwi-cli` package is an unrelated
 * general-purpose tool. The real neighbours are Kilo Code (`@kilocode/cli`, bin
 * `kilo`) and Kimi Code (`@moonshot-ai/kimi-code`, bin `kimi`); the owner
 * confirmed Kilo was meant. So `kiwi` becomes `kilo`, and db migration v73
 * carries existing installs across — the same shape as v58, which fixed
 * `genie-tui`, and for the same reason: a provider that cannot resolve is a
 * provider that fails at launch with nothing on screen to explain it.
 */
export const PROVIDER_IDS = [
    'claude',
    'codex',
    'genie',
    'aider',
    'amp',
    'auggie',
    'cline',
    'continue',
    'copilot',
    'crush',
    'cursor',
    'droid',
    'gemini',
    'goose',
    'iflow',
    'kilo',
    'kimi',
    'opencode',
    'qwen',
    'vibe',
    'custom',
] as const;

export type AgentTuiId = (typeof PROVIDER_IDS)[number];

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

/**
 * How a provider RE-ENTERS a captured chat session (genie#261, category C).
 *
 * Two surfaces used to answer this independently, and they disagreed:
 * `renderAgentResume` has emitted `codex resume <id>` for as long as codex has
 * been a provider, while the terminal context menu gated "Restart agent" on
 * `agent === 'claude'` under a comment asserting codex had no resume. So a codex
 * agent was refused a restart that would have worked, and the comment is why
 * nobody looked. One table, read by both, makes that disagreement
 * unrepresentable rather than merely unlikely.
 *
 * `null` on a provider is a real answer, not an omission: without a known resume
 * grammar a "restart" drops the conversation into a fresh, context-less session,
 * so the honest move is to withhold the button rather than lose the work.
 *
 * The GRAMMAR lives here; the RENDERING stays in
 * `agentinbox/session-capture.ts`, which owns argv ordering and quoting.
 */
export interface ResumeGrammar {
    /**
     * `flag` appends `<token> <id>` to the launch command — claude's
     * `claude --resume <id>`. `subcommand` inserts `<token>` straight after the
     * binary and puts the id LAST, so any `-c` overrides stay in front of it —
     * codex's `codex resume [options] <id>`.
     */
    kind: 'flag' | 'subcommand';
    /** The flag (`--resume`) or subcommand word (`resume`). */
    token: string;
    /**
     * The flag that resumes the MOST-RECENT chat in the terminal's cwd, for a
     * provider that has one. It is the fallback when a captured id has no
     * transcript on disk. Absent where the provider offers no such thing —
     * codex has no generic continue, so a stale id there falls through to a
     * fresh launch instead.
     */
    continueFlag?: string;
    /**
     * Short forms that ALSO mean "this command is already resuming", for
     * detection only — never for rendering, which always emits the long form.
     *
     * Per-provider rather than a shared list, because the same short flag means
     * different things to different CLIs: `-c` is claude's `--continue`, while
     * codex's `-c` is a TOML config override and has nothing to do with
     * resuming. A shared alias list would read a codex `-c` as a resume and skip
     * the session-id injection the launch needed (genie#261 category C).
     */
    aliases?: string[];
}

export interface TuiDef {
    /** Must equal the table key. Asserted, so a copy-paste slip cannot survive. */
    id: AgentTuiId;
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
    commandSettingKey: `agent_command_${AgentTuiId}`;
    /** Settings key holding the owner's extra launch flags. */
    flagsSettingKey: `agent_flags_${AgentTuiId}`;
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
    /**
     * How this provider re-enters a captured chat session, or `null` when it has
     * no known resume grammar. Required (not optional) on purpose: adding a
     * provider must be a DECISION about whether it can be gracefully restarted,
     * and `undefined` would read as "no" without anyone having chosen.
     */
    resume: ResumeGrammar | null;
}

/**
 * `Record<AgentTuiId, TuiDef>` is the load-bearing part: add an id to
 * `PROVIDER_IDS` and this stops compiling until the entry exists. That is the
 * property the ~26 unenforced sites lacked.
 */
export const TUI_REGISTRY: Record<AgentTuiId, TuiDef> = {
    claude: {
        id: 'claude',
        label: 'Claude Code',
        hint: 'Launch the Claude Code TUI',
        defaultCommand: 'claude',
        commandSettingKey: 'agent_command_claude',
        flagsSettingKey: 'agent_flags_claude',
        // The owner's own install — Genie must never touch it.
        ownedBinary: false,
        // `claude --resume <id>`, plus `--continue` for the most-recent chat in
        // the cwd when the captured id has drifted. Both flags confirmed against
        // `claude --help` at build time.
        resume: { kind: 'flag', token: '--resume', continueFlag: '--continue', aliases: ['-r', '-c'] },
    },
    codex: {
        id: 'codex',
        label: 'Codex',
        hint: 'Launch the Codex TUI',
        defaultCommand: 'codex',
        commandSettingKey: 'agent_command_codex',
        flagsSettingKey: 'agent_flags_codex',
        ownedBinary: false,
        // `codex resume [options] <id>` — a SUBCOMMAND, not a flag, and the id
        // goes last so the `-c` TOML overrides Genie injects stay ahead of it.
        // No `continueFlag`: codex has no generic "continue the last chat".
        resume: { kind: 'subcommand', token: 'resume' },
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
        // Same as kiwi: no resume grammar yet. Genie's own TUI is the one that
        // could most easily grow one, and this is the line to fill in when it
        // does — nothing else needs editing.
        resume: null,
    },
    // --- the rest of the field, alphabetically ------------------------------
    //
    // Every entry below names a real, shipping coding-agent CLI. Its BINARY was
    // read from that package's own manifest on the public npm registry, or from
    // the vendor's install docs where it does not ship on npm — never recalled.
    // Six recalled answers were wrong when this list was assembled, so the rule
    // is evidence or nothing.
    //
    // `ownedBinary` is FALSE for all of them: these are other people's CLIs, and
    // the boot-time auto-install pass must never run `npm i -g` over somebody
    // else's tool. How Genie installs one when a person ASKS is the agent-CLI
    // catalog's `install`, which is a consented action and a different question.
    //
    // `resume` is `null` unless the syntax was read from the vendor's own
    // documentation, and the citation is in the comment. This is the field that
    // can lose work: a wrong resume flag does not error, it starts a FRESH
    // conversation while the UI says "restart".
    aider: {
        id: 'aider',
        label: 'Aider',
        hint: 'Launch the Aider pair-programming CLI',
        defaultCommand: 'aider',
        commandSettingKey: 'agent_command_aider',
        flagsSettingKey: 'agent_flags_aider',
        ownedBinary: false,
        // aider.chat/docs/usage.html documents no resume or continue flag.
        resume: null,
    },
    amp: {
        id: 'amp',
        label: 'Amp',
        hint: 'Launch Sourcegraph Amp',
        defaultCommand: 'amp',
        commandSettingKey: 'agent_command_amp',
        flagsSettingKey: 'agent_flags_amp',
        ownedBinary: false,
        // ampcode.com/manual documents no resume/continue flag for threads.
        resume: null,
    },
    auggie: {
        id: 'auggie',
        label: 'Auggie',
        hint: 'Launch the Augment Code CLI',
        defaultCommand: 'auggie',
        commandSettingKey: 'agent_command_auggie',
        flagsSettingKey: 'agent_flags_auggie',
        ownedBinary: false,
        // `auggie --resume <sessionId>` (-r) resumes a specific session;
        // `--continue` (-c) resumes the most recent. Read from
        // docs.augmentcode.com/cli/reference.
        resume: { kind: 'flag', token: '--resume', continueFlag: '--continue', aliases: ['-r', '-c'] },
    },
    cline: {
        id: 'cline',
        label: 'Cline',
        hint: 'Launch the Cline CLI',
        defaultCommand: 'cline',
        commandSettingKey: 'agent_command_cline',
        flagsSettingKey: 'agent_flags_cline',
        ownedBinary: false,
        // A `--id <sessionId>` form appears in third-party write-ups of the
        // non-interactive mode, but not in vendor documentation that could be
        // read here. Third-party prose is exactly the evidence standard this
        // list refuses, so: null.
        resume: null,
    },
    continue: {
        id: 'continue',
        label: 'Continue',
        hint: 'Launch the Continue CLI',
        // `cn`, not `continue` — the package's own manifest says so, and
        // `continue` is not a binary it ships.
        defaultCommand: 'cn',
        commandSettingKey: 'agent_command_continue',
        flagsSettingKey: 'agent_flags_continue',
        ownedBinary: false,
        // The CLI reference page redirects and served no content to read.
        // Unverified is null.
        resume: null,
    },
    copilot: {
        id: 'copilot',
        label: 'GitHub Copilot CLI',
        hint: 'Launch the GitHub Copilot CLI',
        defaultCommand: 'copilot',
        commandSettingKey: 'agent_command_copilot',
        flagsSettingKey: 'agent_flags_copilot',
        ownedBinary: false,
        // github/copilot-cli's README documents no resume or continue flag.
        resume: null,
    },
    crush: {
        id: 'crush',
        label: 'Crush',
        hint: 'Launch the Charm Crush TUI',
        defaultCommand: 'crush',
        commandSettingKey: 'agent_command_crush',
        flagsSettingKey: 'agent_flags_crush',
        ownedBinary: false,
        // Crush re-enters a conversation through an INTERACTIVE session picker,
        // not a flag — its README says each invocation "starts in its own fresh
        // session by default" and points at the picker. There is nothing a
        // command line can carry, so a restart cannot preserve the thread.
        resume: null,
    },
    cursor: {
        id: 'cursor',
        label: 'Cursor CLI',
        // The installer writes `cursor-agent`; posix also gets the alias
        // `agent`, which is far too generic a name for Genie to spawn.
        defaultCommand: 'cursor-agent',
        hint: 'Launch the Cursor agent CLI',
        commandSettingKey: 'agent_command_cursor',
        flagsSettingKey: 'agent_flags_cursor',
        ownedBinary: false,
        // `--resume [chatId]` resumes a chat; `--continue` is the vendor's own
        // documented alias for `--resume=-1`, the previous session. Read from
        // cursor.com/docs/cli/reference/parameters.
        resume: { kind: 'flag', token: '--resume', continueFlag: '--continue' },
    },
    droid: {
        id: 'droid',
        label: 'Factory Droid',
        hint: 'Launch the Factory Droid CLI',
        defaultCommand: 'droid',
        commandSettingKey: 'agent_command_droid',
        flagsSettingKey: 'agent_flags_droid',
        ownedBinary: false,
        // `-r, --resume [sessionId]` — and a BARE `--resume` resumes the last
        // modified session, which is why it is its own `continueFlag` rather
        // than a second flag. Read from
        // docs.factory.ai/cli/configuration/cli-reference.
        resume: { kind: 'flag', token: '--resume', continueFlag: '--resume', aliases: ['-r'] },
    },
    gemini: {
        id: 'gemini',
        label: 'Gemini CLI',
        hint: 'Launch Google Gemini CLI',
        defaultCommand: 'gemini',
        commandSettingKey: 'agent_command_gemini',
        flagsSettingKey: 'agent_flags_gemini',
        ownedBinary: false,
        // Its README advertises "conversation checkpointing to save and resume",
        // but documents no CLI flag for it — the feature is reached from inside
        // the TUI. An advertised capability with no command line is not a resume
        // grammar.
        resume: null,
    },
    goose: {
        id: 'goose',
        label: 'Goose',
        hint: 'Launch the Block Goose CLI',
        defaultCommand: 'goose',
        commandSettingKey: 'agent_command_goose',
        flagsSettingKey: 'agent_flags_goose',
        ownedBinary: false,
        // Goose DOES document a resume: `goose session --resume --session-id
        // <id>`. It is null anyway, because {@link ResumeGrammar} cannot express
        // it — that shape is a subcommand AND a flag, while `kind: 'subcommand'`
        // puts the id positionally last (`goose session <id>`, which Goose does
        // not accept). Wiring a third kind is the fix; guessing with the two
        // that exist would build a command the CLI never documented.
        resume: null,
    },
    iflow: {
        id: 'iflow',
        label: 'iFlow CLI',
        hint: 'Launch the iFlow CLI',
        defaultCommand: 'iflow',
        commandSettingKey: 'agent_command_iflow',
        flagsSettingKey: 'agent_flags_iflow',
        ownedBinary: false,
        // No resume syntax read from vendor documentation.
        resume: null,
    },
    kilo: {
        id: 'kilo',
        label: 'Kilo Code',
        hint: 'Launch the Kilo Code CLI',
        // `@kilocode/cli` publishes TWO bins, `kilo` and `kilocode`, pointing at
        // the same entry point. `kilo` is the one its own docs lead with, so it
        // is the one Genie launches and probes; a machine carrying only the
        // longer alias reads as not-installed, which is the safe direction to be
        // wrong.
        defaultCommand: 'kilo',
        commandSettingKey: 'agent_command_kilo',
        flagsSettingKey: 'agent_flags_kilo',
        // Kilo's binary, not Genie's. The `kiwi` entry this replaces claimed
        // `ownedBinary: true` ("Genie ships this one"), which was never true of
        // anything and is certainly not true of another vendor's CLI.
        ownedBinary: false,
        // Kilo DOES document `--continue` (`-c`) to resume the last conversation
        // in the workspace — but no resume-BY-ID, and `renderAgentResume`
        // appends the captured session id to `token`, so any grammar here would
        // render `kilo --continue <id>`: a command the CLI never documented.
        // Null until `ResumeGrammar` can express continue-only, at which point
        // this is a one-line change. `resolveRestartCommand` refuses the restart
        // and says why, which beats silently starting over.
        resume: null,
    },
    kimi: {
        id: 'kimi',
        label: 'Kimi Code',
        hint: 'Launch the Moonshot Kimi Code CLI',
        defaultCommand: 'kimi',
        commandSettingKey: 'agent_command_kimi',
        flagsSettingKey: 'agent_flags_kimi',
        ownedBinary: false,
        // No resume syntax read from vendor documentation.
        resume: null,
    },
    opencode: {
        id: 'opencode',
        label: 'opencode',
        hint: 'Launch the provider-neutral opencode TUI',
        defaultCommand: 'opencode',
        commandSettingKey: 'agent_command_opencode',
        flagsSettingKey: 'agent_flags_opencode',
        ownedBinary: false,
        // `--session <id>` (-s) continues a specific session; `--continue` (-c)
        // continues the last one. Read from opencode.ai/docs/cli, which lists
        // both on `tui`, `run` and `attach`.
        resume: { kind: 'flag', token: '--session', continueFlag: '--continue', aliases: ['-s', '-c'] },
    },
    qwen: {
        id: 'qwen',
        label: 'Qwen Code',
        hint: 'Launch the Qwen Code CLI',
        defaultCommand: 'qwen',
        commandSettingKey: 'agent_command_qwen',
        flagsSettingKey: 'agent_flags_qwen',
        ownedBinary: false,
        // Its documentation lists interactive, headless, daemon and bot modes,
        // and no session resumption.
        resume: null,
    },
    vibe: {
        id: 'vibe',
        label: 'Mistral Vibe',
        hint: 'Launch the Mistral Vibe CLI',
        // `vibe`. NOT `mistral-code` — the npm package of that name is published
        // at 0.0.0 and is not the product; Mistral's terminal agent is Mistral
        // Vibe, distributed through PyPI and a vendor install script.
        defaultCommand: 'vibe',
        commandSettingKey: 'agent_command_vibe',
        flagsSettingKey: 'agent_flags_vibe',
        ownedBinary: false,
        // `--resume SESSION_ID` resumes a specific session (bare `--resume`
        // opens a picker, which is why the id form is the token); `--continue`
        // (-c) continues the most recent. Read from the mistralai/mistral-vibe
        // README.
        resume: { kind: 'flag', token: '--resume', continueFlag: '--continue', aliases: ['-c'] },
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
        // A custom agent IS its command; Genie cannot know how that wrapper
        // resumes, and guessing would look like a restart and behave like a
        // fresh start.
        resume: null,
    },
};

/** The providers, in a stable order every derived surface shares. */
export function agentTuis(): AgentTuiId[] {
    return [...PROVIDER_IDS];
}

/** True when `value` names a provider. The one membership test. */
export function isTuiId(value: unknown): value is AgentTuiId {
    return typeof value === 'string' && Object.hasOwn(TUI_REGISTRY, value);
}

/** A provider's definition. Callers hold an `AgentTuiId`, so it exists. */
export function providerDef(id: AgentTuiId): TuiDef {
    return TUI_REGISTRY[id];
}

/**
 * True when this provider can re-enter a captured chat session — the ONE answer
 * behind both `renderAgentResume` and the "Restart agent" menu item.
 *
 * Takes `unknown` rather than `AgentTuiId` because the callers that need it hold
 * a STORED string: `spec.meta.agent` comes out of SQLite and can name a provider
 * written by a newer build. An unknown provider answers `false` — the same as a
 * provider with no grammar, and for the same reason.
 */
export function canResumeTui(value: unknown): boolean {
    return isTuiId(value) && TUI_REGISTRY[value].resume !== null;
}

/**
 * The provider half of the settings shape. Intersected into `Settings` in
 * `db.ts`, so adding a provider adds its two keys with no edit there.
 */
export type ProviderSettingKey = `agent_command_${AgentTuiId}` | `agent_flags_${AgentTuiId}`;

export type ProviderSettingKeys = {
    [K in ProviderSettingKey]?: string;
};

/**
 * The default value for every provider setting.
 *
 * `db.ts` listed all six by hand; a provider added without its two lines got
 * `undefined` where a string was expected. Commands default to the registry's
 * `defaultCommand` (empty for `custom`, deliberately), flags to ''.
 */
export function tuiSettingDefaults(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of agentTuis()) {
        const def = TUI_REGISTRY[id];
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
    id: AgentTuiId;
    command: string;
    flags: string;
}[] {
    return agentTuis().map((id) => ({
        id,
        command: TUI_REGISTRY[id].commandSettingKey,
        flags: TUI_REGISTRY[id].flagsSettingKey,
    }));
}
