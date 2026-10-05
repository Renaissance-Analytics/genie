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

describe('acpLaunch', () => {
    it('spawns Claude through the published ACP bin with BARE argv', () => {
        // `claude-agent-acp` takes no flags. Everything — model, config dir, auth —
        // travels in the environment.
        expect(acpLaunch('claude', { binDir: '/n/.bin' })).toEqual({
            command: '/n/.bin/claude-agent-acp',
            args: [],
        });
    });

    it('spawns Codex through its own bin', () => {
        expect(acpLaunch('codex', { binDir: '/n/.bin' })).toEqual({
            command: '/n/.bin/codex-acp',
            args: [],
        });
    });

    it('uses the NATIVE mode for gemini and kimi, which need no adapter', () => {
        // A flag for one, a subcommand for the other. Shipping an adapter for either
        // would be a second thing to keep in step with upstream for no gain.
        expect(acpLaunch('gemini', { binDir: '/n/.bin' })).toEqual({ command: 'gemini', args: ['--acp'] });
        expect(acpLaunch('kimi', { binDir: '/n/.bin' })).toEqual({ command: 'kimi', args: ['acp'] });
    });

    it('refuses a provider with no ACP mode rather than guessing one', () => {
        expect(acpLaunch('aider', { binDir: '/n/.bin' })).toBeNull();
        expect(acpLaunch('goose', { binDir: '/n/.bin' })).toBeNull();
    });

    it('lists exactly the providers that have an ACP mode', () => {
        expect([...ACP_PROVIDERS].sort()).toEqual(['claude', 'codex', 'gemini', 'kimi']);
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
