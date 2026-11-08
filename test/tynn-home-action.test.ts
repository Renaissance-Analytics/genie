import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IPC_INVENTORY } from '../src/core/ipc-inventory.js';
import { capabilityOf, WORKSPACE_SCOPED_METHODS } from '../src/core/remote-protocol.js';
import type { TynnBoardPorts } from '../src/main/tynn-board-client.js';
import { runTynnPageAction } from '../src/main/tynn-page-client.js';

/**
 * THE HOME'S DETAILS SAVE (genie#1295 row H1, workspace-ux 0.9.0 action `details.update`): PATCH /details on the
 * WORKSPACE's own project, through the person's pairing, like every other Tynn tab write. Only the web form's fields go;
 * Tynn's 422 is said in Tynn's words; Tynn answers the Details as they now stand, and the tab draws that answer.
 */
const SAVED = {
    project_id: 'proj', section: 'details', dashboard: null,
    details: { can_edit: true, identity: { name: 'Tynn' }, vision: 'Ship it sooner', ai_guidance: '', knowledge: {}, repositories: [], members: [], agents: [], workflow: { claim_tasks: 'required' }, approvals: [], related: {} },
};

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

describe('saving the Home\'s Details', () => {
    it('PATCHes the workspace\'s own project with only the web form\'s fields, and answers the saved Details', async () => {
        const { p, requests } = ports({ ok: true, status: 200, body: SAVED });
        const r = await runTynnPageAction(p, 'work', { action: 'details.update', body: { vision: 'Ship it sooner', claim_tasks: 'required', owner_id: 'someone', project_id: 'other' } });
        expect(r).toMatchObject({ ok: true, page: 'home', view: { section: 'details', details: { vision: 'Ship it sooner', workflow: { claimTasks: 'required' } } } });
        expect(requests).toEqual([{ path: '/api/v1/projects/proj/details', method: 'PATCH', body: { vision: 'Ship it sooner', claim_tasks: 'required' } }]);
    });

    it('says Tynn\'s own words for a body the form refuses (422), and 404 as signed out', async () => {
        const invalid = ports({ ok: false, status: 422, body: { message: 'The given data was invalid.', errors: { slug: ['The slug format is invalid.'] } } });
        expect(await runTynnPageAction(invalid.p, 'work', { action: 'details.update', body: { slug: 'Not A Slug' } })).toMatchObject({ ok: false, reason: 'The slug format is invalid.' });
        const hidden = ports({ ok: false, status: 404, body: null });
        expect(await runTynnPageAction(hidden.p, 'work', { action: 'details.update', body: { vision: 'x' } })).toMatchObject({ ok: false, state: 'signed-out' });
    });

    it('asks Tynn nothing for an unknown action, an empty save, an unlinked workspace or no pairing (control: the save above)', async () => {
        const { p, requests } = ports({ ok: true, status: 200, body: SAVED });
        expect(await runTynnPageAction(p, 'work', { action: 'details.delete', body: { vision: 'x' } })).toMatchObject({ ok: false, state: 'error' });
        expect(await runTynnPageAction(p, 'work', { action: 'details.update', body: { owner_id: 'x' } })).toMatchObject({ ok: false, state: 'error', reason: 'Nothing to save.' });
        expect(await runTynnPageAction(p, 'other', { action: 'details.update', body: { vision: 'x' } })).toMatchObject({ ok: false, state: 'not-linked' });
        expect(requests).toEqual([]);
        const out = ports({ ok: true, status: 200, body: SAVED }, true, false);
        expect(await runTynnPageAction(out.p, 'work', { action: 'details.update', body: { vision: 'x' } })).toMatchObject({ ok: false, state: 'signed-out' });
        expect(out.requests).toEqual([]);
    });

    it('a 200 that is not the Details is an error, never drawn', async () => {
        const { p } = ports({ ok: true, status: 200, body: { releases: [] } });
        expect(await runTynnPageAction(p, 'work', { action: 'details.update', body: { vision: 'x' } })).toMatchObject({ ok: false, state: 'error' });
    });
});

describe('the window carries the Details save, owner-only, like the Issues writes', () => {
    it('is a protocol write scoped to the workspace, with its IPC row', () => {
        expect(capabilityOf('workspaces.tynnPageAction')).toBe('write');
        expect(WORKSPACE_SCOPED_METHODS).toContain('workspaces.tynnPageAction');
        expect(IPC_INVENTORY).toContainEqual(['genie:workspace-tynn-page-action', 'protocol:workspaces.tynnPageAction']);
    });

    it('main runs it through the person\'s pairing on both the native IPC and the HostApi; preload exposes it', () => {
        const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
        expect(main).toMatch(/ipcMain\.handle\('genie:workspace-tynn-page-action'[\s\S]{0,400}runTynnPageAction\(tynnBoardPorts\(\)/);
        expect(main).toMatch(/tynnPageAction: \(id, input\) => [^\n]*runTynnPageAction\(tynnBoardPorts\(\)/);
        const preload = readFileSync(new URL('../src/main/preload.ts', import.meta.url), 'utf8');
        expect(preload).toContain("ipcRenderer.invoke('genie:workspace-tynn-page-action'");
    });
});
