import { describe, expect, it, vi } from 'vitest';
import { HostRegistryStore, storeReplicas } from '../src/main/agent-stores-replica.js';
import type { StoresDump } from '../src/main/agent-stores-host.js';
import { watchRegistryRefresh } from '../src/main/registry-refresh.js';

// Real replica change/reconnect notifications and real HostRegistryStore reads; no Electron, files or host process.
const dump: StoresDump = { inbox: { messages: [], cursors: {} }, attention: { lists: [], questions: [], finished: [] }, approvals: { deck: [], auto: [], cancelled: [] }, settings: null, registryDropped: [] };
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function rig(report?: (error: unknown) => void) {
    let respond: (method: string) => Promise<unknown> = async () => [];
    const calls: string[] = []; const errors: unknown[] = [];
    const source = storeReplicas(async (store, method) => { expect(store).toBe('registry'); calls.push(method); return respond(method); });
    const store = new HostRegistryStore(source);
    const registry = { refresh: vi.fn(async () => { await store.readWorkspaces(); await store.readAgents(); }) };
    const stop = watchRegistryRefresh(source, registry, report ?? ((error) => { errors.push(error); }));
    return { calls, errors, registry, stop, respond: (read: typeof respond) => { respond = read; }, changed: () => source.apply({ store: 'registry', kind: 'written' }), reconnect: () => source.rebase(dump) };
}

describe('the window owns its registry refresh promise (#636)', () => {
    it('reads the registry through its real host proxy when the replica announces a change', async () => {
        const w = rig();
        try {
            w.changed(); await drain();
            expect(w.calls).toEqual(['readWorkspaces', 'readAgents']);
            expect(w.registry.refresh).toHaveBeenCalledTimes(1);
            expect(w.errors).toEqual([]);
        } finally { w.stop(); }
    });

    it('handles a closed-link read, waits for the actual reconnect, and reads again without replaying any write', async () => {
        const w = rig(); const closed = new Error("Genie's agent host is not connected; it is being restarted. Try again in a moment.");
        try {
            w.respond(async () => { throw closed; }); w.changed(); await drain();
            expect(w.errors).toEqual([closed]);
            expect(w.calls).toEqual(['readWorkspaces']);
            await drain(); expect(w.registry.refresh).toHaveBeenCalledTimes(1);
            w.respond(async () => []); w.reconnect(); await drain();
            expect(w.calls).toEqual(['readWorkspaces', 'readWorkspaces', 'readAgents']);
            expect(w.registry.refresh).toHaveBeenCalledTimes(2);
        } finally { w.stop(); }
    });

    it('coalesces notifications while a read is pending into one later refresh, without overlapping calls', async () => {
        const w = rig(); let release!: () => void; let first = true;
        const held = new Promise<unknown>((resolve) => { release = () => resolve([]); });
        w.respond(async () => { if (first) { first = false; return held; } return []; });
        try {
            w.changed(); for (let i = 0; i < 8; i++) w.changed();
            expect(w.calls).toEqual(['readWorkspaces']);
            release(); await drain();
            expect(w.registry.refresh).toHaveBeenCalledTimes(2);
            expect(w.calls).toEqual(['readWorkspaces', 'readAgents', 'readWorkspaces', 'readAgents']);
        } finally { release(); await drain(); w.stop(); }
    });

    it('reports an unexpected failure of the second read rather than pretending the refresh succeeded', async () => {
        const w = rig(); const denied = new Error('synthetic read permission denied');
        try {
            w.respond(async (method) => { if (method === 'readAgents') throw denied; return []; });
            w.changed(); await drain();
            expect(w.calls).toEqual(['readWorkspaces', 'readAgents']);
            expect(w.errors).toEqual([denied]);
            await drain(); expect(w.registry.refresh).toHaveBeenCalledTimes(1);
        } finally { w.stop(); }
    });

    it('contains a synchronous refresh throw and a failing reporter, then allows a later refresh', async () => {
        const failed = new Error('synthetic synchronous failure');
        const report = vi.fn(() => { throw new Error('synthetic log unavailable'); }); const w = rig(report);
        try {
            w.registry.refresh.mockImplementationOnce(() => { throw failed; });
            w.changed(); await drain();
            expect(report).toHaveBeenCalledExactlyOnceWith(failed);
            w.changed(); await drain();
            expect(w.calls).toEqual(['readWorkspaces', 'readAgents']);
            expect(w.registry.refresh).toHaveBeenCalledTimes(2);
        } finally { w.stop(); }
    });

    it('CONTROL: disposal stops later change and reconnect notifications from starting work', async () => {
        const w = rig(); w.stop(); w.stop(); w.changed(); w.reconnect(); await drain();
        expect(w.registry.refresh).not.toHaveBeenCalled();
        expect(w.calls).toEqual([]); expect(w.errors).toEqual([]);
    });

    it('CONTROL: installing the listener alone performs no unsolicited reads or writes', async () => {
        const w = rig();
        try { await drain(); expect(w.registry.refresh).not.toHaveBeenCalled(); expect(w.calls).toEqual([]); }
        finally { w.stop(); }
    });
});
