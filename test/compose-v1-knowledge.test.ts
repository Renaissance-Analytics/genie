import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * GENIE 1's KNOWLEDGE GRAPH COMES THROUGH THE UPGRADE (2026-10-14). The owner: "the knowledge graph is
 * empty or not rendering for me. We had so much important information in there." Measured: v1's
 * `genie.db` held 108 `knowledge_nodes` and 322 `knowledge_edges`; Genie 2's `knowledge.db` held 0 and 0.
 * The v1 import carried workspaces, agents and settings and never knowledge.
 *
 * These tests compose the services the way boot does, with a v1 reader that answers what v1's
 * database holds (invented values — never the owner's), and look at the store the surfaces read.
 */

const pty: PtyPort = {
    open: () => ({ id: 'term_1', pid: 501, shell: 'sh', scrollback: '' }),
    write: () => true,
    resize: () => true,
    kill: () => true,
    scrollback: () => '',
    onData: () => () => {},
    onExit: () => () => {},
};

const A = '1b4e28ba-2fa1-4d2a-883f-0016d3cca427';
const B = '6fa459ea-ee8a-4ca4-894e-db77e160355e';
const C = '9c5b94b1-35ad-49bb-b118-8e8fc24abf80';

/** What `readV1Knowledge` answers for a v1 database: rows as v1 stores them (epoch-ms times, tags as JSON text). */
const v1 = {
    nodes: [
        { id: A, title: 'Front door ports', body: 'Ports are picked at boot. See [[Caddy over h2]] and [[a note nobody wrote]].', tags: '["caddy","ports"]', source: 'agent', class: 'procedural', scopeKind: 'system', scopeRef: null, createdAt: Date.UTC(2026, 6, 1, 9, 0, 0), updatedAt: Date.UTC(2026, 6, 2, 10, 30, 0) },
        { id: B, title: 'Caddy over h2', body: 'A replace directive drops WebSocket upgrades over h2.', tags: '["caddy"]', source: 'user', class: 'knowledge', scopeKind: 'workspace', scopeRef: 'ws-example', createdAt: Date.UTC(2026, 6, 3), updatedAt: Date.UTC(2026, 6, 3) },
        { id: C, title: 'Replies stay short', body: 'The person reads replies on a phone.', tags: '[]', source: 'agent', class: 'profile', scopeKind: 'workspace', scopeRef: '__system__', createdAt: Date.UTC(2026, 6, 4), updatedAt: Date.UTC(2026, 6, 5) },
    ],
    edges: [
        { fromId: A, toRef: 'Caddy over h2', kind: 'wiki' },
        { fromId: A, toRef: 'a note nobody wrote', kind: 'wiki' },
        { fromId: C, toRef: A, kind: 'explicit' },
    ],
};

let dir: string;
let services: ComposedServices | null;

const boot = async (v1Knowledge: () => typeof v1 | null): Promise<ComposedServices> => {
    // `v1Knowledge` is the reader boot wires to Genie 1's database; the cast keeps this file loadable on a tree without it.
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, v1Knowledge } as never);
    return services;
};
const all = (s: ComposedServices) => s.knowledge.list({ scopes: 'all', limit: 200 }).nodes;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-compose-v1-knowledge-'));
    services = null;
});

afterEach(async () => {
    await services?.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe("Genie 1's knowledge at boot", () => {
    it('carries every v1 node over whole — its id, title, body, class, tags, source, scope and times — and its edges resolve', async () => {
        const s = await boot(() => v1);
        expect(all(s).map((n) => n.id).sort()).toEqual([A, B, C].sort());

        const a = s.knowledge.get(A)!;
        expect(a).toMatchObject({
            title: 'Front door ports',
            slug: 'front-door-ports',
            class: 'procedural',
            tags: ['caddy', 'ports'],
            scope: { kind: 'system' },
            source: 'agent',
            createdAt: '2026-07-01T09:00:00.000Z',
            updatedAt: '2026-07-02T10:30:00.000Z',
        });
        // The wikilink to B resolves; the one v1 could not resolve either stays as written and says so.
        expect(a.links).toEqual([B]);
        expect(a.unresolved).toEqual([{ ref: 'a note nobody wrote', reason: 'missing' }]);
        // v1's explicit edge (by id) comes through as an explicit edge, and shows as a backlink.
        expect([...a.backlinks].sort()).toEqual([C]);

        const b = s.knowledge.get(B)!;
        expect(b).toMatchObject({ class: 'knowledge', source: 'user', scope: { kind: 'workspace', id: 'ws-example' } });
        expect(b.backlinks).toEqual([A]);

        // v1's `__system__` workspace (its OS agent's home) is not a Genie 2 workspace: its memories are this machine's.
        const c = s.knowledge.get(C)!;
        expect(c).toMatchObject({ class: 'profile', scope: { kind: 'system' } });
        expect(c.links).toEqual([A]);

        // And search finds them — the Knowledge Graph surface asks the store through search.
        expect(s.knowledge.search({ query: 'websocket', scopes: 'all' }).hits.map((h) => h.id)).toEqual([B]);
    });

    it('runs ONCE: a second boot imports nothing twice, keeps an edit made in Genie 2, and does not bring back a node deleted in Genie 2', async () => {
        const first = await boot(() => v1);
        expect(all(first)).toHaveLength(3);
        expect(first.knowledge.update(A, { body: 'Edited in Genie 2.' })).toBe(true);
        expect(first.knowledge.remove(C)).toBe(true);
        await first.shutdown();

        const second = await boot(() => v1);
        expect(all(second).map((n) => n.id).sort()).toEqual([A, B].sort());
        expect(second.knowledge.get(A)!.body).toBe('Edited in Genie 2.');
    });

    it('a boot that cannot see Genie 1 imports nothing — and a later boot that can see it still imports (the import is not spent on a blind boot)', async () => {
        const blind = await boot(() => null);
        expect(all(blind)).toEqual([]);
        await blind.shutdown();

        const seeing = await boot(() => v1);
        expect(all(seeing)).toHaveLength(3);
    });

    it('an install that already imported v1 workspaces before this existed still gets its knowledge: nothing in the knowledge store says it ran, so it runs', async () => {
        // The owner's case: ~/.genie/v1-import.json exists (workspaces imported on an earlier boot) and knowledge.db is empty.
        // The knowledge import's "once" is the knowledge store's own record, so a store that has never imported imports now.
        const before = await boot(() => null);
        before.knowledge.add({ title: 'Written in Genie 2 first', scope: { kind: 'system' }, source: 'user' });
        await before.shutdown();

        const after = await boot(() => v1);
        const titles = all(after).map((n) => n.title).sort();
        expect(titles).toEqual(['Caddy over h2', 'Front door ports', 'Replies stay short', 'Written in Genie 2 first']);
    });
});
