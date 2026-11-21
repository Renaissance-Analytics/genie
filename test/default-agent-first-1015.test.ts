import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { adoptAgent } from '../src/main/agent-adoption-host.js';
import { HostRegistry } from '../src/main/host-registry.js';
import { cloneRestorePorts } from '../src/main/workspace-clone-ports.js';
import { restoreWorkspaceSettings } from '../src/main/workspace-restore-host.js';
import { elementSourcesFor } from '../src/main/workspace-save-sources.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * THE FIRST OR ONLY AGENT IS THE DEFAULT (the owner, verbatim, 2026-11-21: "the first or only agent in a workspace is
 * automatically the default agent"; Tynn #1015). Measured read-only on the owner's machine: six awake workspaces had one
 * agent and NO default recorded (operation-impact-beachhead among them), because registering an agent never designated
 * one, so everything that asks for "the default agent" (createAgent, workspaceTabs, pages, IssueWatch) found none.
 *
 * An AUTOMATIC default is told apart from a CHOSEN one: a default someone chose (the person, project.json's declaration
 * on adopt, a restore, Genie 1's import) replaces an automatic one, and nothing automatic replaces a chosen one.
 */

let dir: string;
let registry: Registry;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-default-first-'));
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('registering', () => {
    it('the FIRST agent registered in a workspace becomes its default, recorded, across a restart', async () => {
        const atlas = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        expect(registry.defaultAgentOf('tynn')).toBe(atlas.id);
        const reopened = new Registry(new Store(dir));
        await reopened.load({ name: 'alphar', healthy: true });
        expect(reopened.defaultAgentOf('tynn')).toBe(atlas.id);
    });

    it('a second agent does not take it; CONTROL: the first stays the default', async () => {
        const atlas = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        await registry.register({ workspaceId: 'tynn', provider: 'codex', name: 'wren' });
        expect(registry.defaultAgentOf('tynn')).toBe(atlas.id);
    });

    it('an automatic default is not a CHOSEN one; the person’s choice is, and survives the next agent', async () => {
        const atlas = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        expect(registry.chosenDefaultAgentOf('tynn')).toBeNull();
        const wren = await registry.register({ workspaceId: 'tynn', provider: 'codex', name: 'wren' });
        await registry.setDefaultAgent('tynn', wren.id);
        expect(registry.chosenDefaultAgentOf('tynn')).toBe(wren.id);
        await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'kai' });
        expect(registry.defaultAgentOf('tynn')).toBe(wren.id);
        expect(atlas.id).not.toBe(wren.id);
    });

    it('forgetting the default: the first agent left becomes the default (automatically); the last one gone: none', async () => {
        const atlas = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        const wren = await registry.register({ workspaceId: 'tynn', provider: 'codex', name: 'wren' });
        await registry.forget(atlas.id);
        expect(registry.defaultAgentOf('tynn')).toBe(wren.id);
        expect(registry.chosenDefaultAgentOf('tynn')).toBeNull();
        await registry.forget(wren.id);
        expect(registry.defaultAgentOf('tynn')).toBeNull();
    });
});

describe('an existing workspace with agents and no default (the owner’s six)', () => {
    async function onDisk(agents: string[], defaultOf?: number) {
        const store = new Store(dir);
        const records = agents.map((name) => agentRecord({ id: mintAgentId(), workspaceId: 'beach', provider: 'claude', name }));
        await store.writeWorkspaces([...(await store.readWorkspaces()), { id: 'beach', path: '/w/beach', ...(defaultOf === undefined ? {} : { defaultAgentId: records[defaultOf]!.id }) }]);
        await store.writeAgents([...(await store.readAgents()), ...records]);
        return { store, records };
    }

    it('assignMissingDefaults records the first (or only) agent as the default, once: a second pass writes nothing', async () => {
        const { records } = await onDisk(['beachhead', 'scout']);
        const r = new Registry(new Store(dir));
        await r.load({ name: 'alphar', healthy: true });
        expect(await r.assignMissingDefaults()).toEqual(['beach']);
        expect(r.defaultAgentOf('beach')).toBe(records[0]!.id);
        const file = await readFile(join(dir, 'workspaces.json'), 'utf8');
        expect(await r.assignMissingDefaults()).toEqual([]);
        expect(await readFile(join(dir, 'workspaces.json'), 'utf8')).toBe(file);
        // CONTROL: recorded on disk, not only in memory.
        const reopened = new Registry(new Store(dir));
        await reopened.load({ name: 'alphar', healthy: true });
        expect(reopened.defaultAgentOf('beach')).toBe(records[0]!.id);
    });

    it('a recorded default is never replaced; a workspace with no agents gets none', async () => {
        const { records } = await onDisk(['beachhead', 'scout'], 1);
        const r = new Registry(new Store(dir));
        await r.load({ name: 'alphar', healthy: true });
        expect(await r.assignMissingDefaults()).toEqual([]);
        expect(r.defaultAgentOf('beach')).toBe(records[1]!.id);
        expect(r.defaultAgentOf('tynn')).toBeNull();
    });

    it('genie-host’s read-only view: the only (or first) agent is the default even before anything is recorded', async () => {
        const { records } = await onDisk(['beachhead', 'scout']);
        const view = new HostRegistry(new Store(dir));
        await view.refresh();
        expect(view.defaultAgentOf('beach')).toBe(records[0]!.id);
        expect(view.chosenDefaultAgentOf('beach')).toBeNull();
        // CONTROL: a workspace with no agents has none.
        expect(view.defaultAgentOf('tynn')).toBeNull();
    });

    it('CONTROL for the view: a recorded default wins over the first agent', async () => {
        const { records } = await onDisk(['beachhead', 'scout'], 1);
        const view = new HostRegistry(new Store(dir));
        await view.refresh();
        expect(view.defaultAgentOf('beach')).toBe(records[1]!.id);
    });
});

describe('a default someone CHOSE replaces an automatic one (adopt, restore)', () => {
    const V5 = 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.5.0/schemas/workspace/project.schema.json';
    const ROOT = '/w/tynn';
    const manifest = `${JSON.stringify({ $schema: V5, name: 'tynn', agents: { lift: { purpose: 'Builds.' }, scout: { purpose: 'Scouts.' } }, workspace: { defaultAgent: 'lift' } }, null, 2)}\n`;
    const files: Record<string, string> = { [`${ROOT}/project.json`]: manifest, [`${ROOT}/.agents/lift/AGENT.md`]: 'Builds.\n', [`${ROOT}/.agents/scout/AGENT.md`]: 'Scouts.\n' };
    const posix = (p: string) => p.split(String.fromCharCode(92)).join('/');

    it('adopt: scout first (the automatic default), then lift, which project.json names: lift is the default', async () => {
        // As workspace-lifecycle-api.ts wires them, over the registry.
        const ports = {
            workspace: (id: string) => registry.workspace(id),
            agentsOf: (id: string) => registry.agentsOf(id),
            listDirs: async () => ['lift', 'scout'],
            readText: async (p: string) => files[posix(p)] ?? null,
            writeTextAtomic: async () => {},
            register: async (input: { workspaceId: string; provider: 'claude' | 'codex'; name: string; instructions: string }) => { const r = await registry.register(input); return { id: r.id, name: r.name }; },
            chosenDefaultAgentOf: (id: string) => registry.chosenDefaultAgentOf(id),
            setDefaultAgent: async (id: string, agentId: string) => { await registry.setDefaultAgent(id, agentId); },
        };
        const scout = (await adoptAgent(ports as never, 'tynn', 'scout')) as { id: string };
        expect(registry.defaultAgentOf('tynn')).toBe(scout.id);
        const lift = (await adoptAgent(ports as never, 'tynn', 'lift')) as { id: string };
        expect(registry.defaultAgentOf('tynn')).toBe(lift.id);
        expect(registry.chosenDefaultAgentOf('tynn')).toBe(lift.id);
    });

    it('restore: project.json’s default replaces the automatic one; CONTROL: never the person’s choice', async () => {
        const scout = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'scout' });
        const lift = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'lift' });
        const ports = cloneRestorePorts({ registry, settings: { workspaceValues: () => ({}), setFor: async () => {}, get: () => '' } } as never).settings;
        expect(await restoreWorkspaceSettings(JSON.parse(manifest), 'tynn', ports)).toMatchObject({ applied: ['defaultAgent'] });
        expect(registry.defaultAgentOf('tynn')).toBe(lift.id);

        await registry.setDefaultAgent('tynn', scout.id);
        expect(await restoreWorkspaceSettings(JSON.parse(manifest), 'tynn', ports)).toMatchObject({ kept: ['defaultAgent'] });
        expect(registry.defaultAgentOf('tynn')).toBe(scout.id);
    });
});

describe('Save to repo writes only a CHOSEN default', () => {
    const save = (id: string) => elementSourcesFor({ services: { list: () => [] }, settings: { workspaceValues: () => ({}) }, registry }, id).workspace.defaultAgent;
    it('the automatic first agent is not written into project.json; the person’s choice is', async () => {
        await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        const wren = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'wren' });
        expect(save('tynn')).toBeNull();
        await registry.setDefaultAgent('tynn', wren.id);
        expect(save('tynn')).toBe('wren');
    });
});

describe('wiring: every “only where none is set” path asks for a CHOSEN default', () => {
    const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    it('adopt (workspace-lifecycle-api), restore (genie-host, clone ports) and Genie 1’s import (main.ts)', () => {
        expect(src('src/main/workspace-lifecycle-api.ts')).toMatch(/chosenDefaultAgentOf: \(workspaceId\) => w\.registry\(\)\?\.chosenDefaultAgentOf\(workspaceId\)/);
        expect(src('src/main/genie-host.ts')).toMatch(/chosenDefaultAgentOf: \(id\) => hostRegistry\.chosenDefaultAgentOf\(id\)/);
        expect(src('src/main/workspace-clone-ports.ts')).toMatch(/chosenDefaultAgentOf: \(id\) => d\.registry\.chosenDefaultAgentOf\(id\)/);
        expect(src('src/main/main.ts')).toMatch(/theRegistry\.chosenDefaultAgentOf\(workspaceId\) !== null\) continue/);
        // genie-host, the one writer, records the missing defaults at boot.
        expect(src('src/main/genie-host.ts')).toMatch(/await phoneRegistry\.load\([^\n]*\);\r?\n\s*await phoneRegistry\.assignMissingDefaults\(\)/);
    });
});
