import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteMethod } from '../src/core/remote-protocol.js';
import { hostAloneApi, type HostAloneEngine, type HostAlonePorts } from '../src/main/host-alone-api.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import type { HostApi } from '../src/main/remote-host.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/*
 * ADDING, SLEEPING AND REMOVING A WORKSPACE WITH EVERY WINDOW CLOSED (Tynn #553, host split P5d.5e). genie-host runs the same
 * operations a window does, over one shared set of ports, so a Pilot can add a folder, put a workspace to sleep, change
 * its repositories, its default agent and its colour, and adopt the agents it came with, while nothing is open here.
 */

let dir = '';
let workspace = '';
let extra = '';
let registry: Registry;
const calls: string[] = [];

const engine = { probe: () => null, prompt: () => true, stop: () => true, subscribe: () => () => {}, ledgerFor: () => [], rowsFor: () => [], turnsFor: () => 0, recentStderrFor: () => [], refusals: new Map(), needsNewDriver: () => false, notice: () => true } as unknown as HostAloneEngine;

function ports(over: Record<string, unknown> = {}, life: Record<string, unknown> = {}): HostAlonePorts {
    return {
        hostName: 'alphar', registry, engine: () => engine, cwdFor: () => workspace, startRefusal: () => null,
        models: { get: async () => ({ models: [] }) }, providerInstalled: () => true, windowConnected: () => false,
        terminals: { attach: () => null, write: () => true, resize: () => true, close: () => true, list: () => [], onData: () => () => {}, onExit: () => () => {} },
        takeOver: () => null,
        settings: { snapshotFor: () => ({}), workspaceValues: () => ({}), setFor: async () => {}, resetFor: async () => {} },
        headroom: { view: () => ({}), subscribe: () => () => {} },
        attention: { finished: () => [], markSeen: () => {}, answer: async () => true, lists: { done: async () => true } },
        approvals: { resolve: () => true }, inbox: { unread: () => [], receive: async () => [], involving: () => [] }, deliverToAgent: async () => true,
        files: { children: async () => null, open: async () => ({ ok: false }), readBytes: async () => ({ ok: false }), upload: async () => ({ ok: false }) },
        workspaceLifecycle: {
            terminals: () => ({ list: () => [{ id: 'term_1', workspaceId: 'tynn' }], close: (id: string) => { calls.push(`terminal closed ${id}`); return true; } }),
            supervisor: () => ({ list: () => [], stop: () => true }),
            engines: () => ({ toRelease: () => ['redis'], toResume: () => ['redis'], stop: async (id: string) => { calls.push(`engine stopped ${id}`); }, start: async (id: string) => { calls.push(`engine started ${id}`); } }),
            reverifyTrust: async (id: string) => { calls.push(`trust checked ${id}`); },
            github: () => null,
            tynn: () => ({ projects: async () => [{ id: 'proj_1', sacred_agent_name: 'atlas' }], host: () => 'https://tynn.test' }),
            defaultEnvFile: () => '.env.local',
            stagingDirectory: () => join(dir, 'staging'),
            ...life,
        },
        colors: { set: async (path: string, color: string) => { calls.push(`colour ${path === workspace ? 'tynn' : path} ${color}`); return { ok: true }; } },
        ...over,
    } as unknown as HostAlonePorts;
}

function gate(alone: HostApi, window: Partial<{ connected: () => boolean; invoke: HostApi['invoke'] }> = {}): HostApi {
    return hostRemoteApi({ hostName: 'alphar', own: {}, window: { connected: () => false, invoke: async () => { throw new Error('the window was asked'); }, ...window }, alone });
}
const reopened = async () => { const r = new Registry(new Store(dir)); await r.load({ name: 'alphar', healthy: true }); return r; };

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-host-alone-life-'));
    workspace = join(dir, 'tynn');
    extra = join(dir, 'extra');
    calls.length = 0;
    await mkdir(join(workspace, '.agents', 'kai'), { recursive: true });
    await mkdir(join(workspace, 'repos', 'one'), { recursive: true });
    await mkdir(extra, { recursive: true });
    await writeFile(join(workspace, '.agents', 'kai', 'AGENT.md'), '---\nname: kai\nprovider: claude\n---\nA persona.\n');
    await writeFile(join(workspace, 'project.json'), JSON.stringify({ name: 'tynn', type: 'agi', tynn: { projectId: 'proj_1' }, repos: [{ name: 'tynn.ai', slug: 'tynn-ai', path: '.' }] }));
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await registry.addWorkspace({ id: 'tynn', path: workspace });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** Every call this family moves, with arguments that do no network and no clone: reaching its own answer is what is measured. */
const CALLS: Array<[RemoteMethod, () => unknown[]]> = [
    ['workspaces.previewAdd', () => [extra]],
    ['workspaces.confirmAdd', () => [extra]],
    ['workspaces.create', () => ['New', dir, { kind: 'not-a-remote' }]],
    ['workspaces.previewAddFromGit', () => ['', '']],
    ['workspaces.confirmAddFromGit', () => [1, 2]],
    ['workspaces.readSource', () => [join(dir, 'nothing-here')]],
    ['workspaces.stageFromGit', () => ['  ']],
    ['workspaces.registerExisting', () => [join(dir, 'nothing-here')]],
    ['workspaces.buildEnvelope', () => [{ not: 'a plan' }, undefined]],
    ['workspaces.discardStaged', () => [1]],
    ['workspaces.githubRepos', () => []],
    ['workspaces.tynnProjects', () => []],
    ['workspaces.tynnOwnerOptions', () => []],
    ['workspaces.createTynnProject', () => [{}]],
    ['workspaces.importedAgents', () => ['tynn']],
    ['workspaces.adoptAgent', () => ['tynn', 'nobody']],
    ['workspaces.previewAddFromTynn', () => ['', '']],
    ['workspaces.confirmAddFromTynn', () => [1, 2]],
    ['workspaces.hibernate', () => ['nowhere']],
    ['workspaces.wake', () => ['nowhere']],
    ['workspaces.remove', () => ['nowhere']],
    ['workspaces.addRepo', () => ['nowhere', { name: 'x', path: 'x' }]],
    ['workspaces.removeRepo', () => ['nowhere', 'x']],
    ['workspaces.removeRepoLock', () => ['nowhere', 'x']],
    ['workspaces.locateRepo', () => ['nowhere', 'x', join(dir, 'x')]],
    ['workspaces.setGoverns', () => ['tynn', []]],
    ['workspaces.setDefaultAgent', () => ['tynn', null]],
    ['workspaces.setColor', () => ['tynn', '#112233']],
];

describe('each is answered with no window', () => {
    it.each(CALLS)('%s reaches genie-host, not the "open a window" refusal', async (method, args) => {
        const api = gate(hostAloneApi(ports()));
        await expect(api.invoke(method, args())).resolves.toBeDefined();
    });
});

describe('adding a workspace', () => {
    it('a folder is previewed, then added, and survives reopening', async () => {
        const api = gate(hostAloneApi(ports()));
        expect(await api.invoke('workspaces.previewAdd', [extra])).toMatchObject({ ok: true });
        expect(registry.workspace('extra')).toBeNull();
        expect(await api.invoke('workspaces.confirmAdd', [extra])).toMatchObject({ ok: true });
        expect((await reopened()).workspace('extra')).toMatchObject({ path: extra });
    });

    it('a new workspace is made on disk and registered', async () => {
        const api = gate(hostAloneApi(ports()));
        const made = (await api.invoke('workspaces.create', ['fresh', dir])) as { ok: true; path: string };
        expect(made).toMatchObject({ ok: true });
        await expect(stat(join(made.path, 'project.json'))).resolves.toBeDefined();
        expect((await reopened()).listWorkspaces().some((w) => w.path === made.path)).toBe(true);
    });

    it('a remote it cannot understand is refused, and nothing is made (CONTROL)', async () => {
        const api = gate(hostAloneApi(ports()));
        expect(await api.invoke('workspaces.create', ['fresh', dir, { kind: 'not-a-remote' }])).toEqual({ ok: false, reason: 'that is not a remote Genie understands; choose None, GitHub or Paste URL' });
        await expect(stat(join(dir, 'fresh'))).rejects.toThrow();
    });

    it('signed out of GitHub says so; the Tynn projects come from genie-host\'s own account', async () => {
        const api = gate(hostAloneApi(ports({}, { tynn: () => ({ projects: async () => [{ id: 'p1', name: 'Tynn', slug: 'tynn' }], host: () => 'https://tynn.test', status: () => ({ signedIn: true }) }) })));
        expect(await api.invoke('workspaces.githubRepos', [])).toEqual({ status: 'signed-out' });
        expect(JSON.stringify(await api.invoke('workspaces.tynnProjects', []))).toContain('p1');
    });

    it('the agents a workspace came with are listed, and one is adopted', async () => {
        const api = gate(hostAloneApi(ports()));
        expect(await api.invoke('workspaces.importedAgents', ['tynn'])).toMatchObject({ ok: true, agents: [{ name: 'kai' }] });
        expect(await api.invoke('workspaces.adoptAgent', ['tynn', 'kai'])).toMatchObject({ ok: true, name: 'kai' });
        expect((await reopened()).agentsOf('tynn').map((a) => a.name)).toEqual(['kai']);
    });
});

describe('sleep, wake, remove', () => {
    it('hibernate closes its terminals, releases its engines, and sleeps; wake checks its trust and resumes them', async () => {
        const api = gate(hostAloneApi(ports()));
        expect(await api.invoke('workspaces.hibernate', ['tynn'])).toMatchObject({ ok: true });
        expect(registry.workspace('tynn')?.asleep).toBe(true);
        expect(calls).toEqual(expect.arrayContaining(['terminal closed term_1', 'engine stopped redis']));
        calls.length = 0;
        expect(await api.invoke('workspaces.wake', ['tynn'])).toMatchObject({ ok: true });
        expect(registry.workspace('tynn')?.asleep).toBe(false);
        expect(calls).toEqual(expect.arrayContaining(['trust checked tynn', 'engine started redis']));
    });

    it('a wake whose trust check fails stays asleep (CONTROL)', async () => {
        const api = gate(hostAloneApi(ports({}, { reverifyTrust: async () => { throw new Error('workspace trust is not available yet'); } })));
        await api.invoke('workspaces.hibernate', ['tynn']);
        await api.invoke('workspaces.wake', ['tynn']).catch(() => null);
        expect(registry.workspace('tynn')?.asleep).toBe(true);
    });

    it('remove forgets it, and the files stay', async () => {
        const api = gate(hostAloneApi(ports()));
        expect(await api.invoke('workspaces.remove', ['tynn'])).toMatchObject({ ok: true });
        expect((await reopened()).workspace('tynn')).toBeNull();
        await expect(stat(join(workspace, 'project.json'))).resolves.toBeDefined();
    });
});

describe('repositories, governs, default agent, colour', () => {
    it('a repository is added to and removed from project.json', async () => {
        const api = gate(hostAloneApi(ports()));
        expect(await api.invoke('workspaces.addRepo', ['tynn', { name: 'one', path: 'repos/one' }])).toMatchObject({ ok: true, slug: 'one' });
        expect(JSON.parse(await readFile(join(workspace, 'project.json'), 'utf8')).repos).toHaveLength(2);
        expect(await api.invoke('workspaces.removeRepo', ['tynn', 'one'])).toMatchObject({ ok: true });
        expect(JSON.parse(await readFile(join(workspace, 'project.json'), 'utf8')).repos).toHaveLength(1);
    });

    it('a default agent is kept; one from another workspace is refused (CONTROL)', async () => {
        const atlas = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        await registry.addWorkspace({ id: 'extra', path: extra });
        const vega = await registry.register({ workspaceId: 'extra', provider: 'claude', name: 'vega' });
        const api = gate(hostAloneApi(ports()));
        expect(await api.invoke('workspaces.setDefaultAgent', ['tynn', atlas.id])).toMatchObject({ ok: true });
        expect((await reopened()).workspace('tynn')?.defaultAgentId).toBe(atlas.id);
        expect(await api.invoke('workspaces.setDefaultAgent', ['tynn', vega.id])).toMatchObject({ ok: false });
        expect((await reopened()).workspace('tynn')?.defaultAgentId).toBe(atlas.id);
    });

    it('a colour goes to the workspace\'s own folder; an unknown workspace is refused (CONTROL)', async () => {
        const api = gate(hostAloneApi(ports()));
        expect(await api.invoke('workspaces.setColor', ['tynn', '#112233'])).toEqual({ ok: true });
        expect(calls).toEqual(['colour tynn #112233']);
        expect(await api.invoke('workspaces.setColor', ['nowhere', '#112233'])).toEqual({ ok: false, reason: 'name a workspace' });
    });

    it('governs are kept', async () => {
        await registry.addWorkspace({ id: 'extra', path: extra });
        const api = gate(hostAloneApi(ports()));
        await api.invoke('workspaces.setGoverns', ['tynn', ['extra']]);
        expect((await reopened()).workspace('tynn')).toMatchObject({ governs: ['extra'] });
    });
});

describe('the gate', () => {
    it('with a window connected the window answers, and genie-host is not asked (CONTROL)', async () => {
        const alone = hostAloneApi(ports());
        const invoke = vi.spyOn(alone, 'invoke');
        const api = gate(alone, { connected: () => true, invoke: async (method) => `window answered ${method}` });
        expect(await api.invoke('workspaces.hibernate', ['tynn'])).toBe('window answered workspaces.hibernate');
        expect(invoke).not.toHaveBeenCalled();
        expect(registry.workspace('tynn')?.asleep).not.toBe(true);
    });

    it('the Tynn tab is not part of this: still "open a window" (CONTROL)', async () => {
        const api = gate(hostAloneApi(ports()));
        await expect(api.invoke('workspaces.tynnBoard', ['tynn', {}])).rejects.toThrow('open Genie on alphar');
    });
});

describe('the wiring', () => {
    const src = (path: string) => readFileSync(path, 'utf8');

    it('the window and genie-host answer through the same code', () => {
        for (const file of ['src/main/main.ts', 'src/main/host-alone-api.ts']) {
            expect(src(file), file).toContain('workspaceLifecyclePorts(');
            expect(src(file), file).toContain('workspaceLifecycleApi(');
        }
    });

    it('genie-host gives it what it owns: its supervisor, engines, trust, accounts and colours', () => {
        const host = src('src/main/genie-host.ts');
        expect(host).toMatch(/workspaceLifecycle: \{/);
        expect(host).toMatch(/supervisor: \(\) => processSupervisor/);
        expect(host).toMatch(/engines: \(\) => hostingStack\?\.hibernationEngines \?\? null/);
        expect(host).toMatch(/github: \(\) => githubNow/);
        expect(host).toMatch(/new WorkspaceColors\(/);
    });
});
