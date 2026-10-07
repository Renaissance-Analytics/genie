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

    it('REFUSES codex, because prism-acp ships a claude driver only', () => {
        // Pointing codex at the claude host would start something that cannot drive it and
        // then time out in the handshake -- a hang, not a named refusal. Revisit when
        // prism ships a codex driver.
        expect(acpLaunch('codex', ctx())).toEqual({ ok: false, reason: 'no-acp-mode', provider: 'codex' });
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
        // codex was here and `acpLaunch` refused it `no-acp-mode` — so with `acp_engine` on,
        // `engineFor` routed every codex agent to ACP and it never started, leaving one
        // console line as the only symptom. The list must mean capability, not intent.
        // It returns when prism ships a codex driver; the third-party adapter is not an
        // option (owner: NO 3RD PARTY).
        expect([...ACP_PROVIDERS].sort()).toEqual(['claude', 'gemini', 'kimi']);
    });

    it('REFUSES codex by name, rather than pointing it at the claude host', () => {
        // A wrong spawn starts something that cannot drive the provider and then times out
        // in the handshake, which reads as a hung agent instead of an unsupported one.
        expect(acpLaunch('codex', { hostScript: () => '/fake/host.mjs' } as never)).toMatchObject({
            ok: false,
            reason: 'no-acp-mode',
            provider: 'codex',
        });
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
