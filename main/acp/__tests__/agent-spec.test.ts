import { describe, expect, it } from 'vitest';
import { ACP_PROVIDERS, acpEnv, acpLaunch, nodeMajorOk } from '../agent-spec';

/**
 * How a provider CLI becomes an ACP server, and what environment it gets.
 *
 * `acpEnv` is the most consequential function in the ACP work, because it is where
 * the owner's actual requirement lives: **run on the provider subscription, never on
 * an API token.** Getting it wrong does not fail — it bills per token while the UI
 * says "subscription", which is the quietest possible way to be wrong about money.
 */

const ctx = (over: Partial<{ nodeExec: string; hostScript: () => string | null }> = {}) => ({
    nodeExec: '/usr/bin/node',
    hostScript: () => '/app/main/acp/prism-host.mjs',
    ...over,
});

describe('acpLaunch', () => {
    it('runs OUR prism host as a script under the chosen Node', () => {
        // Not a package `bin`: prism-acp ships none, and a published bin on Windows is a
        // `.cmd` shim that re-enters whatever `node` is first on PATH, defeating the
        // runtime choice. Owning the entry removes the shim from the picture.
        expect(acpLaunch('claude', ctx())).toEqual({
            ok: true,
            launch: { command: '/usr/bin/node', args: ['/app/main/acp/prism-host.mjs'] },
        });
    });

    it('DRIVES codex now, because prism-acp 0.5.0 ships a Codex driver', () => {
        // It refused until 2026-10-08, when prism published one. Measured in the installed package
        // rather than taken from a changelog: `dist/codex/driver.js` exists and the index exports
        // `CodexDriver`.
        //
        // CAPABILITY, not routing. `ACP_PROVIDERS` still excludes codex, so `engineFor` keeps every
        // codex agent on the pty — conflating the two is what once sent them all to an engine that
        // refused them and never started. Flipping that is a separate decision and wants a measured
        // handshake first, exactly as claude's did.
        expect(acpLaunch('codex', ctx())).toEqual({
            ok: true,
            launch: { command: '/usr/bin/node', args: ['/app/main/acp/prism-host.mjs'] },
        });
    });

    it('uses the NATIVE mode for gemini and kimi, which need no adapter', () => {
        expect(acpLaunch('gemini', ctx())).toEqual({ ok: true, launch: { command: 'gemini', args: ['--acp'] } });
        expect(acpLaunch('kimi', ctx())).toEqual({ ok: true, launch: { command: 'kimi', args: ['acp'] } });
    });

    it('refuses a provider with no ACP mode, and says WHICH', () => {
        expect(acpLaunch('aider', ctx())).toEqual({ ok: false, reason: 'no-acp-mode', provider: 'aider' });
    });

    it('distinguishes a MISSING HOST from "no ACP mode"', () => {
        // Two different sentences in front of a human: one is "this provider does not do
        // that", the other is "the thing that would do it is missing" -- and only the
        // second is a packaging fault we can fix.
        expect(acpLaunch('claude', ctx({ hostScript: () => null }))).toEqual({
            ok: false,
            reason: 'host-missing',
        });
    });

    it('lists exactly the providers that can ACTUALLY run on ACP', () => {
        /**
         * CODEX IS IN THE LIST NOW, and the condition this test itself recorded is why.
         *
         * It used to assert `['claude', 'gemini', 'kimi']` with the comment: *"codex was here and
         * `acpLaunch` refused it `no-acp-mode` … It returns when prism ships a codex driver; the
         * third-party adapter is not an option (owner: NO 3RD PARTY)."* That was a CONDITION, not a
         * decision waiting on anybody, and all of it has been met:
         *
         *  - prism-acp 0.5.4 ships a **first-party** `CodexDriver`, so the NO-3RD-PARTY constraint
         *    holds.
         *  - `handshake-codex.real.test.ts` starts a real child, completes `initialize` with **no API
         *    key in its environment**, and drives a real turn at `stopReason=end_turn` — the same bar
         *    claude cleared, measured rather than read off a release note.
         *  - `PRISM_DRIVES` has contained `codex` since 0.5.0, so `acpLaunch('codex')` already
         *    succeeded and this list was the sole holdback. The rule the list exists for — that
         *    `ACP_PROVIDERS` and `acpLaunch` must agree — now agrees in both directions, which is
         *    exactly what the sibling test below walks the list to prove.
         *
         * The owner's plan says it outright: *"Providers: Claude first, Codex right after."*
         *
         * Rewritten to the new contract, not loosened — the assertion is still exact, so adding a
         * provider `acpLaunch` cannot drive still fails here.
         */
        expect([...ACP_PROVIDERS].sort()).toEqual(['claude', 'codex', 'gemini', 'kimi']);
    });

    it('tells the child WHICH driver to serve, because the host is no longer claude-only', () => {
        // `prism-host.mjs` reads `GENIE_ACP_PROVIDER` and picks `CodexDriver` or `ClaudeDriver`. In
        // the ENV rather than argv: the argv is `[script]` and nothing else, so one place decides
        // how this child is launched.
        expect(acpEnv('codex', { PATH: '/bin' }, { auth: 'subscription' }).GENIE_ACP_PROVIDER).toBe(
            'codex',
        );
        expect(acpEnv('claude', { PATH: '/bin' }, { auth: 'subscription' }).GENIE_ACP_PROVIDER).toBe(
            'claude',
        );
    });
});

describe('acpEnv — the subscription requirement', () => {
    const host = {
        PATH: '/usr/bin',
        HOME: '/home/me',
        USERPROFILE: 'C:\\Users\\me',
        LANG: 'en_US.UTF-8',
        SOME_SECRET: 'nope',
    };

    it('passes HOME through, because that is HOW the subscription is found', () => {
        // The Claude Agent SDK resolves CLAUDE_CONFIG_DIR ?? ~/.claude and reads
        // .credentials.json from it. Drop HOME and the logged-in subscription becomes
        // invisible — the agent then looks for an API key instead.
        const env = acpEnv('claude', host, { auth: 'subscription' });
        expect(env.HOME).toBe('/home/me');
        expect(env.USERPROFILE).toBe('C:\\Users\\me');
    });

    it('passes CLAUDE_CONFIG_DIR through when the host sets one', () => {
        const env = acpEnv('claude', { ...host, CLAUDE_CONFIG_DIR: '/custom/.claude' }, { auth: 'subscription' });
        expect(env.CLAUDE_CONFIG_DIR).toBe('/custom/.claude');
    });

    it('STRIPS ANTHROPIC_API_KEY for a subscription session', () => {
        // THE one that matters. The SDK's credential list is ordered
        // [ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN] — the key
        // is enumerated FIRST, so leaving an ambient one in place silently bills per
        // token while the surface says "subscription". Absent is not enough; it has to
        // be removed.
        const env = acpEnv('claude', { ...host, ANTHROPIC_API_KEY: 'sk-ant-live' }, { auth: 'subscription' });
        expect('ANTHROPIC_API_KEY' in env).toBe(false);
    });

    it('strips the other credential vars that would outrank the subscription', () => {
        const env = acpEnv(
            'claude',
            { ...host, ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://proxy', AWS_BEARER_TOKEN_BEDROCK: 'b' },
            { auth: 'subscription' },
        );
        expect('ANTHROPIC_AUTH_TOKEN' in env).toBe(false);
        expect('AWS_BEARER_TOKEN_BEDROCK' in env).toBe(false);
        // A redirected base url is the same class of hazard: it silently changes who is
        // billed and who sees the prompt.
        expect('ANTHROPIC_BASE_URL' in env).toBe(false);
    });

    it('KEEPS the api key when the session is explicitly an api-key one', () => {
        // The positive control. Without it "the key is absent" would also pass for a
        // function that strips it unconditionally, which would break the api-key path
        // while looking like a win for the subscription one.
        const env = acpEnv('claude', { ...host, ANTHROPIC_API_KEY: 'sk-ant-live' }, { auth: 'api-key' });
        expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-live');
    });

    it('passes a subscription OAuth token through, which is the headless path', () => {
        // `claude setup-token` mints this. It IS a subscription credential, so unlike
        // the api key it survives.
        const env = acpEnv('claude', { ...host, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-xyz' }, { auth: 'subscription' });
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-xyz');
    });

    it('does not forward unrelated host environment', () => {
        // Deny-by-default. An agent child inherits what it needs to authenticate and
        // run, not the whole ambient environment of a desktop app.
        const env = acpEnv('claude', host, { auth: 'subscription' });
        expect('SOME_SECRET' in env).toBe(false);
    });

    it('keeps PATH and the locale, because the child still has to run', () => {
        const env = acpEnv('claude', host, { auth: 'subscription' });
        expect(env.PATH).toBe('/usr/bin');
        expect(env.LANG).toBe('en_US.UTF-8');
    });

    it('never forwards an undefined value as the string "undefined"', () => {
        const env = acpEnv('claude', { PATH: '/usr/bin', HOME: undefined }, { auth: 'subscription' });
        expect('HOME' in env).toBe(false);
    });
});

describe('nodeMajorOk', () => {
    it('accepts the versions claude-agent-acp declares support for', () => {
        // engines.node is >= 22 on 0.85.1.
        expect(nodeMajorOk('v22.13.0')).toBe(true);
        expect(nodeMajorOk('v24.0.0')).toBe(true);
    });

    it('refuses the pty host runtime, which is pinned below it', () => {
        // The host runs a standalone Node 20.20.2 and bumping it drags the ABI-matched
        // node-pty prebuild along, so ACP must never be spawned on it. Refusing with a
        // named reason beats dying on an unsupported-engine error with nothing on screen.
        expect(nodeMajorOk('v20.20.2')).toBe(false);
    });

    it('refuses a version it cannot parse rather than assuming it is fine', () => {
        expect(nodeMajorOk('')).toBe(false);
        expect(nodeMajorOk('banana')).toBe(false);
    });
});

describe('THE GENIE RIG reaches an ACP child', () => {
    /**
     * The defect this closes, and it is the one that would have made ACP agents useless on a busy
     * workstation.
     *
     * An agent reaches `imDone`, `ForceTheQuestion` and `agentinbox` through Genie's own MCP server,
     * which the claude CLI picks up from the workspace's `.mcp.json` — so an ACP child DOES get the
     * server, because it runs `claude` in that cwd. What it did not get is **its own identity**:
     * `agent-config.ts` says *"Per-terminal resolution for imDone/ForceTheQuestion is preserved
     * server-side via the tools' optional `terminalId` arg (read from GENIE_TERMINAL_ID)"*, and
     * `acpEnv` forwarded neither that variable nor the endpoint URL.
     *
     * The pty path sets both (`terminal/ipc.ts`: `GENIE_MCP_URL: mcpUrl, GENIE_TERMINAL_ID: id`).
     * Without them an ACP agent asking Genie anything in a workspace with more than one terminal is
     * refused — *"Could not determine which terminal to act on"* — which is the error a human sees
     * too, so it is not even a new failure mode, just one nobody had hit from this direction.
     *
     * `imDone` is the Genie protocol's mandatory finish. An agent that cannot call it stalls the
     * work silently, which is the exact failure the protocol exists to prevent.
     */
    const host = { PATH: '/bin', HOME: '/home/me' };

    it('carries the terminal id, so the agent can name itself', () => {
        const env = acpEnv('claude', host, {
            auth: 'subscription',
            genie: { terminalId: 'spec-42', mcpUrl: 'http://127.0.0.1:7777/mcp/abc' },
        });
        expect(env.GENIE_TERMINAL_ID).toBe('spec-42');
        expect(env.GENIE_MCP_URL).toBe('http://127.0.0.1:7777/mcp/abc');
    });

    it('omits BOTH when the workspace has MCP switched off', () => {
        // Not an empty string: `agent-config.ts` records that a referenced-but-unset variable broke
        // every MCP server in a config, and an empty URL is worse than an absent one — it looks
        // configured and resolves nowhere.
        const env = acpEnv('claude', host, { auth: 'subscription' });
        expect('GENIE_TERMINAL_ID' in env).toBe(false);
        expect('GENIE_MCP_URL' in env).toBe(false);
    });

    it('omits the URL but keeps the id when there is no endpoint', () => {
        // `registerTerminalEndpoint` can answer null. The id is still worth passing: the tools take
        // it as an argument and the agent can still name itself to a server reached another way.
        const env = acpEnv('claude', host, {
            auth: 'subscription',
            genie: { terminalId: 'spec-42', mcpUrl: null },
        });
        expect(env.GENIE_TERMINAL_ID).toBe('spec-42');
        expect('GENIE_MCP_URL' in env).toBe(false);
    });

    it('still strips what outranks the subscription, which this must not have loosened', () => {
        // The allow-list is the whole point of this function. Adding two keys to it is exactly the
        // kind of change that quietly lets a third through.
        const env = acpEnv(
            'claude',
            { ...host, ANTHROPIC_API_KEY: 'sk-nope', SOME_SECRET: 'nope' },
            { auth: 'subscription', genie: { terminalId: 's1', mcpUrl: 'http://x/mcp/y' } },
        );
        expect('ANTHROPIC_API_KEY' in env).toBe(false);
        expect('SOME_SECRET' in env).toBe(false);
    });
});
