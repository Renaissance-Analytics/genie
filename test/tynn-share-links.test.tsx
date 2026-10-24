import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { workstationOpenFrom } from '../src/core/tynn-sign-in.js';
import { listShareLinks, mintShareLink, revokeShareLink, NOT_REGISTERED } from '../src/main/tynn-share-links.js';
import { ShareWorkspaceForm } from '../src/renderer/components/ShareWorkspaceModal.js';

/**
 * SHARING THROUGH TYNN (Tynn #839; Genie 1's workspace-share-links.ts + ShareWorkspaceModal, v1 inventory rows 111-116).
 * The owner makes a link in Tynn for ONE workspace or the whole workstation, control or read-only, for 1-30 days;
 * whoever opens it lands on Tynn's page, which opens Genie on `genie://workstation/open?id=…` — a window over the Tynn
 * relay. The link's URL is served once, in the answer to its making; the list never carries it. A link can be revoked.
 */

type Call = { path: string; method: string; body?: unknown };
function tynn(answer: (call: Call) => { status: number; body: unknown }) {
    const calls: Call[] = [];
    const request = async (path: string, init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }) => {
        const call = { path, method: init.method, ...(init.body !== undefined ? { body: init.body } : {}) };
        calls.push(call);
        const a = answer(call);
        return { ok: a.status < 300, status: a.status, json: async () => a.body };
    };
    return { calls, request };
}

const LINK = { id: 'inv_1', url: 'https://tynn.example.com/i/abc', token: 'abc', capability: 'control', workspace_ids: ['w_tynn'], all_workspaces: false, expires_at: '2026-10-26T00:00:00Z', created_at: '2026-10-19T00:00:00Z' };

describe('mintShareLink', () => {
    it('one workspace: POST /workstations/{this machine}/share-links {workspace, capability, expires_in_days}', async () => {
        const t = tynn(() => ({ status: 201, body: { link: LINK } }));
        const r = await mintShareLink(t.request, 'ws_me', { workspaceId: 'w_tynn', capability: 'control', expiresInDays: 14 });
        expect(t.calls).toEqual([{ path: '/api/v1/workstations/ws_me/share-links', method: 'POST', body: { workspace: 'w_tynn', capability: 'control', expires_in_days: 14 } }]);
        expect(r).toEqual({ ok: true, link: { id: 'inv_1', url: 'https://tynn.example.com/i/abc', capability: 'control', whole: false, workspaceIds: ['w_tynn'], expiresAt: '2026-10-26T00:00:00Z' } });
    });

    it('the whole workstation: all_workspaces, never with a list', async () => {
        const t = tynn(() => ({ status: 201, body: { link: { ...LINK, workspace_ids: [], all_workspaces: true } } }));
        await mintShareLink(t.request, 'ws_me', { workspaceId: null, capability: 'readonly', expiresInDays: 7 });
        expect(t.calls[0]!.body).toEqual({ all_workspaces: true, capability: 'readonly', expires_in_days: 7 });
    });

    it('an expiry outside 1-30 days is the default week', async () => {
        const t = tynn(() => ({ status: 201, body: { link: LINK } }));
        await mintShareLink(t.request, 'ws_me', { workspaceId: 'w_tynn', capability: 'control', expiresInDays: 90 });
        expect((t.calls[0]!.body as { expires_in_days: number }).expires_in_days).toBe(7);
    });

    it('this machine not registered with Tynn: nothing is asked, and it says why', async () => {
        const t = tynn(() => ({ status: 201, body: { link: LINK } }));
        expect(await mintShareLink(t.request, null, { workspaceId: 'w_tynn', capability: 'control', expiresInDays: 7 })).toEqual({ ok: false, reason: NOT_REGISTERED });
        expect(t.calls).toEqual([]);
    });

    it('refused: Tynn’s words', async () => {
        const t = tynn(() => ({ status: 422, body: { message: 'This workstation does not host that workspace.' } }));
        expect(await mintShareLink(t.request, 'ws_me', { workspaceId: 'w_x', capability: 'control', expiresInDays: 7 })).toEqual({ ok: false, reason: 'This workstation does not host that workspace.' });
    });
});

describe('listShareLinks / revokeShareLink', () => {
    it('the links that reach this workspace (its own and whole-workstation ones); never a URL', async () => {
        const t = tynn(() => ({ status: 200, body: { links: [
            { ...LINK, url: undefined, token: undefined },
            { ...LINK, id: 'inv_2', workspace_ids: ['w_other'], url: undefined },
            { ...LINK, id: 'inv_3', workspace_ids: [], all_workspaces: true, url: undefined },
        ] } }));
        const r = await listShareLinks(t.request, 'ws_me', 'w_tynn');
        expect(t.calls).toEqual([{ path: '/api/v1/workstations/ws_me/share-links', method: 'GET' }]);
        expect(r.ok && r.links.map((l) => l.id)).toEqual(['inv_1', 'inv_3']);
        expect(r.ok && r.links.every((l) => l.url === null)).toBe(true);
    });

    it('revoke: DELETE /workstations/{this machine}/share-links/{id}', async () => {
        const t = tynn(() => ({ status: 200, body: { ok: true } }));
        expect(await revokeShareLink(t.request, 'ws_me', 'inv_1')).toEqual({ ok: true });
        expect(t.calls).toEqual([{ path: '/api/v1/workstations/ws_me/share-links/inv_1', method: 'DELETE' }]);
    });
});

describe('the link, opened: genie://workstation/open', () => {
    it('names the workstation (and the workspace and its name when Tynn adds them)', () => {
        expect(workstationOpenFrom('genie://workstation/open?id=ws_01abc&workspace=w_tynn&name=Studio')).toEqual({ id: 'ws_01abc', workspace: 'w_tynn', name: 'Studio' });
        expect(workstationOpenFrom('genie://workstation/open?id=ws_01abc')).toEqual({ id: 'ws_01abc', workspace: null, name: null });
    });

    it('anything else is not one (CONTROL: the sign-in callback is not mistaken for it)', () => {
        expect(workstationOpenFrom('genie://oauth/callback?token=abc')).toBeNull();
        expect(workstationOpenFrom('genie://workstation/open?id=../x')).toBeNull();
        expect(workstationOpenFrom('genie://workstation/open')).toBeNull();
    });
});

describe('the Share dialog (its form; Fancy’s Modal portals, so it is not rendered here)', () => {
    const base = { workspaceName: 'tynn', links: [], minted: null, problem: null, busy: false, onMint: () => {}, onRevoke: () => {}, onClose: () => {} };

    it('offers control / read-only, an expiry, and this workspace or the whole workstation', () => {
        const html = renderToStaticMarkup(<ShareWorkspaceForm {...base} />);
        expect(html).toContain('data-share-capability');
        expect(html).toContain('data-share-expiry');
        expect(html).toContain('data-share-reach');
        expect(html).toContain('data-action="mint-share-link"');
    });

    it('a link just made: its URL, once, with Copy', () => {
        const html = renderToStaticMarkup(<ShareWorkspaceForm {...base} minted={{ id: 'inv_1', url: 'https://tynn.example.com/i/abc', capability: 'control', whole: false, workspaceIds: ['w_tynn'], expiresAt: null }} />);
        expect(html).toContain('https://tynn.example.com/i/abc');
        expect(html).toContain('data-action="copy-share-link"');
    });

    it('the links that reach it, each revocable; a problem in words', () => {
        const html = renderToStaticMarkup(<ShareWorkspaceForm {...base} problem="This workstation does not host that workspace." links={[{ id: 'inv_3', url: null, capability: 'readonly', whole: true, workspaceIds: [], expiresAt: '2026-10-26T00:00:00Z' }]} />);
        expect(html).toMatch(/data-share-link-row="inv_3"[^]*?data-action="revoke-share-link"/);
        expect(html).toContain('This workstation does not host that workspace.');
    });
});
