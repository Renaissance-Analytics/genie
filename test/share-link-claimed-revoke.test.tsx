// @vitest-environment happy-dom
/**
 * A CLAIMED SHARE LINK CAN BE REVOKED FROM GENIE (audit M-c; tynn.ai #394). Tynn's share-links list now carries a link
 * someone has redeemed, marked `claimed`, for as long as its one session can be used. Genie shows it as claimed, with a
 * real Revoke button (react-fancy's Button: the owner's rule for every button). Revoke shows where it stands — working,
 * then done or failed with Retry — and on success this host re-checks its live relay sessions at once, so the guest's
 * session ends now rather than at the next 30-second introspection.
 *
 * Interaction is a claim about a live DOM, so this file renders in happy-dom.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listShareLinks, revokeShareLink, type ShareLink } from '../src/main/tynn-share-links.js';
import { ShareWorkspaceForm } from '../src/renderer/components/ShareWorkspaceModal.js';

type Call = { path: string; method: string };
function tynn(answer: (call: Call) => { status: number; body: unknown }) {
    const calls: Call[] = [];
    const request = async (path: string, init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }) => {
        const call = { path, method: init.method };
        calls.push(call);
        const a = answer(call);
        return { ok: a.status < 300, status: a.status, json: async () => a.body };
    };
    return { calls, request };
}

const ROW = { id: 'inv_1', capability: 'control', workspace_ids: ['w_tynn'], all_workspaces: false, expires_at: '2026-11-08T00:00:00Z', created_at: '2026-11-01T00:00:00Z' };

describe('the list carries whether a link is claimed', () => {
    it('`claimed: true` from Tynn is a claimed link; anything else is not', async () => {
        const t = tynn(() => ({ status: 200, body: { links: [{ ...ROW, claimed: true }, { ...ROW, id: 'inv_2' }, { ...ROW, id: 'inv_3', claimed: 'yes' }] } }));
        const r = await listShareLinks(t.request, 'ws_me', null);
        expect(r.ok && r.links.map((l) => [l.id, l.claimed])).toEqual([['inv_1', true], ['inv_2', false], ['inv_3', false]]);
    });
});

describe('revoking ends the live session now', () => {
    it('after Tynn revokes the link, this host re-checks its live sessions (Tynn now answers inactive for the guest)', async () => {
        const order: string[] = [];
        const t = tynn((c) => { order.push(`${c.method} ${c.path}`); return { status: 200, body: { ok: true } }; });
        const r = await revokeShareLink(t.request, 'ws_me', 'inv_1', async () => { order.push('recheck sessions'); });
        expect(r).toEqual({ ok: true });
        expect(order).toEqual(['DELETE /api/v1/workstations/ws_me/share-links/inv_1', 'recheck sessions']);
    });

    it('CONTROL: Tynn refused the revoke: nothing is re-checked, and it says why', async () => {
        let rechecked = false;
        const t = tynn(() => ({ status: 500, body: { message: 'Tynn is having a moment.' } }));
        const r = await revokeShareLink(t.request, 'ws_me', 'inv_1', async () => { rechecked = true; });
        expect(r).toEqual({ ok: false, reason: 'Tynn is having a moment.' });
        expect(rechecked).toBe(false);
    });

    it('a re-check that throws does not turn a done revoke into a failure', async () => {
        const t = tynn(() => ({ status: 200, body: { ok: true } }));
        expect(await revokeShareLink(t.request, 'ws_me', 'inv_1', async () => { throw new Error('relay down'); })).toEqual({ ok: true });
    });
});

// ---------------------------------------------------------------- the dialog

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const claimed: ShareLink = { id: 'inv_1', url: null, capability: 'control', whole: false, workspaceIds: ['w_tynn'], expiresAt: '2026-11-08T00:00:00Z', claimed: true };
const open: ShareLink = { ...claimed, id: 'inv_2', claimed: false };

function render(onRevoke: (link: ShareLink) => Promise<{ ok: true } | { ok: false; reason: string }>, links: ShareLink[] = [claimed, open]) {
    act(() => {
        root.render(<ShareWorkspaceForm workspaceName="tynn" links={links} minted={null} problem={null} busy={false} onMint={() => {}} onRevoke={onRevoke} onClose={() => {}} />);
    });
}

const row = (id: string) => host.querySelector(`[data-share-link-row="${id}"]`) as HTMLElement;
const revokeButton = (id: string) => row(id).querySelector('[data-action="revoke-share-link"]') as HTMLButtonElement;

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

describe('the Share dialog: a claimed link', () => {
    it('is shown as claimed, apart from a link nobody has opened yet; every Revoke is a react-fancy Button', () => {
        render(async () => ({ ok: true }));
        expect(row('inv_1').hasAttribute('data-share-claimed')).toBe(true);
        expect(row('inv_1').textContent).toMatch(/Claimed/);
        expect(row('inv_2').hasAttribute('data-share-claimed')).toBe(false);
        expect(row('inv_2').textContent).not.toMatch(/Claimed/);
        for (const id of ['inv_1', 'inv_2']) expect(revokeButton(id).hasAttribute('data-react-fancy-button')).toBe(true);
    });

    it('Revoke shows its step and cannot be pressed twice, then says the guest’s session ended', async () => {
        const answer = deferred<{ ok: true }>();
        const asked: string[] = [];
        render((l) => { asked.push(l.id); return answer.promise; });
        act(() => { revokeButton('inv_1').click(); });
        expect(row('inv_1').querySelector('[data-share-revoke-step]')?.textContent).toMatch(/Revoking/);
        expect(revokeButton('inv_1').disabled).toBe(true);
        act(() => { revokeButton('inv_1').click(); });
        expect(asked).toEqual(['inv_1']);
        await act(async () => { answer.resolve({ ok: true }); await answer.promise; });
        expect(host.querySelector('[data-share-revoked]')?.textContent).toMatch(/session.*ended/i);
    });

    it('a link nobody opened yet: done says the link no longer opens', async () => {
        render(async () => ({ ok: true }));
        await act(async () => { revokeButton('inv_2').click(); });
        expect(host.querySelector('[data-share-revoked]')?.textContent).toMatch(/no longer opens/i);
    });

    it('failed: Tynn’s reason and a Retry (a react-fancy Button) that tries again', async () => {
        const answers: Array<{ ok: true } | { ok: false; reason: string }> = [{ ok: false, reason: 'Tynn could not be reached (offline)' }, { ok: true }];
        let calls = 0;
        render(async () => answers[calls++]!);
        await act(async () => { revokeButton('inv_1').click(); });
        const problem = row('inv_1').querySelector('[data-problem="share-revoke"]') as HTMLElement;
        expect(problem.textContent).toContain('Tynn could not be reached (offline)');
        const retry = row('inv_1').querySelector('[data-action="retry-revoke-share-link"]') as HTMLButtonElement;
        expect(retry.hasAttribute('data-react-fancy-button')).toBe(true);
        await act(async () => { retry.click(); });
        expect(calls).toBe(2);
        expect(row('inv_1').querySelector('[data-problem="share-revoke"]')).toBeNull();
        expect(host.querySelector('[data-share-revoked]')).not.toBeNull();
    });
});
