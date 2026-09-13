import { describe, expect, it } from 'vitest';
import { createTopologyStore, type ShuttleTopology } from '../topology-store';

/**
 * WHICH TOKEN IS WHICH ENDPOINT, AND WHICH TERMINALS A WORKSPACE HAS — kept by the
 * shuttle so routing outlives the Genie that published it.
 *
 * genie#346 Phase 1, `.ai/plans/genie-mcp-shuttle-spec.md` §3.2 ("the shuttle is
 * authoritative for routing") and §4.3 (terminal resolution "needs no Genie
 * round-trip"). Every URL in every `.mcp.json` carries a token. While Genie is
 * being replaced — or after the shuttle restarts with no Genie attached — a request
 * on that URL must still resolve to its workspace, or the listener 404s every agent
 * at exactly the moment the shuttle exists to keep them connected.
 *
 * So the publisher sends its topology, the shuttle persists it, and a cold boot
 * reads it back. The persistence is injected, so this needs no disk.
 */

function memoryDisk(initial: string | null = null) {
    let stored = initial;
    return { read: () => stored, write: (body: string) => void (stored = body), raw: () => stored };
}

const topology = (over: Partial<ShuttleTopology> = {}): ShuttleTopology => ({
    endpoints: {
        wsTokenA: { kind: 'workspace', workspaceId: 'ws-a' },
        legacyTerm: { kind: 'terminal', terminalId: 't-legacy' },
    },
    workspaces: { 'ws-a': ['t-1', 't-2'] },
    ...over,
});

describe('routing from the published topology', () => {
    it('resolves a workspace token and a legacy terminal token', () => {
        const store = createTopologyStore(memoryDisk());
        store.publish(topology());
        expect(store.routes().endpoint('wsTokenA')).toEqual({ kind: 'workspace', workspaceId: 'ws-a' });
        expect(store.routes().endpoint('legacyTerm')).toEqual({ kind: 'terminal', terminalId: 't-legacy' });
    });

    it('knows no endpoint for a token nobody issued', () => {
        const store = createTopologyStore(memoryDisk());
        store.publish(topology());
        expect(store.routes().endpoint('nobody')).toBeNull();
    });

    it('lists a workspace’s terminals, and none for a workspace it has not heard of', () => {
        const store = createTopologyStore(memoryDisk());
        store.publish(topology());
        expect(store.routes().workspaceTerminals('ws-a')).toEqual(['t-1', 't-2']);
        expect(store.routes().workspaceTerminals('ws-unknown')).toEqual([]);
    });

    it('does not resolve an inherited object key as a token', () => {
        // A token lookup on a plain object would find `constructor` and friends.
        const store = createTopologyStore(memoryDisk());
        store.publish(topology());
        expect(store.routes().endpoint('constructor')).toBeNull();
        expect(store.routes().endpoint('__proto__')).toBeNull();
    });

    it('replaces the topology on each publish — a closed terminal stops resolving', () => {
        const store = createTopologyStore(memoryDisk());
        store.publish(topology());
        store.publish(topology({ workspaces: { 'ws-a': ['t-1'] } }));
        expect(store.routes().workspaceTerminals('ws-a')).toEqual(['t-1']);
    });
});

describe('routing outlives the Genie that published it', () => {
    it('persists every publish', () => {
        const disk = memoryDisk();
        createTopologyStore(disk).publish(topology());
        expect(disk.raw()).not.toBeNull();
    });

    it('routes on a COLD boot from disk, with no Genie attached', () => {
        const disk = memoryDisk();
        createTopologyStore(disk).publish(topology());

        const cold = createTopologyStore(disk);
        cold.boot();

        expect(cold.routes().endpoint('wsTokenA')).toEqual({ kind: 'workspace', workspaceId: 'ws-a' });
        expect(cold.routes().workspaceTerminals('ws-a')).toEqual(['t-1', 't-2']);
    });

    it('treats a corrupt file as no topology, without throwing', () => {
        const store = createTopologyStore(memoryDisk('{ torn'));
        expect(() => store.boot()).not.toThrow();
        expect(store.routes().endpoint('wsTokenA')).toBeNull();
    });
});

describe('a malformed topology is refused whole', () => {
    it('rejects an endpoint of an unknown kind, and keeps the last good topology', () => {
        const store = createTopologyStore(memoryDisk());
        store.publish(topology());
        const bad = topology({ endpoints: { t: { kind: 'bogus', workspaceId: 'x' } as never } });
        expect(store.publish(bad)).toBe(false);
        expect(store.routes().endpoint('wsTokenA')).not.toBeNull();
    });

    it('rejects terminals that are not a list of strings', () => {
        const store = createTopologyStore(memoryDisk());
        expect(store.publish(topology({ workspaces: { 'ws-a': [1, 2] as never } }))).toBe(false);
        expect(store.publish(topology({ workspaces: { 'ws-a': 't-1' as never } }))).toBe(false);
    });

    it('rejects a token that could not appear in a URL path', () => {
        // The listener only routes `/mcp/<[A-Za-z0-9_-]+>`; anything else in a
        // topology is a bug upstream, not an endpoint.
        const store = createTopologyStore(memoryDisk());
        expect(store.publish(topology({ endpoints: { 'bad/token': { kind: 'workspace', workspaceId: 'x' } } }))).toBe(false);
    });

    it('POSITIVE CONTROL — accepts an empty topology, which is a real state', () => {
        // A Genie with no workspaces open has nothing to route. That is not
        // malformed, and refusing it would keep serving endpoints that are gone.
        const store = createTopologyStore(memoryDisk());
        store.publish(topology());
        expect(store.publish({ endpoints: {}, workspaces: {} })).toBe(true);
        expect(store.routes().endpoint('wsTokenA')).toBeNull();
    });
});
