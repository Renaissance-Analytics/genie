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

/** Where the published adapter bins live (resolved by the caller). */
export interface LaunchContext {
    binDir: string;
}

export function acpLaunch(provider: string, ctx: LaunchContext): AcpLaunch | null {
    switch (provider) {
        case 'claude':
            return { command: `${ctx.binDir}/claude-agent-acp`, args: [] };
        case 'codex':
            return { command: `${ctx.binDir}/codex-acp`, args: [] };
        case 'gemini':
            return { command: 'gemini', args: ['--acp'] };
        case 'kimi':
            return { command: 'kimi', args: ['acp'] };
        default:
            // No ACP mode. Null, not a guess — a wrong spawn starts something that is
            // not an ACP server and then times out in the handshake, which reads as a
            // hung agent rather than an unsupported provider.
            return null;
    }
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
