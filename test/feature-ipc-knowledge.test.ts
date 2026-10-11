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
    it('carries the open form and the last add, both null until something happens', async () => {
        const snap = await featureSnapshot(services, state());
        expect(snap.knowledge).toEqual({ hits: null, query: '', adding: null, lastAdd: null });
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
