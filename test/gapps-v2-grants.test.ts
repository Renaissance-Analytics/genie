import { describe, expect, it } from 'vitest';
import { Catalog, type ElementDefinition } from '../src/core/catalog.js';
import { callDecision, grantFor, installReview, PERSON_ONLY_TOOLS, updateReview, type GAppRequest } from '../src/core/gapp-grants.js';
import { genieCatalog } from '../src/main/genie-catalog.js';

/**
 * GAPPS V2, V2 (Tynn #567; spec .ai/plans/specs/gapps-v2.md, approved 2026-11-08): THE GRANT MODEL, pure. A grant is the
 * host's record of what the person allowed one app: the manifest asks, the grant answers.
 *  - The install review lists each element the app `uses` by its CATALOG name and description, never the app's words,
 *    and each network host. An element Genie does not have, or one that is ungrantable (`grantable: false`, or gated by
 *    the person's approval), refuses the install by name.
 *  - An update asks again only for what is new; nothing new installs straight away.
 *  - At each call: granted, still in Genie, still grantable, and inside the grant's scope; otherwise refused by name.
 *  - Genie's own tools that act as the person, or wait on the person's approval, are `grantable: false` (decision 3).
 */
const tool = (id: string, name: string, over: Record<string, unknown> = {}): ElementDefinition => ({
    id, kind: 'tool', version: '1.0.0', packageId: 'com.example.notes', source: 'plugin',
    docs: { name, description: `${name}, as Genie describes it.` },
    reach: { scopes: ['workspace'], side: 'host', requiresWindow: false, remote: 'local' },
    permissions: { capabilities: [], network: [] },
    payload: { handler: id, inputSchema: { type: 'object' }, ...over },
});
function catalogWith(...defs: ElementDefinition[]) {
    const c = new Catalog();
    const r = c.register({ id: 'com.example.notes', version: '1.0.0', source: 'plugin', contributions: defs });
    if (!r.ok) throw new Error(r.problems.join('; '));
    return (id: string) => c.get(id);
}
const catalog = catalogWith(
    tool('com.example.notes.append', 'Append a note'),
    tool('com.example.notes.search', 'Search notes'),
    tool('com.example.notes.wipe', 'Wipe every note', { grantable: false }),
    tool('com.example.notes.publish', 'Publish', { gated: true }),
);
const request = (over: Partial<GAppRequest> = {}): GAppRequest => ({
    packageId: 'com.example.notesapp', version: '1.0.0', digest: 'a'.repeat(64), publisher: 'sha256:abc',
    uses: ['com.example.notes.append'], network: ['api.example.com'], ...over,
});

describe('the install review', () => {
    it('lists each element by its catalog name and description, and each host; never the app\'s own words', () => {
        const r = installReview(request(), catalog);
        expect(r).toEqual({
            ok: true, publisher: 'sha256:abc',
            items: [
                { kind: 'element', id: 'com.example.notes.append', name: 'Append a note', description: 'Append a note, as Genie describes it.' },
                { kind: 'network', host: 'api.example.com' },
            ],
        });
    });

    it('an ungrantable element refuses the install, naming it; so does one gated by the person\'s approval', () => {
        for (const id of ['com.example.notes.wipe', 'com.example.notes.publish']) {
            const r = installReview(request({ uses: ['com.example.notes.append', id] }), catalog);
            expect(r.ok, id).toBe(false);
            if (!r.ok) expect(r.problems.join('\n')).toMatch(new RegExp(`"${id.replace(/\./g, '\\.')}".*never granted to an app`));
        }
    });

    it('an element Genie does not have refuses the install, naming it', () => {
        const r = installReview(request({ uses: ['com.example.nothing'] }), catalog);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.problems.join('\n')).toMatch(/"com\.example\.nothing" is not in Genie/);
    });
});

describe('an update asks again only for what is new', () => {
    const grant = grantFor(request(), { scope: ['ws-a'], now: 1000 });

    it('the grant is what the person approved: uses, hosts, scope, digest, publisher, by the person', () => {
        expect(grant).toEqual({
            packageId: 'com.example.notesapp', version: '1.0.0', digest: 'a'.repeat(64), publisher: 'sha256:abc',
            uses: ['com.example.notes.append'], network: ['api.example.com'], scope: ['ws-a'], grantedAt: 1000, grantedBy: 'person',
        });
    });

    it('asking for nothing new: no consent; it installs straight away', () => {
        expect(updateReview(grant, request({ version: '1.1.0', digest: 'b'.repeat(64) }), catalog)).toEqual({ ok: true, consent: false });
        // Asking for LESS is nothing new either.
        expect(updateReview(grant, request({ version: '1.2.0', uses: [], network: [] }), catalog)).toEqual({ ok: true, consent: false });
    });

    it('one new element: consent again, listing only that element, by its catalog name', () => {
        const r = updateReview(grant, request({ version: '1.1.0', uses: ['com.example.notes.append', 'com.example.notes.search'] }), catalog);
        expect(r).toEqual({ ok: true, consent: true, items: [{ kind: 'element', id: 'com.example.notes.search', name: 'Search notes', description: 'Search notes, as Genie describes it.' }] });
    });

    it('a new host, or a new publisher, is new too', () => {
        expect(updateReview(grant, request({ network: ['api.example.com', 'cdn.example.com'] }), catalog)).toEqual({ ok: true, consent: true, items: [{ kind: 'network', host: 'cdn.example.com' }] });
        expect(updateReview(grant, request({ publisher: 'sha256:def' }), catalog)).toEqual({ ok: true, consent: true, items: [{ kind: 'publisher', from: 'sha256:abc', to: 'sha256:def' }] });
    });

    it('an update that now lists an ungrantable element is refused, naming it', () => {
        const r = updateReview(grant, request({ uses: ['com.example.notes.append', 'com.example.notes.wipe'] }), catalog);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.problems.join('\n')).toMatch(/"com\.example\.notes\.wipe".*never granted to an app/);
    });
});

describe('at each call', () => {
    const scoped = grantFor(request(), { scope: ['ws-a'], now: 1000 });
    const everywhere = grantFor(request(), { scope: 'workstation', now: 1000 });

    it('a granted element, inside the scope: allowed', () => {
        expect(callDecision(scoped, { elementId: 'com.example.notes.append', workspaceId: 'ws-a' }, catalog)).toEqual({ allowed: true });
        expect(callDecision(everywhere, { elementId: 'com.example.notes.append', workspaceId: 'ws-z' }, catalog)).toEqual({ allowed: true });
    });

    it('a workspace outside the scope is refused by name', () => {
        const r = callDecision(scoped, { elementId: 'com.example.notes.append', workspaceId: 'ws-b' }, catalog);
        expect(r).toMatchObject({ allowed: false });
        if (!r.allowed) expect(r.reason).toMatch(/ws-b is outside .*grant.*ws-a/);
    });

    it('an element it was not granted is refused, naming it', () => {
        const r = callDecision(scoped, { elementId: 'com.example.notes.search', workspaceId: 'ws-a' }, catalog);
        expect(r).toMatchObject({ allowed: false, notGranted: 'com.example.notes.search' });
    });

    it('an element no longer in Genie, or no longer grantable, is refused even though it was granted', () => {
        const gone = catalogWith(tool('com.example.notes.search', 'Search notes'));
        expect(callDecision(scoped, { elementId: 'com.example.notes.append', workspaceId: 'ws-a' }, gone)).toMatchObject({ allowed: false, reason: expect.stringMatching(/no longer in Genie/) });
        const nowPersonOnly = catalogWith(tool('com.example.notes.append', 'Append a note', { grantable: false }));
        expect(callDecision(scoped, { elementId: 'com.example.notes.append', workspaceId: 'ws-a' }, nowPersonOnly)).toMatchObject({ allowed: false, reason: expect.stringMatching(/never granted to an app/) });
    });
});

describe('Genie\'s own tools that act as the person are never granted', () => {
    it('each is grantable: false in Genie\'s catalog; an app listing one is refused by name', () => {
        const genie = genieCatalog();
        // `lists` too (the coordinator's ruling, 2026-11-08): its items put work in front of the person; start conservative.
        expect([...PERSON_ONLY_TOOLS].sort()).toEqual(['ForceTheQuestion', 'agentinbox', 'createAgent', 'flows', 'imDone', 'lists', 'mail', 'manageTerminals', 'pages', 'plan', 'processes', 'services', 'sites', 'thumbsUp', 'workspaceTabs'].sort());
        for (const id of PERSON_ONLY_TOOLS) {
            expect(genie.get(id)?.payload.grantable, id).toBe(false);
            const r = installReview(request({ uses: [id] }), (x) => genie.get(x));
            expect(r.ok, id).toBe(false);
        }
    });

    it('CONTROL: Genie\'s other tools are grantable, and an app may list them', () => {
        const genie = genieCatalog();
        for (const id of ['knowledge', 'checkIssues', 'openFileForUser']) {
            expect(genie.get(id), id).not.toBeNull();
            expect(genie.get(id)?.payload.grantable, id).not.toBe(false);
            expect(installReview(request({ uses: [id], network: [] }), (x) => genie.get(x)).ok, id).toBe(true);
        }
    });
});
