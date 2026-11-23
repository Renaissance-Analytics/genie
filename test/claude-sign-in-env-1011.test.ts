import { homedir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE BROWSER SIGN-IN, ITS SIGN-OUT AND ITS STATUS CHECK RUN IN THE ACCOUNT'S OWN FOLDER, WITH NO HOME VARIABLE OF GENIE'S OWN
 * SURROUNDINGS (Tynn #1011; the review of #2139, finding 6). The terminal login this replaced was held to "no home variable"
 * for Claude in accounts-launch-home-476, same-home-753 and shell-line-callers; the browser one had no such test. prism-acp is
 * given the account's configDir and sets the CLI's directory from it; what Genie adds beside it (the binary, the variables let
 * through) must never carry a CLAUDE_CONFIG_DIR or CODEX_HOME from the host's own environment, in any spelling, which would
 * point the sign-in at another folder than the account's. Fixtures name no person; no CLI runs here.
 */
const seen = vi.hoisted(() => ({ login: [] as unknown[][], logout: [] as unknown[][], describe: [] as unknown[][] }));
vi.mock('@particle-academy/prism-acp', async (original) => {
    const real = await original<typeof import('@particle-academy/prism-acp')>();
    return {
        ...real,
        claudeAccounts: {
            ...real.claudeAccounts,
            login: async (...args: unknown[]) => { seen.login.push(args); return { signedIn: true, email: 'team@example.invalid' }; },
            logout: async (...args: unknown[]) => { seen.logout.push(args); return { signedIn: false }; },
            describe: async (...args: unknown[]) => { seen.describe.push(args); return { signedIn: false }; },
        },
    };
});

const { childEnv } = await import('@particle-academy/prism-acp');
const { ClaudeSignIns, realClaudeLogin } = await import('../src/main/claude-sign-ins.js');
const { realClaudeCliOptions, realDescribeClaude } = await import('../src/main/session-host.js');
type Ports = import('../src/main/claude-sign-ins.js').ClaudeSignInPorts;
type Account = import('../src/core/accounts.js').AccountRecord;

type Options = { parentEnv?: Readonly<Record<string, string | undefined>>; allowEnv?: readonly string[]; cwd?: string; signal?: AbortSignal; method?: string; email?: string };
const DIR = `/g/accounts/claude/account_${'1'.repeat(32)}`;
const HOSTILE = { CLAUDE_CONFIG_DIR: '/workspace/other-claude', claude_config_dir: '/workspace/lower-claude', CODEX_HOME: '/workspace/other-codex', Codex_Home: '/workspace/mixed-codex' };
/** What the CLI would be given of the host's environment: prism-acp's own allow-list, with what Genie let through. */
const given = (o: Options): Record<string, string | undefined> => childEnv(o.parentEnv ?? process.env, { allow: o.allowEnv ?? [] }).env;
const homes = (env: Record<string, string | undefined>): string[] => Object.keys(env).filter((k) => /^(CLAUDE_CONFIG_DIR|CODEX_HOME)$/i.test(k));

beforeEach(() => {
    seen.login.length = 0; seen.logout.length = 0; seen.describe.length = 0;
    for (const [k, v] of Object.entries(HOSTILE)) vi.stubEnv(k, v);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('the CLI a Claude sign-in runs: no home variable from the host\'s environment', () => {
    it('the gauge reads one: the host\'s environment does carry them here, and an allow-list that names one lets it through', () => {
        expect(homes(process.env).length).toBeGreaterThan(0);
        // prism-acp's allow-list takes a name in any spelling (measured on Linux, Azure job 1123-133523-c10aa9: the lowercase
        // one came through beside it), so the gauge asks only that the name allowed is there.
        expect(homes(given({ allowEnv: ['CLAUDE_CONFIG_DIR'] }))).toContain('CLAUDE_CONFIG_DIR');
    });

    it('realClaudeCliOptions lets none through', () => {
        expect(homes(given(realClaudeCliOptions()))).toEqual([]);
    });

    it('login(): the account\'s folder, the person\'s choices, and no home variable', async () => {
        const controller = new AbortController();
        const onUrl = () => {};
        await realClaudeLogin(() => realClaudeCliOptions()).login(DIR, { method: 'console', email: 'team@example.invalid', onUrl, signal: controller.signal });
        expect(seen.login).toHaveLength(1);
        const [dir, options] = seen.login[0] as [string, Options & { onUrl: unknown }];
        expect(dir).toBe(DIR);
        expect(options).toMatchObject({ method: 'console', email: 'team@example.invalid' });
        expect(options.onUrl).toBe(onUrl);
        expect(options.signal).toBe(controller.signal);
        expect(homes(given(options))).toEqual([]);
    });

    it('logout(): the account\'s folder, and no home variable', async () => {
        await realClaudeLogin(() => realClaudeCliOptions()).logout(DIR);
        const [dir, options] = seen.logout[0] as [string, Options];
        expect(dir).toBe(DIR);
        expect(homes(given(options))).toEqual([]);
    });

    it('the status check (describe): the account\'s folder, asked from the home folder, and no home variable', async () => {
        await realDescribeClaude(DIR);
        const [dir, options] = seen.describe[0] as [string, Options];
        expect(dir).toBe(DIR);
        expect(options.cwd).toBe(homedir());
        expect(homes(given(options))).toEqual([]);
    });
});

describe('a sign-in and a sign-out reach prism-acp with the ACCOUNT\'s folder, never another', () => {
    const OWN: Account = { id: `account_${'1'.repeat(32)}`, provider: 'claude', label: 'Team API', labelEdited: true, home: '/home/.claude', legacy: false,
        identity: { name: null, email: 'team@example.invalid', plan: null }, createdAt: '2026-11-21T00:00:00Z', configDir: DIR, method: 'console' };
    const ports = (): Ports => ({
        get: (id) => (id === OWN.id ? OWN : null), activeId: () => 'account_legacy_claude',
        addClaude: async () => { throw new Error('not in this test'); }, setActive: async () => {}, activated: () => {}, recordIdentity: async () => {}, forget: async () => {},
        removeDir: () => ({ ok: true }), open: async () => {}, changed: () => {}, tell: () => {}, platform: 'linux',
        inUse: () => 0, signedInNow: async () => false, prepare: () => {}, ended: () => {}, signedInActive: () => {},
        ...realClaudeLogin(() => realClaudeCliOptions()),
        describe: (configDir) => realDescribeClaude(configDir),
    });

    it('Sign in runs login() in that account\'s folder', async () => {
        const s = new ClaudeSignIns(ports());
        expect(await s.signIn(OWN.id)).toEqual({ ok: true });
        await vi.waitFor(() => expect(s.view()).toEqual([]));
        expect(seen.login.map((c) => c[0])).toEqual([DIR]);
        expect(homes(given(seen.login[0]![1] as Options))).toEqual([]);
    });

    it('Sign out and remove runs logout() and the status check in that account\'s folder', async () => {
        const s = new ClaudeSignIns(ports());
        expect(await s.signOut(OWN.id)).toEqual({ ok: true });
        expect(seen.logout.map((c) => c[0])).toEqual([DIR]);
        expect(seen.describe.map((c) => c[0])).toEqual([DIR]);
    });
});
