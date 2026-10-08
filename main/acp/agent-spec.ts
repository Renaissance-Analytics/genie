/**
 * How a provider CLI becomes an ACP server, and what environment it gets.
 *
 * Two kinds of provider:
 *
 * - **claude, codex** run through a published adapter bin (`claude-agent-acp`,
 *   `codex-acp`) that embeds the provider SDK. Argv is BARE — the adapters take no
 *   flags, and everything (model, config dir, auth) travels in the environment.
 * - **gemini, kimi** speak ACP natively: a flag for one, a subcommand for the other.
 *   Shipping an adapter for either would be a second thing to keep in step with
 *   upstream for no gain.
 *
 * Everything else refuses. A provider with no ACP mode returns null rather than a
 * guessed command, because a wrong spawn does not error cleanly — it starts something
 * that is not an ACP server and then times out in the handshake.
 *
 * ## `acpEnv` is where the owner's requirement lives
 *
 * **Run on the provider subscription, never on an API token.** That is satisfied by
 * passing `HOME`/`USERPROFILE` and `CLAUDE_CONFIG_DIR` through — the Claude Agent SDK
 * resolves `CLAUDE_CONFIG_DIR ?? ~/.claude` and reads `.credentials.json` from it, so
 * the logged-in subscription is found the same way the CLI finds it. Measured against
 * the published SDK bundle, not inferred.
 *
 * And it is BROKEN by leaving an ambient `ANTHROPIC_API_KEY` in place. The SDK's own
 * credential list is ordered `[ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
 * CLAUDE_CODE_OAUTH_TOKEN, …]` — the key is enumerated FIRST. So an API key that
 * happens to be in the environment silently bills per token while the surface says
 * "subscription", which is the quietest possible way to be wrong about money. It is
 * STRIPPED, not merely left unset.
 */

/** Providers with an ACP mode. The rest stay on the pty. */
/**
 * Providers that can ACTUALLY run on ACP today.
 *
 * `engineFor` reads this to route an agent to the ACP engine, and `acpLaunch` below decides
 * what to spawn. **The two must agree.** When they do not, the agent is routed to an engine
 * that then refuses it, and the only symptom is one console line (`[acp] … did not start`)
 * and an agent that sits in the roster doing nothing — no exception, no failing test, no UI.
 *
 * **codex is here now, and the condition this comment set is why.** It used to read: *"codex is
 * deliberately absent … it returns the moment prism can drive it. The third-party `codex-acp`
 * adapter is not an option (owner: NO 3RD PARTY), which is why this waits on prism rather than on
 * npm."* That was a CONDITION, not a decision pending anybody, and it has been met:
 *
 *  - **prism-acp 0.5.4 ships a first-party `CodexDriver`** — no third party, which was the owner's
 *    constraint.
 *  - **Measured, not read off a release note.** `handshake-codex.real.test.ts` starts a real child,
 *    completes `initialize` with **no API key in its environment**, and drives a real turn
 *    (`stopReason=end_turn`). Same bar claude cleared.
 *  - **`acpLaunch` already drove it.** `PRISM_DRIVES` has contained `codex` since 0.5.0, so this list
 *    was the only holdback — and the rule that the two must agree now agrees in both directions.
 *
 * And the owner's plan says so outright: *"Providers: **Claude first, Codex right after.**"*
 *
 * Still CAPABILITY rather than a promise. `launchPlan` holds an agent on the pty when its command
 * carries anything Genie did not add, and `withCodexMcpLaunch` weaves `-c` TOML into every codex
 * command in an MCP-enabled workspace — so most codex agents stay on the pty regardless, which is
 * correct, because ACP cannot carry those flags.
 */
export const ACP_PROVIDERS = ['claude', 'codex', 'gemini', 'kimi'] as const;

/**
 * HOW A CLAUDE ACP CHILD HANDLES PERMISSIONS — and why it needs telling at all (genie#838).
 *
 * Genie passed the claude CLI no `--permission-mode`, and without one it DENIES every tool
 * call. Measured against a real child on 2026-10-08:
 *
 *   > Permission to use Write has been denied because Claude Code is running in
 *   > don't ask mode.
 *
 * Three turns, three working directories: the two launched as Genie shipped left the
 * directory EMPTY; the one launched with a mode left the file in it. So an ACP agent could
 * not edit anything — the whole point of version 2 — while the pty path it replaced had
 * always been able to, because `main/agents/os-agent.ts` appends
 * `--dangerously-skip-permissions` and the normal agent launch does too.
 *
 * ## Why `bypassPermissions` and not a mode that asks
 *
 * Because asking is not reachable for this provider. prism's ACP layer forwards permission
 * requests properly and **CodexDriver raises them** — but **ClaudeDriver has no permission
 * plumbing at all**: no `onRequestPermission` in its events interface, nothing in its
 * implementation. Zero requests arrived across three real turns. So claude's only two
 * reachable states are "proceeds" and "denied":
 *
 *   - `manual` / `dontAsk` — denied, which is today's bug.
 *   - `acceptEdits` — allows edits, denies `Bash`. Measured, a denied call makes the agent
 *     THRASH: when `Write` was refused it immediately tried PowerShell instead. A
 *     half-open mode buys no safety and costs a wasted tool call per attempt.
 *   - `bypassPermissions` — parity with the pty path, which is the behaviour every Genie
 *     agent has shipped with. Not a new exposure; the same one, restored.
 *
 * This is the root-cause fix available to GENIE. The better fix is prism's: a ClaudeDriver
 * that can ask, so `manual` works and the inline-approval rail — which Genie already
 * implements in `acp/permission.ts` — stops being dead code for the default provider.
 * Filed upstream; when it lands, this constant is what changes.
 */
export const CLAUDE_ACP_PERMISSION_MODE = 'bypassPermissions';
export type AcpProvider = (typeof ACP_PROVIDERS)[number];

export interface AcpLaunch {
    command: string;
    args: string[];
}

export interface LaunchContext {
    /**
     * The Node executable an adapter is run WITH.
     *
     * Adapters are launched as `<node> <script>`, never through their `bin` shim. The
     * shim is `claude-agent-acp.cmd` on Windows — so the bare name does not even exist
     * there, which is how this was found — and more importantly a shim re-enters
     * whatever `node` is first on PATH, which silently defeats choosing the runtime at
     * all. Measured: the bare-name spawn failed ENOENT against a real install.
     */
    nodeExec: string;
    /**
     * Absolute path to our ACP host script, or null when it is not where it should be.
     *
     * Ours rather than a package's `bin`, because prism-acp ships no bin -- and because a
     * published bin on Windows is a `.cmd` shim that re-enters whatever `node` is first on
     * PATH, silently defeating the choice of runtime. Measured: a bare-name spawn failed
     * ENOENT against a real install.
     */
    hostScript: () => string | null;
}

/** Why a provider cannot run over ACP, when it cannot. The two reasons need different
 *  words in front of a human: one is "this provider does not do that", the other is
 *  "the thing that would do it is not installed". */
export type LaunchRefusal =
    | { reason: 'no-acp-mode'; provider: string }
    /** Our host script is not on disk -- a packaging fault, not a user one. */
    | { reason: 'host-missing' };

export type LaunchResult = { ok: true; launch: AcpLaunch } | { ok: false } & LaunchRefusal;

/**
 * Our own ESM host over `@particle-academy/prism-acp`.
 *
 * Prism owns the agentic transport (owner ruling), and prism-acp is a LIBRARY with no
 * `bin` -- so Genie supplies the entry rather than spawning a package's shim. `.mjs`
 * because prism-acp is ESM-only and this tree is CommonJS.
 */
export const PRISM_HOST_FILENAME = 'prism-host.mjs';

/**
 * Providers prism-acp can actually drive today.
 *
 * Measured in the published package rather than taken from a changelog: 0.5.0 ships
 * `dist/claude/` AND `dist/codex/`, and exports `CodexDriver` from its index. It was claude alone
 * until 2026-10-08.
 *
 * The list means CAPABILITY. Whether a provider is ROUTED here is `ACP_PROVIDERS` + `engineFor`,
 * and the two are deliberately separate — conflating them is what sent every codex agent to an
 * engine that refused it and never started.
 */
const PRISM_DRIVES = new Set(['claude', 'codex']);

export function acpLaunch(provider: string, ctx: LaunchContext): LaunchResult {
    // Native ACP modes: a flag for one, a subcommand for the other. No adapter to
    // install, nothing of ours to keep in step, and no third party at all.
    if (provider === 'gemini') return { ok: true, launch: { command: 'gemini', args: ['--acp'] } };
    if (provider === 'kimi') return { ok: true, launch: { command: 'kimi', args: ['acp'] } };

    // Anything prism cannot drive is refused BY NAME rather than pointed at the claude
    // host. A wrong spawn starts something that cannot drive the provider and then times
    // out in the handshake, which reads as a hung agent instead of an unsupported one.
    // aider, goose and the rest land here: no ACP mode and no prism driver, so they stay on the
    // pty where they work. They are absent from `ACP_PROVIDERS` for the same reason, so `engineFor`
    // never routes them here in the first place — this is the second line of defence.
    if (!PRISM_DRIVES.has(provider)) return { ok: false, reason: 'no-acp-mode', provider };

    const script = ctx.hostScript();
    // A missing host is a PACKAGING fault. Spawning `node` with no script opens a REPL
    // that never answers the handshake -- a hang rather than a named failure.
    if (!script) return { ok: false, reason: 'host-missing' };

    return { ok: true, launch: { command: ctx.nodeExec, args: [script] } };
}

/** Host variables the child needs in order to run and to find its login. */
const INHERITED = [
    'PATH',
    'Path',
    // HOME and USERPROFILE are how the subscription is found at all.
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'SHELL',
    'SystemRoot',
    'COMSPEC',
    // Corporate TLS interception breaks the child's own HTTPS without these.
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
] as const;

/** Credential variables that would OUTRANK a stored subscription login. */
const OUTRANKS_SUBSCRIPTION = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK',
    'ANTHROPIC_FOUNDRY_API_KEY',
    'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
    'ANTHROPIC_AWS_API_KEY',
    // Not a credential, but the same class of hazard: it silently changes who is billed
    // and who sees the prompt.
    'ANTHROPIC_BASE_URL',
] as const;

/** Credential variables that ARE subscription credentials and must survive. */
const SUBSCRIPTION_CREDENTIALS = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME'] as const;

export interface AcpAuth {
    /** `subscription` strips anything that would outrank the stored login.
     *  `api-key` is the deliberate opt-in and keeps it. */
    auth: 'subscription' | 'api-key';
    /**
     * THE GENIE RIG — this agent's own identity, so it can call Genie back.
     *
     * An ACP child gets the genie MCP server for free: the CLI reads the workspace's `.mcp.json`,
     * and the child runs in that cwd. What it did not get is its own NAME. `agent-config.ts`:
     * *"Per-terminal resolution for imDone/ForceTheQuestion is preserved server-side via the
     * tools' optional `terminalId` arg (read from GENIE_TERMINAL_ID)"* — and this function
     * forwarded neither that nor the endpoint, while the pty path sets both.
     *
     * So an ACP agent calling `imDone` in a workspace with more than one terminal was refused
     * — *"Could not determine which terminal to act on"* — and `imDone` is the protocol's
     * mandatory finish. An agent that cannot call it stalls the work in silence.
     *
     * Absent means the workspace has MCP switched off, and then NEITHER variable is set: an
     * empty URL is worse than a missing one, because it looks configured and resolves nowhere
     * (`agent-config.ts` records a referenced-but-unset var breaking every server in a config).
     */
    genie?: {
        /** The terminal spec id this agent IS. */
        terminalId: string;
        /** The workspace's genie endpoint, or null when there is none to give. */
        mcpUrl: string | null;
    };
}

export type HostEnv = Record<string, string | undefined>;

export function acpEnv(provider: string, host: HostEnv, opts: AcpAuth): Record<string, string> {
    const env: Record<string, string> = {
        /**
         * WHICH DRIVER the host script should serve.
         *
         * prism-acp 0.5.0 ships a Codex driver beside the Claude one, so `prism-host.mjs` is no
         * longer claude-only and needs telling. In the ENV rather than as an argv flag, because the
         * argv is `[script]` and nothing else — one place decides how this child is launched, and
         * the env is already the allow-listed thing this function exists to build.
         */
        GENIE_ACP_PROVIDER: provider,

        /**
         * HOW TO HANDLE PERMISSIONS — claude only, deliberately.
         *
         * See {@link CLAUDE_ACP_PERMISSION_MODE} for why the mode is needed and why it is
         * this one. The reason it is claude-ONLY is the asymmetry between the two drivers:
         * **CodexDriver raises permission requests and Genie answers them**, so codex already
         * has a human in the loop. Handing codex a mode would take that away to fix a problem
         * it does not have — and gemini and kimi are in `ACP_PROVIDERS` without anyone having
         * measured them, so silence is the right default and claude is the named exception.
         */
        ...(provider === 'claude' ? { GENIE_ACP_PERMISSION_MODE: CLAUDE_ACP_PERMISSION_MODE } : {}),
    };

    const take = (key: string) => {
        const value = host[key];
        // Never forward an undefined as the string "undefined" — a child reading
        // CLAUDE_CONFIG_DIR="undefined" would look for its login in a directory named
        // that and report no credentials.
        if (typeof value === 'string') env[key] = value;
    };

    for (const key of INHERITED) take(key);
    for (const key of SUBSCRIPTION_CREDENTIALS) take(key);

    if (opts.genie) {
        env.GENIE_TERMINAL_ID = opts.genie.terminalId;
        // The URL only when there IS one. See the note on `genie` above for why an empty string is
        // the worse of the two failures.
        if (opts.genie.mcpUrl) env.GENIE_MCP_URL = opts.genie.mcpUrl;
    }

    if (opts.auth === 'api-key') {
        // The explicit opt-in. Forwarded on purpose.
        for (const key of OUTRANKS_SUBSCRIPTION) take(key);
    }
    // Otherwise they are simply never copied in, which is what "stripped" means when
    // the environment is built allow-list first rather than inherited and pruned.

    return env;
}

/**
 * Whether a Node runtime can host the ACP adapters.
 *
 * `claude-agent-acp@0.85.1` declares `engines.node >= 22`. The pty host's standalone
 * runtime is pinned at **20.20.2**, and bumping it drags the ABI-matched `node-pty`
 * prebuild along — which is the coupling that used to kill live terminals on every
 * upgrade. So ACP must never be spawned on that runtime, and refusing with a named
 * reason beats dying on an unsupported-engine error with nothing on screen.
 *
 * An unparseable version refuses too: assuming it is fine is how the refusal gets
 * skipped on exactly the platform nobody tested.
 */
export const ACP_MIN_NODE_MAJOR = 22;

export function nodeMajorOk(version: string): boolean {
    const match = /^v?(\d+)\./.exec(version.trim());
    if (!match) return false;
    return Number(match[1]) >= ACP_MIN_NODE_MAJOR;
}
