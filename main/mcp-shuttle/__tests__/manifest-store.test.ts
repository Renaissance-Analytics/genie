import { describe, expect, it } from 'vitest';
import { createManifestStore, type ShuttleManifest } from '../manifest-store';

/**
 * THE PUBLISHED SURFACE, and why it outlives the Genie that published it.
 *
 * genie#346 Phase 1, `.ai/plans/genie-mcp-shuttle-spec.md` §4.2.
 *
 * The shuttle serves `tools/list`, `prompts/list` and `resources/list` from the last
 * published manifest ALONE — never by asking Genie. That is what makes discovery
 * survive the swap: while Genie is being replaced there is nobody to ask, and a
 * client that re-lists mid-swap must get the same tools, not an empty list or an
 * error that reads as "your tools are gone".
 *
 * Persistence is injected, so the cold-boot case — a shuttle that restarts with no
 * Genie attached and must still answer from disk — is testable without a disk.
 */

function memoryDisk(initial: string | null = null) {
    let stored = initial;
    return {
        read: () => stored,
        write: (body: string) => void (stored = body),
        raw: () => stored,
    };
}

const manifest = (over: Partial<ShuttleManifest> = {}): ShuttleManifest => ({
    genieVersion: '0.7.0-beta.322',
    generation: 1,
    protocolVersions: ['2024-11-05'],
    serverInfo: { name: 'genie', version: '0.7.0-beta.322' },
    instructions: 'The Genie protocol.',
    capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
    tools: [
        { name: 'imDone', description: 'Signal completion.', inputSchema: { type: 'object' } },
        { name: 'agentinbox', description: 'Message agents.', inputSchema: { type: 'object' } },
    ],
    prompts: [{ name: 'connectToGenie', description: 'Orient.' }],
    resources: [],
    ...over,
});

describe('discovery is answered from the manifest, never from Genie', () => {
    it('serves the tools the publisher declared', () => {
        const store = createManifestStore(memoryDisk());
        store.publish(manifest());
        expect(store.tools()?.map((t) => t.name)).toEqual(['imDone', 'agentinbox']);
    });

    it('persists every publish, so the surface outlives the publisher', () => {
        const disk = memoryDisk();
        createManifestStore(disk).publish(manifest());
        expect(disk.raw()).not.toBeNull();
    });

    it('answers a COLD boot from disk, with no Genie attached at all', () => {
        // The shuttle restarted (or Genie is mid-swap) and nobody has published in
        // this process. The last known surface must still be served.
        const disk = memoryDisk();
        createManifestStore(disk).publish(manifest());

        const coldShuttle = createManifestStore(disk);
        coldShuttle.boot();

        expect(coldShuttle.tools()?.map((t) => t.name)).toEqual(['imDone', 'agentinbox']);
    });
});

describe('initialize is answered from the manifest too', () => {
    // An agent that STARTS while Genie is being replaced, or against a shuttle that
    // cold-booted with no Genie yet, must still be able to initialize. If only
    // Genie could answer initialize, the swap would be invisible to agents already
    // connected and fatal to every one that connects during it.
    it('serves what the publisher declared for initialize', () => {
        const store = createManifestStore(memoryDisk());
        store.publish(manifest());
        expect(store.server()).toEqual({
            protocolVersions: ['2024-11-05'],
            serverInfo: { name: 'genie', version: '0.7.0-beta.322' },
            instructions: 'The Genie protocol.',
            capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        });
    });

    it('serves it on a cold boot from disk', () => {
        const disk = memoryDisk();
        createManifestStore(disk).publish(manifest());
        const cold = createManifestStore(disk);
        cold.boot();
        expect(cold.server()?.serverInfo.name).toBe('genie');
    });

    it('reports it as null when nothing was ever published', () => {
        const store = createManifestStore(memoryDisk());
        store.boot();
        expect(store.server()).toBeNull();
    });

    it('rejects a manifest that could not answer initialize, and keeps the last good one', () => {
        const store = createManifestStore(memoryDisk());
        store.publish(manifest());
        const { protocolVersions: _dropped, ...incomplete } = manifest({ generation: 2 });

        expect(store.publish(incomplete as unknown as ShuttleManifest).accepted).toBe(false);
        expect(store.server()?.protocolVersions).toEqual(['2024-11-05']);
    });

    it('rejects a manifest that names NO protocol version it can speak', () => {
        // Negotiation needs at least one to fall back to.
        const store = createManifestStore(memoryDisk());
        expect(store.publish(manifest({ protocolVersions: [] })).accepted).toBe(false);
        expect(store.server()).toBeNull();
    });
});

describe('nothing to serve is said honestly, not as an empty list', () => {
    it('reports NO manifest as null rather than as zero tools', () => {
        // An empty tool list tells an agent "this server has no tools", which is
        // precisely the misreading genie#346 is about. Absence is returned as null
        // so the listener can answer with a named state instead.
        const store = createManifestStore(memoryDisk());
        store.boot();
        expect(store.tools()).toBeNull();
        expect(store.prompts()).toBeNull();
    });

    it('POSITIVE CONTROL — a manifest that genuinely declares no tools is an EMPTY LIST, not null', () => {
        // Without this, "null when absent" also passes for a store that returns null
        // for everything. The distinction under test is absent versus empty.
        const store = createManifestStore(memoryDisk());
        store.publish(manifest({ tools: [] }));
        expect(store.tools()).toEqual([]);
    });

    it('survives a CORRUPT manifest on disk as "no manifest", without throwing', () => {
        // A torn write must not take the shuttle's discovery down with it.
        const store = createManifestStore(memoryDisk('{ this is not json'));
        expect(() => store.boot()).not.toThrow();
        expect(store.tools()).toBeNull();
    });

    it('rejects a manifest missing required fields, and keeps the last good one', () => {
        const store = createManifestStore(memoryDisk());
        store.publish(manifest());
        const bad = { generation: 2 } as unknown as ShuttleManifest;

        expect(store.publish(bad).accepted).toBe(false);
        expect(store.tools()?.map((t) => t.name)).toEqual(['imDone', 'agentinbox']);
    });
});

describe('list_changed fires only when a list actually changed', () => {
    it('reports tools changed when the tool set moves', () => {
        const store = createManifestStore(memoryDisk());
        store.publish(manifest());
        const outcome = store.publish(
            manifest({
                generation: 2,
                tools: [...manifest().tools, { name: 'lists', description: 'Lists.', inputSchema: {} }],
            }),
        );
        expect(outcome.changed).toEqual(['tools']);
    });

    it('reports NOTHING changed when a new Genie republishes the same surface', () => {
        // A routine swap republishes an identical manifest. Emitting list_changed
        // for it would make every connected client re-fetch on every Genie restart
        // — a notification storm that looks like churn and is not.
        const store = createManifestStore(memoryDisk());
        store.publish(manifest({ generation: 1 }));
        const outcome = store.publish(manifest({ generation: 2, genieVersion: '0.7.0-beta.323' }));
        expect(outcome.changed).toEqual([]);
    });

    it('is insensitive to KEY ORDER within a tool, but not to its content', () => {
        // Two builds can serialise the same schema with keys in a different order.
        // That is not a change; a changed description is.
        const store = createManifestStore(memoryDisk());
        store.publish(
            manifest({ tools: [{ name: 't', description: 'd', inputSchema: { type: 'object', a: 1 } }] }),
        );

        const reordered = store.publish(
            manifest({ tools: [{ inputSchema: { a: 1, type: 'object' }, description: 'd', name: 't' }] }),
        );
        expect(reordered.changed).toEqual([]);

        const edited = store.publish(
            manifest({ tools: [{ name: 't', description: 'CHANGED', inputSchema: { a: 1, type: 'object' } }] }),
        );
        expect(edited.changed).toEqual(['tools']);
    });

    it('names every list that changed, in a fixed order', () => {
        const store = createManifestStore(memoryDisk());
        store.publish(manifest());
        const outcome = store.publish(
            manifest({
                tools: [],
                prompts: [],
                resources: [{ uri: 'genie://x', name: 'x' }],
            }),
        );
        expect(outcome.changed).toEqual(['tools', 'prompts', 'resources']);
    });

    it('treats the FIRST publish after a cold boot as a change only if it differs from disk', () => {
        // A shuttle that booted from disk already serves that surface. The Genie
        // that attaches next republishes it; clients' cached lists are still valid.
        const disk = memoryDisk();
        createManifestStore(disk).publish(manifest());

        const cold = createManifestStore(disk);
        cold.boot();
        expect(cold.publish(manifest({ generation: 1 })).changed).toEqual([]);
    });
});
