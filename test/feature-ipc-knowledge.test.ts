import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * ADDING KNOWLEDGE FROM THE SURFACE — the person's "Add a memory" is a form that opens in the
 * Knowledge surface, is validated in main (a refusal is data beside the field), files the node as
 * the USER, and then SHOWS what it did: the search is set to the new title so the node is on
 * screen, and every `[[wikilink]]` that did not resolve is reported with why — an ambiguous link
 * resolves to nothing rather than guessing (§6.7), and the person is told.
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const state = (over: Partial<FeatureState> = {}): FeatureState => ({ toolStatuses: null, knowledgeQuery: '', ...over });
const form = { title: 'Caddy replace breaks h2', body: 'Use header_up instead; see [[hosting]].', class: 'procedural' as const, scope: { kind: 'workspace' as const, id: 'tynn' } };

let dir: string;
let services: ComposedServices;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-knowledge-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0 });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('the knowledge section', () => {
    // Changed 2026-10-14 (the owner: "the knowledge graph is empty or not rendering for me"): with no query the surface
    // used to get `hits: null` and drew skeletons that never resolved — a graph with 108 memories looked empty until a
    // search. With no query it now gets the most recent memories; an empty store is `[]`, which the surface says.
    it('carries the open form and the last add, both null until something happens; with no query and nothing stored, hits is [] (not null)', async () => {
        const snap = await featureSnapshot(services, state());
        expect(snap.knowledge).toEqual({ hits: [], query: '', adding: null, lastAdd: null });
    });

    it('with NO query, lists what the graph holds — newest first, every class and scope — so opening it shows the memories', async () => {
        const names = ['', 'Caddy', 'Redis', 'Vite'];
        const at = (n: number) => services.knowledge.add({ title: `${names[n]} note`, body: `Body of the ${names[n]} note, which is long enough to be cut down to a snippet for the row.`, class: n % 2 ? 'procedural' : 'knowledge', scope: n % 3 ? { kind: 'system' } : { kind: 'workspace', id: 'tynn' }, source: 'user' });
        for (const n of [1, 2, 3]) at(n);
        const snap = await featureSnapshot(services, state());
        // COUNTED: all three, newest first, each a row the surface can draw.
        expect(snap.knowledge.hits!.map((h) => h.title)).toEqual(['Vite note', 'Redis note', 'Caddy note']);
        expect(snap.knowledge.hits![0]).toMatchObject({ class: 'procedural', snippet: expect.stringContaining('Body of the Vite note') });
        // A query still searches: the list is only what an EMPTY query shows.
        const searched = await featureSnapshot(services, state({ knowledgeQuery: 'Redis' }));
        expect(searched.knowledge.hits!.map((h) => h.title)).toContain('Redis note');
        expect(searched.knowledge.hits!.map((h) => h.title)).not.toContain('Vite note');
    });

    it('knowledge.openAdd opens the form with defaults for the machine or a workspace; cancel closes it', async () => {
        const open = await handleFeatureAction(services, { kind: 'knowledge.openAdd', workspaceId: 'tynn' }, state());
        expect(open.knowledge.adding).toEqual({ defaults: { title: '', body: '', class: 'knowledge', scope: { kind: 'workspace', id: 'tynn' } }, problems: [] });
        const system = await handleFeatureAction(services, { kind: 'knowledge.openAdd' }, state());
        expect(system.knowledge.adding!.defaults.scope).toEqual({ kind: 'system' });
        const closed = await handleFeatureAction(services, { kind: 'knowledge.cancelForm' }, state({ knowledgeAdding: open.knowledge.adding }));
        expect(closed.knowledge.adding).toBeNull();
    });

    it('a submit without a title keeps the form open with the problem; nothing is filed', async () => {
        const snap = await handleFeatureAction(services, { kind: 'knowledge.create', form: { ...form, title: '' } }, state());
        expect(snap.knowledge.adding).toMatchObject({ problems: [{ field: 'title', message: 'A memory needs a title.' }] });
        expect(services.knowledge.search({ query: 'caddy', scopes: 'all' }).hits).toEqual([]);
    });

    it('a good submit files the node as the USER, closes the form, searches for the new title so it is on screen, and reports the links that did not resolve', async () => {
        const snap = await handleFeatureAction(services, { kind: 'knowledge.create', form }, state());
        expect(snap.knowledge.adding).toBeNull();
        expect(snap.knowledge.query).toBe('Caddy replace breaks h2');
        expect(snap.knowledge.hits!.map((h) => h.title)).toEqual(['Caddy replace breaks h2']);
        expect(snap.knowledge.lastAdd).toMatchObject({ title: 'Caddy replace breaks h2', unresolved: [{ ref: 'hosting', reason: 'missing' }] });
        expect(services.knowledge.get(snap.knowledge.lastAdd!.id)!.source).toBe('user');

        // A second note titled like the link makes it resolve; two of them make it AMBIGUOUS — reported, never guessed.
        services.knowledge.add({ title: 'hosting', scope: { kind: 'system' }, source: 'user' });
        services.knowledge.add({ title: 'hosting', scope: { kind: 'workspace', id: 'fancy' }, source: 'user' });
        const again = await handleFeatureAction(services, { kind: 'knowledge.create', form: { ...form, title: 'Second note' } }, state());
        expect(again.knowledge.lastAdd).toMatchObject({ title: 'Second note', unresolved: [{ ref: 'hosting', reason: 'ambiguous' }] });
    });
});
