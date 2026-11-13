// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentDetail } from '../src/renderer/App.js';
import { EMPTY_SNAPSHOT, type AgentDetail, type GenieBridge, type GenieSnapshot } from '../src/renderer/bridge.js';

// A controlled promise-shaped boundary records otherwise-unhandled refusals without changing runner global handlers.
function pendingRead<T>() {
    let success: ((value: T) => unknown) | undefined; let failure: ((error: unknown) => unknown) | undefined;
    const escaped: unknown[] = [];
    const chain = {
        then(ok: (value: T) => unknown, bad?: (error: unknown) => unknown) { success = ok; if (bad) failure = bad; return chain; },
        catch(bad: (error: unknown) => unknown) { failure = bad; return chain; },
    };
    return { promise: chain as unknown as Promise<T>, escaped, resolve: (value: T) => { success?.(value); }, reject: (error: unknown) => { if (!failure) escaped.push(error); else { try { failure(error); } catch (thrown) { escaped.push(thrown); } } } };
}
function rig() {
    const reads: ReturnType<typeof pendingRead<AgentDetail | null>>[] = [];
    const snapshots = new Set<(value: GenieSnapshot) => void>();
    const agents = new Map<string, Set<(value: AgentDetail | null) => void>>();
    const agentDetail = vi.fn((_id: string) => { const read = pendingRead<AgentDetail | null>(); reads.push(read); return read.promise; });
    const bridge = {
        agentDetail,
        subscribe: (listener: (value: GenieSnapshot) => void) => { snapshots.add(listener); return () => { snapshots.delete(listener); }; },
        subscribeAgent: (id: string, listener: (value: AgentDetail | null) => void) => { const list = agents.get(id) ?? new Set(); list.add(listener); agents.set(id, list); return () => { list.delete(listener); }; },
    } as unknown as GenieBridge;
    return { bridge, reads, agentDetail, snapshots, agents, update: () => { for (const listener of [...snapshots]) listener(EMPTY_SNAPSHOT); }, push: (detail: AgentDetail) => { for (const listener of agents.get(detail.agent.id) ?? []) listener(detail); } };
}
const closed = new Error('the connection closed');
let serial = 0; let agentId: string; let host: HTMLDivElement; let root: Root;
let shown: ReturnType<typeof useAgentDetail>;
const detail = (id: string): AgentDetail => ({ agent: { id, name: 'fixture', provider: 'claude', fidelity: 'declared', cwd: '/fixture' }, session: null, rows: [], turns: 0, cost: null, refusal: null });
function Probe({ bridge, id }: { bridge: GenieBridge; id: string }) { shown = useAgentDetail(bridge, id, false); return <output>{shown.resolved ? 'resolved' : 'loading'}</output>; }
const mount = async (bridge: GenieBridge, id = agentId) => { await act(async () => { root.render(<Probe bridge={bridge} id={id} />); }); };
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; agentId = `agent_closed636_${++serial}`; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('the agent-detail caller handles a closed link (#636)', () => {
    it('owns the refusal, keeps loading distinct from not-found, and retries on a later host update', async () => {
        const w = rig(); await mount(w.bridge);
        await act(async () => { w.reads[0]!.reject(closed); });
        expect(w.reads[0]!.escaped).toEqual([]); expect(shown).toEqual({ detail: null, resolved: false });
        expect(w.agentDetail).toHaveBeenCalledTimes(1);
        await act(async () => w.update()); expect(w.agentDetail).toHaveBeenCalledTimes(2);
        await act(async () => { w.reads[1]!.resolve(null); });
        expect(shown).toEqual({ detail: null, resolved: true });
        await act(async () => w.update()); expect(w.agentDetail).toHaveBeenCalledTimes(2);
    });

    it('contains a synchronous read refusal and can recover on the next host update', async () => {
        const w = rig(); w.agentDetail.mockImplementationOnce(() => { throw closed; });
        await expect(mount(w.bridge)).resolves.toBeUndefined();
        await act(async () => w.update()); expect(w.agentDetail).toHaveBeenCalledTimes(2);
        await act(async () => { w.reads[0]!.resolve(null); }); expect(shown.resolved).toBe(true);
    });

    it('keeps this agent’s cached detail when reopening it meets a closed link', async () => {
        const first = rig(); const saved = detail(agentId); await mount(first.bridge);
        await act(async () => { first.reads[0]!.resolve(saved); });
        const next = rig(); await mount(next.bridge);
        await act(async () => { next.reads[0]!.reject(closed); });
        expect(shown.detail).toEqual(saved); expect(next.reads[0]!.escaped).toEqual([]);
    });

    it('consumes a late refusal after unmount without installing a retry subscription', async () => {
        const w = rig(); await mount(w.bridge); await act(async () => root.render(null));
        await act(async () => { w.reads[0]!.reject(closed); });
        expect(w.reads[0]!.escaped).toEqual([]); expect(w.snapshots.size).toBe(0);
    });

    it('owns an unexpected refusal without retrying it on every estate push', async () => {
        const w = rig(); await mount(w.bridge);
        await act(async () => { w.reads[0]!.reject(new Error('synthetic permission refusal')); });
        expect(w.reads[0]!.escaped).toEqual([]);
        await act(async () => w.update()); expect(w.agentDetail).toHaveBeenCalledTimes(1);
    });

    it('does not let an old host refusal retry against or replace the new host', async () => {
        const old = rig(); const next = rig(); await mount(old.bridge); await mount(next.bridge);
        const current = detail(agentId); await act(async () => { next.reads[0]!.resolve(current); old.reads[0]!.reject(closed); });
        expect(shown.detail).toEqual(current); expect(old.reads[0]!.escaped).toEqual([]);
        expect(old.snapshots.size).toBe(0); expect(next.agentDetail).toHaveBeenCalledTimes(1);
    });

    it('CONTROL: a successful null read means not-found rather than a failed read', async () => {
        const w = rig(); await mount(w.bridge); await act(async () => { w.reads[0]!.resolve(null); });
        expect(shown).toEqual({ detail: null, resolved: true }); expect(w.snapshots.size).toBe(0);
    });

    it('CONTROL: a resolved agent alias subscribes by ID and live updates still land through the cache', async () => {
        const w = rig(); await mount(w.bridge, `alias_${agentId}`); const initial = detail(agentId);
        await act(async () => { w.reads[0]!.resolve(initial); });
        expect(w.agents.get(agentId)?.size).toBe(1);
        const current = { ...initial, refusal: 'fixture update' };
        await act(async () => w.push(current)); expect(shown.detail).toEqual(current);
    });
});
