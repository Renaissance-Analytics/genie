import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IPC_INVENTORY } from '../src/core/ipc-inventory.js';
import type { TynnBoardPorts } from '../src/main/tynn-board-client.js';
import { runTynnPageAction } from '../src/main/tynn-page-client.js';

/**
 * FEATURES, DOMAINS AND REPOSITORIES WRITE AS ON tynn.ai (genie#1295 row F1, Tynn story #325, workspace-ux 0.10.0): each
 * write goes through `workspaces.tynnPageAction` (no new protocol method), on the WORKSPACE's own project through the
 * person's pairing. Only the web form's fields; a row's write names the row; Tynn's 422 in Tynn's words, its 404 as
 * signed out. A write answers the row (or nothing, for a delete), so the tab reads the page again through the host.
 */
function ports(answer: { ok: boolean; status: number; body: unknown }, linked = true, signedIn = true) {
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];
    const p: TynnBoardPorts = {
        signedIn: () => signedIn,
        projectFor: (id) => (linked && id === 'work' ? 'proj' : null),
        request: async (path, init) => {
            requests.push({ path, method: init.method, ...(init.body !== undefined ? { body: init.body } : {}) });
            return { ok: answer.ok, status: answer.status, json: async () => answer.body };
        },
    };
    return { p, requests };
}

describe('a Features write', () => {
    it('creates a feature with only the form\'s fields, and answers that the page is to be read again', async () => {
        const { p, requests } = ports({ ok: true, status: 201, body: { id: 'f9', title: 'Board' } });
        const r = await runTynnPageAction(p, 'work', { action: 'feature.create', body: { title: 'Board', description: 'Cards', domain_id: 'd1', slug: 'x', project_id: 'other' } });
        expect(r).toEqual({ ok: true, page: null });
        expect(requests).toEqual([{ path: '/api/v1/projects/proj/features', method: 'POST', body: { title: 'Board', description: 'Cards', domain_id: 'd1' } }]);
    });

    it('updates and deletes the row it names, for features, domains and repositories', async () => {
        const { p, requests } = ports({ ok: true, status: 200, body: {} });
        expect(await runTynnPageAction(p, 'work', { action: 'feature.update', id: 'f1', body: { title: 'Board', description: 'Cards' } })).toEqual({ ok: true, page: null });
        expect(await runTynnPageAction(p, 'work', { action: 'domain.update', id: 'd1', body: { name: 'Work' } })).toEqual({ ok: true, page: null });
        expect(await runTynnPageAction(p, 'work', { action: 'repository.update', id: 'r1', body: { url: 'https://github.com/x/y', kind: 'code' } })).toEqual({ ok: true, page: null });
        const gone = ports({ ok: true, status: 204, body: null });
        for (const [action, id] of [['feature.delete', 'f1'], ['domain.delete', 'd1'], ['repository.delete', 'r1']] as const) {
            expect(await runTynnPageAction(gone.p, 'work', { action, id })).toEqual({ ok: true, page: null });
        }
        expect(requests.map((x) => `${x.method} ${x.path}`)).toEqual(['PATCH /api/v1/projects/proj/features/f1', 'PATCH /api/v1/projects/proj/domains/d1', 'PATCH /api/v1/projects/proj/repositories/r1']);
        expect(gone.requests).toEqual([
            { path: '/api/v1/projects/proj/features/f1', method: 'DELETE' },
            { path: '/api/v1/projects/proj/domains/d1', method: 'DELETE' },
            { path: '/api/v1/projects/proj/repositories/r1', method: 'DELETE' },
        ]);
    });

    it('says Tynn\'s own words for a body the form refuses (422), and 404 as signed out', async () => {
        const invalid = ports({ ok: false, status: 422, body: { message: 'The given data was invalid.', errors: { title: ['The title has already been taken.'] } } });
        expect(await runTynnPageAction(invalid.p, 'work', { action: 'feature.create', body: { title: 'Board', description: 'Cards' } })).toMatchObject({ ok: false, reason: 'The title has already been taken.' });
        const hidden = ports({ ok: false, status: 404, body: null });
        expect(await runTynnPageAction(hidden.p, 'work', { action: 'domain.delete', id: 'd1' })).toMatchObject({ ok: false, state: 'signed-out' });
    });

    it('asks Tynn nothing for a row write without its row, a refused form, a model, an unlinked workspace or no pairing (control: the writes above)', async () => {
        const { p, requests } = ports({ ok: true, status: 200, body: {} });
        expect(await runTynnPageAction(p, 'work', { action: 'feature.update', body: { title: 'Board', description: 'Cards' } })).toMatchObject({ ok: false, state: 'error' });
        expect(await runTynnPageAction(p, 'work', { action: 'feature.create', body: { title: '', description: 'Cards' } })).toMatchObject({ ok: false, state: 'error', reason: 'A feature needs a title.' });
        expect(await runTynnPageAction(p, 'work', { action: 'model.update', id: 'm1', body: { name: 'x' } })).toMatchObject({ ok: false, state: 'error' });
        expect(await runTynnPageAction(p, 'other', { action: 'domain.create', body: { name: 'Work' } })).toMatchObject({ ok: false, state: 'not-linked' });
        expect(requests).toEqual([]);
        const out = ports({ ok: true, status: 200, body: {} }, true, false);
        expect(await runTynnPageAction(out.p, 'work', { action: 'domain.create', body: { name: 'Work' } })).toMatchObject({ ok: false, state: 'signed-out' });
        expect(out.requests).toEqual([]);
    });

    it('the Home\'s Details save still answers the Details (control)', async () => {
        const saved = { project_id: 'proj', section: 'details', dashboard: null, details: { can_edit: true, vision: 'v', workflow: {} } };
        const { p, requests } = ports({ ok: true, status: 200, body: saved });
        expect(await runTynnPageAction(p, 'work', { action: 'details.update', body: { vision: 'v' } })).toMatchObject({ ok: true, page: 'home', view: { section: 'details' } });
        expect(requests).toEqual([{ path: '/api/v1/projects/proj/details', method: 'PATCH', body: { vision: 'v' } }]);
    });
});

// P4 family 12 (Tynn #561): following Features is the local door's `tynn.watch`, by subscription (p4-family12-tynn.test.ts).
describe('the window follows Features live through the host, like Issues', () => {
    it('its signals go to the door\'s watch port, never broadcast; the host door is unchanged; no IPC is left', () => {
        expect(IPC_INVENTORY.map(([c]) => c)).not.toContain('genie:workspace-tynn-features-watch');
        const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
        expect(main).toMatch(/engineClient\.onTynnFeaturesEvent\(\(event\) => \{ emitTynn\('features', event\.workspaceId, event\.signal\); \}\);/);
        expect(main).toMatch(/tynnFeaturesDoor = \{ watch: \(viewId, workspaceId\) => engineClient\.tynnFeaturesWatch\(viewId, workspaceId\)/);
        const preload = readFileSync(new URL('../src/main/preload.ts', import.meta.url), 'utf8');
        expect(preload).not.toContain('genie:workspace-tynn-features');
    });
});
