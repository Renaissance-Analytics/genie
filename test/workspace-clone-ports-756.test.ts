import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProcessSource } from '../src/core/workspace-processes.js';
import { cloneRestorePorts, type CloneRestoreDeps } from '../src/main/workspace-clone-ports.js';

/**
 * THE CLONE RESTORE'S PORTS, FROM WHAT A HOST HOLDS (Tynn #756, PR9a): the registry, the settings, the flow store, the process book,
 * the trust verdict and the sites. Each port is a thin mapping, tested here against fakes; and both hosts hand their stores to
 * Save to repo and genie-host (which owns the stores) restores a workspace that appears. Fixtures are invented names.
 */

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function deps(over: Partial<CloneRestoreDeps> = {}) {
    const calls: string[] = [];
    const flowsMade: unknown[] = [];
    const keptMade: unknown[] = [];
    const d: CloneRestoreDeps = {
        files: { read: async () => null, list: async () => [] },
        registry: {
            agentsOf: () => [{ id: 'agent_1', name: 'lift' }],
            chosenDefaultAgentOf: () => 'agent_1',
            setDefaultAgent: async (ws, id) => { calls.push(`default ${ws} ${id}`); },
            listWorkspaces: () => [{ id: 'ws', envFile: '.env.mine' }],
            setWorkspaceEnvFile: async (ws, file) => { calls.push(`envFile ${ws} ${file}`); },
            workspaceMcpOff: () => ['slack'],
            setWorkspaceMcpServer: async (ws, name, on) => { calls.push(`mcp ${ws} ${name} ${on}`); },
            listAgents: () => [{ id: 'agent_1', name: 'lift', workspaceId: 'ws', provider: 'claude' } as never],
            workspaceSlugs: () => new Map([['ws', 'acme']]),
        },
        settings: {
            workspaceValues: () => ({ agent_cap: '4', workspace_tabs: '{"tabs":[]}', panel_layout: 'rows' }),
            setFor: async (ws, key, value) => { calls.push(`set ${ws} ${key}=${value}`); },
            get: (key) => (key === 'default_env_file' ? '.env.local' : ''),
        },
        flows: async () => ({
            list: () => [{ id: 'flow_1', workspaceId: 'ws', name: 'nightly', document: { v: 1 }, armed: true, runs: [{ at: 'x' }] }, { id: 'flow_2', workspaceId: 'other', name: 'theirs', document: {}, armed: false, runs: [] }] as never,
            create: async (input) => { flowsMade.push(input); return input; },
        }),
        processes: async () => ({
            kept: () => [{ id: 'proc_1', workspaceId: 'ws', name: 'worker', command: 'php artisan queue:work', cwd: '/c/acme/repos/app', restart: 'always', wanted: true, changedAt: 1 }, { id: 'proc_2', workspaceId: 'other', name: 'theirs', command: 'x', cwd: '/y', restart: 'never', wanted: false, changedAt: 2 }] as never,
            keep: async (input) => { keptMade.push(input); return input; },
        }),
        trusted: (id) => id === 'ws',
        siteHosts: () => ['shop.gen'],
        ...over,
    };
    return { d, calls, flowsMade, keptMade };
}

describe('the settings ports', () => {
    it('read and write the registry and the settings the way the restore asks', async () => {
        const { d, calls } = deps();
        const p = await cloneRestorePorts(d);
        expect(p.settings.agentsOf('ws')).toEqual([{ id: 'agent_1', name: 'lift' }]);
        expect(p.settings.overridden('ws')).toEqual({ agent_cap: '4', workspace_tabs: '{"tabs":[]}', panel_layout: 'rows' });
        await p.settings.setSetting('ws', 'agent_cap', '8');
        await p.settings.setDefaultAgent('ws', 'agent_1');
        await p.settings.setEnvFile('ws', '.env.local');
        await p.settings.setMcpServer('ws', 'notion', false);
        expect(calls).toEqual(['set ws agent_cap=8', 'default ws agent_1', 'envFile ws .env.local', 'mcp ws notion false']);
        expect(p.settings.chosenDefaultAgentOf('ws')).toBe('agent_1');
        expect(p.settings.envFileOf('ws')).toBe('.env.mine');
        expect(p.settings.envFileOf('nowhere')).toBeNull();
        expect(p.settings.mcpOff('ws')).toEqual(['slack']);
    });

    it('the default env file is the host’s setting, and .env when it has none', async () => {
        expect((await cloneRestorePorts(deps().d)).settings.defaultEnvFile()).toBe('.env.local');
        const bare = deps({ settings: { workspaceValues: () => ({}), setFor: async () => {}, get: () => '' } });
        expect((await cloneRestorePorts(bare.d)).settings.defaultEnvFile()).toBe('.env');
    });
});

describe('the tabs ports', () => {
    it('read the three settings as they are kept, and write them back through the settings', async () => {
        const { d, calls } = deps();
        const p = await cloneRestorePorts(d);
        expect(p.tabs.values('ws')).toEqual({ tabs: '{"tabs":[]}', panelSplits: '', panelLayout: 'rows' });
        await p.tabs.write('ws', 'workspace_tabs', '{"tabs":[1]}');
        expect(calls).toEqual(['set ws workspace_tabs={"tabs":[1]}']);
        expect(p.tabs.siteHosts('ws')).toEqual(['shop.gen']);
    });
});

describe('the flow and process ports', () => {
    it('the flows are this workspace’s, as name and document only, and a flow is created by the person, never armed', async () => {
        const { d, flowsMade } = deps();
        const flows = (await cloneRestorePorts(d)).flows;
        const ports = (await flows())!;
        expect(ports.list('ws')).toEqual([{ name: 'nightly', document: { v: 1 } }]);
        await ports.create({ workspaceId: 'ws', name: 'x', document: { v: 1 }, by: { kind: 'user' } });
        expect(flowsMade).toEqual([{ workspaceId: 'ws', name: 'x', document: { v: 1 }, by: { kind: 'user' } }]);
    });

    it('the processes are this workspace’s, as what a save reads: no id, intent or history; one is kept through the book', async () => {
        const { d, keptMade } = deps();
        const ports = (await (await cloneRestorePorts(d)).processes())!;
        expect(ports.list('ws')).toEqual<ProcessSource[]>([{ name: 'worker', workspaceId: 'ws', command: 'php artisan queue:work', cwd: '/c/acme/repos/app', restart: 'always' }]);
        await ports.keep({ workspaceId: 'ws', workspacePath: '/c/acme', name: 'worker', command: 'x', restart: 'never' });
        expect(keptMade).toEqual([{ workspaceId: 'ws', workspacePath: '/c/acme', name: 'worker', command: 'x', restart: 'never' }]);
    });

    it('an agent nudge’s agent is found by name in the workspace, as its inbox address', async () => {
        const ports = (await (await cloneRestorePorts(deps().d)).processes())!;
        expect(ports.agentAddressOf('ws', 'lift')).toBe('lift@acme');
        expect(ports.agentAddressOf('ws', 'ghost')).toBeNull();
        expect(ports.agentAddressOf('other', 'lift')).toBeNull();
    });

    it('a store that is not open yet is null, not an error', async () => {
        const p = await cloneRestorePorts(deps({ flows: async () => null, processes: async () => null }).d);
        expect(await p.flows()).toBeNull();
        expect(await p.processes()).toBeNull();
    });

    it('the trust verdict is the host’s', async () => {
        const p = await cloneRestorePorts(deps().d);
        expect(p.trusted('ws')).toBe(true);
        expect(p.trusted('nowhere')).toBe(false);
    });
});

describe('in the hosts', () => {
    it('genie-host, which owns the stores, restores a workspace that appears, with these ports', () => {
        const host = src('src/main/genie-host.ts');
        for (const word of ['watchNewWorkspaces(', 'restoreClone(', 'cloneRestorePorts(']) expect(host, word).toContain(word);
    });

    it('genie-host hands the flow store and the process book to Save to repo (main builds no save of its own, Tynn #953)', () => {
        expect(src('src/main/main.ts')).not.toContain('elementSourcesFor(');
        for (const file of ['src/main/genie-host.ts']) {
            const text = src(file);
            const at = text.indexOf('elementSourcesFor(');
            const call = text.slice(at, at + 900);
            expect(call, `${file}: flows`).toMatch(/flows:/);
            expect(call, `${file}: processes`).toMatch(/processes:/);
        }
    });
});
