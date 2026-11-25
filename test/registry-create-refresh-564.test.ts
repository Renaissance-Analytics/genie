import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { AgentId, AgentRecord } from '../src/core/identity.js';
import { SCHEMA_REVISION } from '../src/core/workspace-model.js';
import { createAgent } from '../src/main/agent-create-host.js';
import { restartAgent, type AgentRestartPorts } from '../src/main/agent-ops-host.js';
import { HostRegistryStore } from '../src/main/agent-stores-replica.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { Registry } from '../src/main/registry.js';
import type { RecordChange } from '../src/main/store.js';

// Real window host-API add/restart operations, creation, registry and host-store proxy.
// Only storage transport, persona files and the provider process are replaced; no timers or OS work.

/** The store's per-record change (store.ts changeAgents / changeWorkspaces, Tynn #1007), on the fixture's list. */
function applied<T extends { id: string }>(list: readonly T[], change: RecordChange<T>): T[] {
    const gone = new Set(change.remove ?? []);
    let next = list.filter((r) => !gone.has(r.id));
    for (const p of change.patch ?? []) next = next.map((r) => {
        if (r.id !== p.id) return r;
        const out: Record<string, unknown> = { ...r };
        for (const key of p.unset ?? []) delete out[key];
        Object.assign(out, p.set ?? {});
        return out as T;
    });
    for (const r of change.add ?? []) if (!next.some((x) => x.id === r.id)) next = [...next, r];
    return next;
}

async function rig() {
    let stored: readonly AgentRecord[] = [];
    let workspaces: ReadonlyArray<{ id: string; path: string; defaultAgentId?: string }> = [{ id: 'fixture', path: '/fixture/workspace' }];
    const files = new Map([[join('/fixture/workspace', 'project.json'), JSON.stringify({
        $schema: `https://raw.githubusercontent.com/Civicognita/shared-schemas/v${SCHEMA_REVISION}/schemas/workspace/project.schema.json`, name: 'fixture',
    })]]);
    let hold: { entered: () => void; released: Promise<void> } | null = null;
    let holdWrite: { entered: () => void; released: Promise<void> } | null = null;
    const store = new HostRegistryStore({
        registryDropped: () => [],
        call: async (family, method, args) => {
            expect(family).toBe('registry');
            if (method === 'readWorkspaces') return structuredClone(workspaces);
            // The first agent of a workspace is its default, recorded with the agent (Tynn #1015).
            if (method === 'changeWorkspaces') { workspaces = applied(workspaces, structuredClone(args[0]) as RecordChange<(typeof workspaces)[number]>); return structuredClone(workspaces); }
            if (method === 'readAgents') {
                const captured = structuredClone(stored);
                const pending = hold; hold = null;
                if (pending) { pending.entered(); await pending.released; }
                return captured;
            }
            if (method === 'changeAgents') {
                const change = structuredClone(args[0]) as RecordChange<AgentRecord>;
                const pending = holdWrite; holdWrite = null;
                if (pending) { pending.entered(); await pending.released; }
                stored = applied(stored, change); return structuredClone(stored);
            }
            if (method === 'readRunningAtQuit' || method === 'readInterruptedAtQuit') return [];
            throw new Error(`unexpected fixture store call: ${method}`);
        },
    });
    const registry = new Registry(store);
    await registry.load({ name: 'fixture', healthy: true });
    const start = vi.fn(() => ({ ok: true as const }));
    const restartPorts: AgentRestartPorts = {
        registry: { find: (id) => registry.find(id as AgentId), clearThread: (id) => registry.clearThread(id) },
        host: { start, stop: () => false, ended: async () => null, probe: () => null, deliverOwed: async () => 0 },
        startRefusal: () => null, cwdFor: () => '/fixture/workspace',
    };
    // These are the only two methods invoked. Missing unrelated ports fail loudly if accidentally used.
    const api = buildHostApi({
        registerAgent: (workspaceId, input) => createAgent({
            workspace: (id) => registry.workspace(id),
            agentsOf: (id) => registry.agentsOf(id),
            exists: async () => false, mkdirp: async () => {}, listDirs: async () => [],
            readText: async (path) => files.get(path) ?? null,
            writeTextAtomic: async (path, text) => { files.set(path, text); },
            register: (input) => registry.register(input),
        }, workspaceId, input),
        agentOps: { restart: (id, kind) => restartAgent(restartPorts, id, kind) },
    } as HostApiDeps);
    const add = async () => {
        const result = await api.invoke('addAgent', ['fixture', { name: 'new-agent', purpose: 'fixture', provider: 'codex' }]) as { ok: boolean; id: string };
        expect(result.ok).toBe(true);
        expect(stored.some((record) => record.id === result.id)).toBe(true);
        expect(workspaces[0]?.defaultAgentId).toBe(result.id);
        return result.id;
    };
    return {
        registry, api, add, start,
        externalRecords: (change: (records: readonly AgentRecord[]) => readonly AgentRecord[]) => { stored = structuredClone(change(stored)); },
        holdWrite: () => {
            let entered!: () => void, release!: () => void;
            const writing = new Promise<void>((resolve) => { entered = resolve; });
            const released = new Promise<void>((resolve) => { release = resolve; });
            holdWrite = { entered, released };
            return { writing, release };
        },
        holdRead: () => {
            let entered!: () => void, release!: () => void;
            const reading = new Promise<void>((resolve) => { entered = resolve; });
            const released = new Promise<void>((resolve) => { release = resolve; });
            hold = { entered, released };
            return { reading, release };
        },
    };
}

describe('newly created agents stay available through registry refresh (Tynn #564)', () => {
    it('starts the just-created agent after an older in-flight host-store read returns', async () => {
        const r = await rig();
        const held = r.holdRead();
        const refreshing = r.registry.refresh();
        await held.reading;
        const id = await r.add();
        held.release(); await refreshing;
        expect(await r.api.invoke('agents.restart', [id, 'graceful'])).toEqual({ ok: true, kind: 'graceful' });
        expect(r.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id }), '/fixture/workspace');
    });

    it('CONTROL: starts immediately when no older refresh is in flight', async () => {
        const r = await rig();
        const id = await r.add();
        expect(await r.api.invoke('agents.restart', [id, 'graceful'])).toEqual({ ok: true, kind: 'graceful' });
        expect(r.start).toHaveBeenCalledTimes(1);
    });

    it('keeps the created agent when refresh begins while its host-store write is pending', async () => {
        const r = await rig();
        const held = r.holdWrite();
        const adding = r.add();
        await held.writing;
        const refreshing = r.registry.refresh();
        // Let a stale read complete if refresh incorrectly reads through the unfinished write.
        for (let i = 0; i < 20; i++) await Promise.resolve();
        held.release();
        const id = await adding;
        await refreshing;
        expect(await r.api.invoke('agents.restart', [id, 'graceful'])).toEqual({ ok: true, kind: 'graceful' });
        expect(r.start).toHaveBeenCalledTimes(1);
    });

    it('CONTROL: later external edits and deletion still replace the local record', async () => {
        const r = await rig();
        const id = await r.add();
        r.externalRecords((records) => records.map((record) => record.id === id ? { ...record, name: 'renamed' } : record));
        await r.registry.refresh();
        expect(r.registry.find(id as AgentId)?.name).toBe('renamed');
        r.externalRecords((records) => records.filter((record) => record.id !== id));
        await r.registry.refresh();
        expect(r.registry.find(id as AgentId)).toBeNull();
        expect(await r.api.invoke('agents.restart', [id, 'graceful'])).toEqual({ ok: false, reason: 'unknown agent' });
        expect(r.start).not.toHaveBeenCalled();
    });
});
