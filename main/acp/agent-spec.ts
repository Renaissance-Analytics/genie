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
export const ACP_PROVIDERS = ['claude', 'codex', 'gemini', 'kimi'] as const;
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

/** Providers prism-acp can actually drive today. Measured in the published package:
 *  `dist/claude/` is the only driver it ships. */
const PRISM_DRIVES = new Set(['claude']);

export function acpLaunch(provider: string, ctx: LaunchContext): LaunchResult {
    // Native ACP modes: a flag for one, a subcommand for the other. No adapter to
    // install, nothing of ours to keep in step, and no third party at all.
    if (provider === 'gemini') return { ok: true, launch: { command: 'gemini', args: ['--acp'] } };
    if (provider === 'kimi') return { ok: true, launch: { command: 'kimi', args: ['acp'] } };

    // Anything prism cannot drive is refused BY NAME rather than pointed at the claude
    // host. A wrong spawn starts something that cannot drive the provider and then times
    // out in the handshake, which reads as a hung agent instead of an unsupported one.
    // codex lands here until prism ships its driver.
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
}

export type HostEnv = Record<string, string | undefined>;

export function acpEnv(_provider: string, host: HostEnv, opts: AcpAuth): Record<string, string> {
    const env: Record<string, string> = {};

    const take = (key: string) => {
        const value = host[key];
        // Never forward an undefined as the string "undefined" — a child reading
        // CLAUDE_CONFIG_DIR="undefined" would look for its login in a directory named
        // that and report no credentials.
        if (typeof value === 'string') env[key] = value;
    };

    for (const key of INHERITED) take(key);
    for (const key of SUBSCRIPTION_CREDENTIALS) take(key);

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
