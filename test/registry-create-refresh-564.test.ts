import { describe, expect, it, vi } from 'vitest';
import type { AgentId, AgentRecord } from '../src/core/identity.js';
import { createAgent } from '../src/main/agent-create-host.js';
import { restartAgent, type AgentRestartPorts } from '../src/main/agent-ops-host.js';
import { HostRegistryStore } from '../src/main/agent-stores-replica.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { Registry } from '../src/main/registry.js';

// Real window host-API add/restart operations, creation, registry and host-store proxy.
// Only storage transport, persona files and the provider process are replaced; no timers or OS work.
async function rig() {
    let stored: readonly AgentRecord[] = [];
    let hold: { entered: () => void; released: Promise<void> } | null = null;
    const store = new HostRegistryStore({
        registryDropped: () => [],
        call: async (family, method, args) => {
            expect(family).toBe('registry');
            if (method === 'readWorkspaces') return [{ id: 'fixture', path: '/fixture/workspace' }];
            if (method === 'readAgents') {
                const captured = structuredClone(stored);
                const pending = hold; hold = null;
                if (pending) { pending.entered(); await pending.released; }
                return captured;
            }
            if (method === 'writeAgents') { stored = structuredClone(args[0] as readonly AgentRecord[]); return; }
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
            exists: async () => false, mkdirp: async () => {}, writeText: async () => {},
            register: (input) => registry.register(input),
        }, workspaceId, input),
        agentOps: { restart: (id, kind) => restartAgent(restartPorts, id, kind) },
    } as HostApiDeps);
    const add = async () => {
        const result = await api.invoke('addAgent', ['fixture', { name: 'new-agent', purpose: 'fixture', provider: 'codex' }]) as { ok: boolean; id: string };
        expect(result.ok).toBe(true);
        expect(stored.some((record) => record.id === result.id)).toBe(true);
        return result.id;
    };
    return {
        registry, api, add, start,
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
});
