import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv } from '@particle-academy/prism-acp';
import type { SessionStore } from '@particle-academy/prism-harness';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountRecord, ProviderAccountHome } from '../src/core/accounts.js';
import { DESIGN_LOGIN } from '../src/core/design-login.js';
import type { AcpProvider } from '../src/core/engine.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { SessionDriverFactory } from '../src/core/session.js';
import { LoginHost, type LoginHostOptions } from '../src/main/login-host.js';
import { checkProviderHealth, type ProviderHealthPorts } from '../src/main/provider-health.js';
import { listModelsOptionsFor, providerLaunchOptions, serviceEnvDriverOptions, SessionHost, type DriverFor } from '../src/main/session-host.js';

type Env = Readonly<Record<string, string | undefined>>;
const account = (provider: AcpProvider, suffix = 'a'): AccountRecord => ({
    id: `account_${suffix.repeat(32)}`, provider, home: `/genie/accounts/${provider}/${suffix}`,
    label: 'Fixture account', labelEdited: false, legacy: false,
    identity: { name: null, email: null, plan: null }, createdAt: '2026-11-15T00:00:00Z',
});
const variable = (provider: AcpProvider) => provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
const injected = { CLAUDE_CONFIG_DIR: '/workspace/other-claude', claude_config_dir: '/workspace/lower-claude',
    CODEX_HOME: '/workspace/other-codex', Codex_Home: '/workspace/mixed-codex', DB_PORT: '4312' };
// ONE HOME PER PROVIDER (Tynn #753): no launch, probe, Take Over or sign-in sets a home variable, whatever account it is for.
const noHome = (env: Env) => {
    expect(Object.keys(env).filter(k => /^(CLAUDE_CONFIG_DIR|CODEX_HOME)$/i.test(k))).toEqual([]);
};
const dirs: string[] = [];
const hosts: SessionHost[] = [];
const directory = async () => { const p = await mkdtemp(join(tmpdir(), 'genie-476-')); dirs.push(p); return p; };
afterEach(async () => {
    for (const host of hosts.splice(0)) host.stopAll();
    vi.unstubAllEnvs();
    for (const p of dirs.splice(0)) await rm(p, { recursive: true, force: true });
});

// No disk durability or subprocess is claimed here: real SessionHost plumbing,
// an in-memory thread store, and inert drivers isolate the launch-home contract.
function memoryStore(): SessionStore {
    const kv = new Map<string, Record<string, unknown>>();
    const logs = new Map<string, Record<string, unknown>[]>();
    return {
        get: async (k: string) => kv.get(k) ?? null,
        put: async (k: string, v: Record<string, unknown>) => { kv.set(k, v); },
        forget: async (k: string) => { kv.delete(k); logs.delete(k); },
        withLock: async <T>(_k: string, cb: () => T | Promise<T>) => cb(),
        durability: () => 'durable',
        appendLog: async (k: string, rows: readonly Record<string, unknown>[]) => { logs.set(k, [...(logs.get(k) ?? []), ...rows]); },
        readLog: async (k: string) => logs.get(k) ?? null,
        logLength: async (k: string) => logs.get(k)?.length ?? null,
        clearLog: async (k: string) => { logs.set(k, []); },
    } as unknown as SessionStore;
}
const noProcesses: ProcessTree = { snapshot: () => [], killTree: pids => ({ killed: pids.length, refused: false }) };
const inert: SessionDriverFactory = () => ({ start: () => {}, prompt: () => {}, kill: () => {}, cliSessionId: null });
type Launch = (configured: string | undefined, service: Readonly<Record<string, string>>,
    runtime: { execPath: string; electron: boolean }, account?: AccountRecord) => ReturnType<typeof providerLaunchOptions>;
const launch = providerLaunchOptions as Launch;
type AccountHostOptions = ConstructorParameters<typeof SessionHost>[0];

function hostFixture(dir: string, a: AccountRecord | null, deferred = false) {
    const seen: Array<{ record: AgentRecord; resume: string | null; account?: AccountRecord; env: Env }> = [];
    const driverFor: DriverFor = (record, _cwd, resume, extras) => {
        const bound = (extras as (typeof extras & { account?: AccountRecord }))?.account;
        const opts = launch(undefined, extras?.serviceEnv ?? {}, { execPath: '/usr/bin/node', electron: false }, bound);
        seen.push({ record, resume, ...(bound ? { account: bound } : {}), env: childEnv(opts.parentEnv ?? {}, { allow: opts.allowEnv ?? [] }).env });
        return inert;
    };
    const options: AccountHostOptions = { userData: dir, store: memoryStore, driverFor, processTree: noProcesses,
        serviceEnvFor: () => injected, activeAccount: () => a,
        ...(deferred ? { prepareMcpServers: async () => [] } : {}) };
    const host = new SessionHost(options); hosts.push(host);
    return { host, seen };
}

describe('S3: the actual driver allow-list', () => {
    it.each([
        ['claude', undefined, false], ['codex', '/bin/codex', false],
        ['claude', '/fixture/provider.mjs', false], ['codex', '/fixture/provider.mjs', true],
    ] as const)('%s %s electron=%s injects no home through prism childEnv (Tynn #753)', (provider, configured, electron) => {
        const a = account(provider);
        const opts = launch(configured, injected, { execPath: '/fixture/runtime', electron }, a);
        const env = childEnv(opts.parentEnv ?? {}, { allow: opts.allowEnv ?? [] }).env;
        noHome(env);
        expect(env.DB_PORT).toBe('4312');
        if (configured?.endsWith('.mjs')) expect(opts).toMatchObject({ binary: '/fixture/runtime', binaryArgs: [configured] });
        if (electron) expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    });
    it.each([
        ['claude', 'set'], ['codex', 'set'], ['claude', 'unset'], ['codex', 'unset'],
    ] as const)('CONTROL: %s legacy with home variables %s produces exactly the existing child environment', (provider, presence) => {
        vi.stubEnv('CLAUDE_CONFIG_DIR', presence === 'set' ? '/profile/legacy-claude' : undefined);
        vi.stubEnv('CODEX_HOME', presence === 'set' ? '/profile/legacy-codex' : undefined);
        const a = { ...account(provider), id: `account_legacy_${provider}`, legacy: true,
            home: process.env[variable(provider)] ?? `/profile/.${provider}` };
        const runtime = { execPath: '/fixture/runtime', electron: false };
        const old = providerLaunchOptions(undefined, { DB_PORT: '4312' }, runtime);
        const next = launch(undefined, { DB_PORT: '4312' }, runtime, a);
        // The SDK driver already admits its own documented home, independently
        // of Genie's extra allow-list. Compare the effective child env exactly.
        const child = (opts: ReturnType<typeof providerLaunchOptions>) => childEnv(opts.parentEnv ?? process.env,
            { allow: [variable(provider), ...(opts.allowEnv ?? [])] }).env;
        expect(child(next)).toEqual(child(old));
        if (presence === 'set') expect(child(next)[variable(provider)]).toBe(a.home);
        else {
            expect(child(next)).not.toHaveProperty('CLAUDE_CONFIG_DIR');
            expect(child(next)).not.toHaveProperty('CODEX_HOME');
        }
    });
    it('CONTROL: normal service variables still pass through the SDK allow-list', () => {
        const options = serviceEnvDriverOptions({ DB_PORT: '4312' });
        expect(childEnv(options.parentEnv ?? {}, { allow: options.allowEnv ?? [] }).env.DB_PORT).toBe('4312');
    });
});

describe('S3: host launch and resume', () => {
    for (const provider of ['claude', 'codex'] as const) for (const deferred of [false, true]) for (const resume of [null, 'native-thread-A']) {
        it(`${provider} ${deferred ? 'deferred' : 'immediate'} ${resume ? 'resume' : 'fresh'} resolves the provider active account before the driver`, async () => {
            const dir = await directory(), a = account(provider);
            const f = hostFixture(dir, a, deferred);
            const record = { ...agentRecord({ id: mintAgentId(), workspaceId: 'fixture', provider, name: 'fixture' }), threadId: resume };
            expect(f.host.start(record, dir)).toEqual({ ok: true });
            await vi.waitFor(() => expect(f.seen).toHaveLength(1));
            expect(f.seen[0]!.account).toEqual(a);
            expect(f.seen[0]!.resume).toBe(resume);
            noHome(f.seen[0]!.env);
        });
    }
    it('a provider with no active account is refused before constructing a driver', async () => {
        const dir = await directory(), f = hostFixture(dir, null);
        const r = f.host.start(agentRecord({ id: mintAgentId(), workspaceId: 'fixture', provider: 'claude', name: 'fixture' }), dir);
        expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/account/i) });
        expect(f.seen).toEqual([]);
    });
    it('an active account that belongs to another provider is refused before constructing a driver', async () => {
        const dir = await directory(), a = account('codex'), f = hostFixture(dir, a);
        const r = f.host.start(agentRecord({ id: mintAgentId(), workspaceId: 'fixture', provider: 'claude', name: 'fixture' }), dir);
        expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/account/i) });
        expect(f.seen).toEqual([]);
    });
});

describe('S3: login and its status carry no home (Tynn #753)', () => {
    // Claude's sign-in is the browser one now (Tynn #1011, no terminal): pinned in test/claude-browser-sign-in-1011.test.ts.
    it.each(['codex', DESIGN_LOGIN])('%s opens the terminal and runs the completion status in the normal provider home', async provider => {
        const scratch = await directory();
        const a = account(provider === 'codex' ? 'codex' : 'claude');
        let current = a, exit: ((id: string, code: number) => void) | undefined;
        const opened: Array<{ env?: Env | undefined }> = [], statuses: Array<{ command: string }> = [];
        const options: LoginHostOptions & { accountFor(provider: string): AccountRecord } = {
            scratch: () => scratch,
            accountFor: () => current,
            terminals: { open: o => { opened.push(o); return { id: 'login', pid: 1, shell: 'sh' }; },
                onExit: listener => { exit = listener; return () => {}; } } as LoginHostOptions['terminals'],
            openWindow: () => {}, onSignedIn: () => {},
            runStatus: async (command: string) => { statuses.push({ command }); return 0; },
        };
        const login = new LoginHost(options);
        expect(login.start(provider).ok).toBe(true);
        // Completing the terminal must not resolve a different home after it opened.
        current = account(a.provider, 'b');
        exit!('login', 0);
        if (provider !== DESIGN_LOGIN) await vi.waitFor(() => expect(statuses).toHaveLength(1));
        noHome(opened[0]?.env ?? {});
        if (provider === DESIGN_LOGIN) expect(statuses).toEqual([]);
        else expect(statuses).toHaveLength(1); // Design closure never claims authorization.
    });
});

describe('S3: provider-owned status and model probes', () => {
    it.each(['claude', 'codex'] as const)('%s health/status subprocesses carry no home variable', async provider => {
        const a = account(provider), calls: Array<{ args: readonly string[]; env?: Env }> = [];
        const elf = new Uint8Array(64); elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]); elf[18] = 0x3e;
        const ports: ProviderHealthPorts = {
            platform: 'linux', arch: 'x64', env: { PATH: '/bin', ...injected }, isFile: p => p === `/bin/${provider}`,
            readText: () => '', readHead: () => elf, realpath: p => p, chosen: () => null, now: () => 1,
            run: async (_binary, args, options) => {
                const env = (options as { env?: Env } | undefined)?.env;
                calls.push({ args, ...(env ? { env } : {}) });
                return { exitCode: 0, stdout: args.includes('--version') ? '1.0.0' : 'Logged in' };
            },
        };
        const check = checkProviderHealth as (provider: string, ports: ProviderHealthPorts, account?: AccountRecord) => ReturnType<typeof checkProviderHealth>;
        await check(provider, ports, a);
        expect(calls).toHaveLength(2); // Real planner called the inert runner for version and status.
        for (const call of calls) noHome(call.env ?? {});
    });
    it.each(['claude', 'codex'] as const)('%s model probes carry no home variable and no workspace env', provider => {
        const a = account(provider);
        const optionsFor = listModelsOptionsFor as (...args: [...Parameters<typeof listModelsOptionsFor>, AccountRecord?]) => ReturnType<typeof listModelsOptionsFor>;
        const options = optionsFor(provider, { [`GENIE2_${provider.toUpperCase()}_BINARY`]: '/fixture/provider.mjs' },
            { execPath: '/fixture/runtime', electron: false }, undefined, a);
        noHome(childEnv(options.parentEnv ?? {}, { allow: options.allowEnv ?? [] }).env);
    });
    it('CONTROL: the canonical provider health planner still runs version then documented status', async () => {
        const args: string[][] = [], elf = new Uint8Array(64);
        elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]); elf[18] = 0x3e;
        await checkProviderHealth('claude', { platform: 'linux', arch: 'x64', env: { PATH: '/bin' },
            isFile: p => p === '/bin/claude', readText: () => '', readHead: () => elf, realpath: p => p,
            chosen: () => null, now: () => 1, run: async (_b, a) => { args.push([...a]); return { exitCode: 0, stdout: '1.0.0' }; } });
        expect(args).toEqual([['--version'], ['auth', 'status']]);
    });
});

describe('S3: an unset legacy home stays unset at every provider entry point', () => {
    function inherited(provider: AcpProvider): AccountRecord {
        vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
        vi.stubEnv('CODEX_HOME', undefined);
        return { ...account(provider), id: `account_legacy_${provider}`, legacy: true, home: `/profile/.${provider}` };
    }
    it.each(['claude', 'codex'] as const)('%s legacy agent launch ignores workspace home overrides and keeps the host home unset', async provider => {
        const a = inherited(provider), dir = await directory(), f = hostFixture(dir, a);
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'fixture', provider, name: 'fixture' });
        expect(f.host.start(record, dir)).toEqual({ ok: true });
        await vi.waitFor(() => expect(f.seen).toHaveLength(1));
        noHome(f.seen[0]!.env);
        expect(f.seen[0]!.env.DB_PORT).toBe('4312');
    });
    it.each(['codex'] as const)('%s legacy login and completion status keep the home unset', async provider => {
        const a = inherited(provider), scratch = await directory();
        const opened: Array<{ env?: Env | undefined }> = [], statuses: Env[] = [];
        let exit: ((id: string, code: number) => void) | undefined;
        const login = new LoginHost({ accountFor: () => a, scratch: () => scratch,
            terminals: { open: o => { opened.push(o); return { id: 'login', pid: 1, shell: 'sh' }; },
                onExit: listener => { exit = listener; return () => {}; } } as LoginHostOptions['terminals'],
            openWindow: () => {}, onSignedIn: () => {},
            runStatus: async () => { statuses.push({}); return 0; } });
        expect(login.start(provider)).toMatchObject({ ok: true });
        exit!('login', 0);
        await vi.waitFor(() => expect(statuses).toHaveLength(1));
        noHome(opened[0]!.env ?? {}); noHome(statuses[0]!);
    });
    it.each(['claude', 'codex'] as const)('%s legacy health and status probes keep the home unset', async provider => {
        const a = inherited(provider), envs: Env[] = [], elf = new Uint8Array(64);
        elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]); elf[18] = 0x3e;
        await checkProviderHealth(provider, { platform: 'linux', arch: 'x64', env: { PATH: '/bin' },
            isFile: p => p === `/bin/${provider}`, readText: () => '', readHead: () => elf,
            realpath: p => p, chosen: () => null, now: () => 1,
            run: async (_binary, args, options) => { envs.push(options?.env ?? {});
                return { exitCode: 0, stdout: args.includes('--version') ? '1.0.0' : 'Logged in' }; } }, a);
        expect(envs).toHaveLength(2);
        for (const env of envs) noHome(env);
    });
    it.each(['claude', 'codex'] as const)('%s legacy model probe keeps the home unset through the real child allow-list', provider => {
        const a = inherited(provider);
        const opts = listModelsOptionsFor(provider, {}, { execPath: '/fixture/runtime', electron: false }, undefined, a);
        noHome(childEnv(opts.parentEnv ?? {}, { allow: [variable(provider), ...(opts.allowEnv ?? [])] }).env);
    });
});
