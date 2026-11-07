import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { reachable } from '../src/core/inbox.js';
import { OS_AGENT_NAME, OS_WORKSPACE } from '../src/core/os-agent.js';
import { SETTINGS } from '../src/core/settings.js';
import { sectionOf } from '../src/core/settings-nav.js';
import { runtimeDir } from '../src/main/paths.js';
import { SettingsStore } from '../src/main/settings-store.js';
import { Store, writeJsonAtomic } from '../src/main/store.js';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'genie-inbox-access-upgrade-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const agent = (workspaceId: string, accessScope: AgentRecord['accessScope']) =>
    agentRecord({ id: mintAgentId(), workspaceId, provider: 'claude', name: `agent-${workspaceId}`, accessScope });
const marker = () => join(runtimeDir(home), 'agent-inbox-access-migrated.json');
const settingsFile = () => join(runtimeDir(home), 'settings.json');
const closedWorkspace = () => ({ scope: 'none' as const });

async function legacy(agents: readonly AgentRecord[], settings: Record<string, unknown>): Promise<Store> {
    const store = new Store(home);
    await store.writeAgents(agents);
    await writeJsonAtomic(settingsFile(), settings);
    return store;
}

describe('the one-time upgrade from workspace and agent access to agent access alone', () => {
    it('keeps an all agent in a formerly closed workspace unreachable, then lets the person reopen only that agent', async () => {
        const original = agent('target', 'all');
        const sender = agent('elsewhere', 'all');
        const store = await legacy([original], { __workspaces: { target: { inbox_access: 'none' } } });
        const [upgraded] = await store.readAgents();
        expect(upgraded!.accessScope).toBe('none');
        expect(reachable(sender, upgraded!, closedWorkspace)).toBe(false);
        expect(JSON.parse(await readFile(store.agentsFile, 'utf8'))[0].accessScope).toBe('none');
        expect(JSON.parse(await readFile(marker(), 'utf8'))).toMatchObject({ version: 1 });

        await store.writeAgents([{ ...upgraded!, accessScope: 'all' }]);
        // A restart must not reapply the old workspace setting over the person's choice.
        await SettingsStore.open(home);
        const [reopened] = await new Store(home).readAgents();
        expect(reopened!.accessScope).toBe('all');
        expect(reachable(sender, reopened!, closedWorkspace)).toBe(true);
    });

    it.each([
        ['none', 'none', 'none'], ['none', 'self', 'none'], ['none', 'specific', 'none'], ['none', 'all', 'none'],
        ['self', 'none', 'none'], ['self', 'self', 'self'], ['self', 'specific', 'self'], ['self', 'all', 'self'],
        ['all', 'none', 'none'], ['all', 'self', 'self'], ['all', 'specific', 'specific'], ['all', 'all', 'all'],
    ] as const)('intersects legacy workspace %s with agent %s to get %s', async (workspace, own, expected) => {
        const original = agent('target', own);
        const store = await legacy([original], { inbox_access: workspace });
        const [upgraded] = await store.readAgents();
        expect(upgraded).toEqual({ ...original, accessScope: expected });
    });

    it.each([
        [{}, 'self'],
        [{ inbox_access: 'all', __workspaces: { target: { inbox_access: 'none' } } }, 'none'],
        [{ inbox_access: 'none', __workspaces: { target: { inbox_access: 'all' } } }, 'all'],
        [{ inbox_access: 'none', __workspaces: { unrelated: { inbox_access: 'all' } } }, 'none'],
        [{ inbox_access: 'all', __workspaces: { target: { inbox_access: 'unknown' } } }, 'self'],
        [{ inbox_access: 'unknown' }, 'self'],
    ] as const)('preserves legacy override, workstation and closed-default precedence (%j)', async (values, expected) => {
        const store = await legacy([agent('target', 'all')], values);
        expect((await store.readAgents())[0]!.accessScope).toBe(expected);
    });

    it('runs before settings can drop the retired value, including when settings open first and flush', async () => {
        const store = await legacy([agent('target', 'all')], { inbox_access: 'none' });
        const settings = await SettingsStore.open(home);
        await settings.set('theme', 'dark');
        expect((await store.readAgents())[0]!.accessScope).toBe('none');
        expect(settings.snapshot()).not.toHaveProperty('inbox_access');
        expect(settings.snapshotFor('target')).not.toHaveProperty('inbox_access');
    });

    it('records completion even on a fresh empty install and never reads retired values afterward', async () => {
        const store = new Store(home);
        expect(await store.readAgents()).toEqual([]);
        expect(await access(marker()).then(() => true, () => false)).toBe(true);
        const done = await readFile(marker(), 'utf8');
        const createdLater = agent('target', 'all');
        await store.writeAgents([createdLater]);
        // Even an unreadable old settings file is irrelevant to an already-completed migration.
        await writeFile(settingsFile(), '{broken JSON');
        expect(await new Store(home).readAgents()).toEqual([createdLater]);
        expect(await readFile(marker(), 'utf8')).toBe(done);
    });

    it('keeps the OS agent all while restricting ordinary agents, including hibernated workspaces', async () => {
        const os = agentRecord({ id: mintAgentId(), workspaceId: OS_WORKSPACE, provider: 'claude', name: OS_AGENT_NAME, accessScope: 'all' });
        const ordinary = agent('asleep', 'all');
        const store = await legacy([os, ordinary], { inbox_access: 'none' });
        await store.writeWorkspaces([{ id: 'asleep', path: '/work/asleep', asleep: true }]);
        const upgraded = await store.readAgents();
        expect(upgraded.find((a) => a.id === os.id)!.accessScope).toBe('all');
        expect(upgraded.find((a) => a.id === ordinary.id)!.accessScope).toBe('none');
    });

    it('preserves malformed agent rows on disk and still reports their existing parse failure', async () => {
        const original = agent('target', 'all');
        const store = await legacy([original], { inbox_access: 'none' });
        const malformed = { id: 'bad', name: 'do not discard my original row' };
        await writeJsonAtomic(store.agentsFile, [original, malformed]);
        expect(await store.readAgents()).toEqual([{ ...original, accessScope: 'none' }]);
        expect(store.dropped).toHaveLength(1);
        expect(JSON.parse(await readFile(store.agentsFile, 'utf8'))[1]).toEqual(malformed);
    });
});

describe('the retired workspace control', () => {
    it('is absent from the definition and navigation and cannot be set globally or per workspace', async () => {
        expect(SETTINGS.find((s) => s.key === 'inbox_access')).toBeUndefined();
        expect(sectionOf('inbox_access')).toBeNull();
        const settings = await SettingsStore.open(home);
        await expect(settings.set('inbox_access', 'all')).rejects.toThrow(/not a setting Genie knows/);
        await expect(settings.setFor('target', 'inbox_access', 'all')).rejects.toThrow(/not a setting Genie knows/);
    });
});
