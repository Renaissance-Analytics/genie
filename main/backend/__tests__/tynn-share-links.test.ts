import { afterEach, describe, expect, it, vi } from 'vitest';
import { session } from 'electron';
import { TynnBackend } from '../tynn';

vi.mock('../../db', () => ({ getAllSettings: () => ({}) }));

/**
 * WORKSPACE SHARE LINKS — the Tynn calls behind "share this one workspace by
 * link". Three of them: mint, list, revoke, on the session-cookie seam the rest
 * of the backend uses.
 *
 * These lock in the request shapes because the service enforces things the
 * client must not fight: minting takes ONE workspace by name (never a scopes
 * array, so a link can never express `host:all`), and the list deliberately does
 * NOT carry tokens — the URL is the credential, and a link is shown exactly once,
 * when it is created.
 */
interface CapturedRequest {
    url: string;
    method?: string;
    body?: string;
}

function mockFetch(captured: CapturedRequest[], reply: (req: CapturedRequest) => Response) {
    const impl = async (
        input: string | Request,
        init?: { method?: string; body?: BodyInit | null },
    ): Promise<Response> => {
        const req: CapturedRequest = {
            url: String(input),
            method: init?.method,
            body: typeof init?.body === 'string' ? init.body : undefined,
        };
        captured.push(req);
        return reply(req);
    };
    return vi
        .spyOn(session.defaultSession, 'fetch')
        .mockImplementation(impl as typeof session.defaultSession.fetch);
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

afterEach(() => vi.restoreAllMocks());

describe('TynnBackend.mintWorkspaceShareLink', () => {
    it('POSTs ONE workspace by name and returns the url + token', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, (req) =>
            // The CSRF preflight rides the same seam; answer it with a cookie read.
            req.url.includes('/share-links')
                ? json({
                      link: {
                          id: 'inv1',
                          token: 'tok-abc',
                          url: 'https://tynn.gen/invites/accept/tok-abc',
                          capability: 'readonly',
                          workspace_ids: ['ws-design'],
                          all_workspaces: false,
                          expires_at: '2026-10-07T00:00:00+00:00',
                      },
                  })
                : json({}),
        );

        const out = await new TynnBackend().mintWorkspaceShareLink('wst1', 'ws-design', 'readonly', 14);

        const post = captured.find((c) => c.method === 'POST');
        expect(post?.url).toBe('https://tynn.gen/workstations/wst1/share-links');
        // The expiry the user picked, sent explicitly. Tynn has always accepted
        // `expires_in_days` and defaulted it to 7; omitting it meant every link
        // expired in a week whatever the picker said.
        expect(JSON.parse(post?.body ?? '{}')).toEqual({
            workspace: 'ws-design',
            capability: 'readonly',
            expires_in_days: 14,
        });
        expect(out.url).toBe('https://tynn.gen/invites/accept/tok-abc');
        expect(out.id).toBe('inv1');
    });

    it('never sends a scopes array — a link that can say host:all eventually will', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, (req) =>
            req.url.includes('/share-links') ? json({ link: { id: 'i', url: 'u' } }) : json({}),
        );

        await new TynnBackend().mintWorkspaceShareLink('wst1', 'ws-design', 'control', 7);

        const body = JSON.parse(captured.find((c) => c.method === 'POST')?.body ?? '{}');
        expect(body).not.toHaveProperty('scopes');
        expect(body.capability).toBe('control');
    });
});

/**
 * WORKSTATION share links — the other half the owner asked for: *"I can either
 * share a workspace individually … or I can share my entire workstation."*
 *
 * Same endpoint, and deliberately still no `scopes` array. Tynn builds the
 * scopes from named fields, so the client states what it wants rather than
 * composing an entitlement — the whole reason a one-workspace link could never
 * quietly become a whole-machine one.
 */
describe('TynnBackend.mintWorkstationShareLink', () => {
    it('names the workspaces a workstation link reaches', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, (req) =>
            req.url.includes('/share-links')
                ? json({ link: { id: 'inv2', url: 'u', token: 't' } }, 201)
                : json({}),
        );

        await new TynnBackend().mintWorkstationShareLink(
            'wst1',
            { workspaces: ['design', 'payroll'], capability: 'control', expiresInDays: 14 },
        );

        const body = JSON.parse(captured.find((c) => c.method === 'POST')?.body ?? '{}');
        expect(body).toEqual({
            workspaces: ['design', 'payroll'],
            capability: 'control',
            expires_in_days: 14,
        });
        // Never both. `all_workspaces` present and false would still be a second
        // way of saying the same thing, and the service takes the flag first.
        expect(body).not.toHaveProperty('all_workspaces');
        expect(body).not.toHaveProperty('workspace');
    });

    it('asks for the whole machine in the field that means it', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, (req) =>
            req.url.includes('/share-links') ? json({ link: { id: 'i', url: 'u' } }, 201) : json({}),
        );

        await new TynnBackend().mintWorkstationShareLink('wst1', {
            allWorkspaces: true,
            capability: 'readonly',
            expiresInDays: 7,
        });

        const body = JSON.parse(captured.find((c) => c.method === 'POST')?.body ?? '{}');
        expect(body.all_workspaces).toBe(true);
        // The list is omitted entirely rather than sent empty: `workspaces: []` is
        // a 422 at the service, so sending it alongside the flag would turn the
        // widest link into a refusal.
        expect(body).not.toHaveProperty('workspaces');
    });

    it('still sends no scopes array', async () => {
        // The property the single-workspace form has always had, restated for the
        // wider link — it is the wider one that would do the damage.
        const captured: CapturedRequest[] = [];
        mockFetch(captured, (req) =>
            req.url.includes('/share-links') ? json({ link: { id: 'i', url: 'u' } }, 201) : json({}),
        );

        await new TynnBackend().mintWorkstationShareLink('wst1', {
            allWorkspaces: true,
            capability: 'control',
            expiresInDays: 7,
        });

        expect(
            JSON.parse(captured.find((c) => c.method === 'POST')?.body ?? '{}'),
        ).not.toHaveProperty('scopes');
    });
});

describe('TynnBackend.listWorkspaceShareLinks', () => {
    it('GETs the machine list and narrows it to ONE workspace', async () => {
        // The service returns every live link on the machine; the workspace
        // settings panel is about one workspace, and showing another workspace's
        // links there would invite revoking the wrong one.
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () =>
            json({
                links: [
                    { id: 'a', workspace_ids: ['ws-design'], all_workspaces: false },
                    { id: 'b', workspace_ids: ['ws-payroll'], all_workspaces: false },
                    { id: 'c', workspace_ids: ['ws-design'], all_workspaces: false },
                ],
            }),
        );

        const out = await new TynnBackend().listWorkspaceShareLinks('wst1', 'ws-design');

        expect(captured[0]?.url).toBe('https://tynn.gen/workstations/wst1/share-links');
        expect(out.map((l) => l.id)).toEqual(['a', 'c']);
    });

    it('returns an empty list rather than throwing when Tynn is unreachable', async () => {
        // The panel renders inside workspace settings. A dead Tynn must not take
        // the whole settings modal down with it.
        mockFetch([], () => json({ message: 'nope' }, 500));

        await expect(new TynnBackend().listWorkspaceShareLinks('wst1', 'ws-design')).resolves.toEqual(
            [],
        );
    });
});

describe('TynnBackend.revokeWorkspaceShareLink', () => {
    it('DELETEs the one link', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, (req) =>
            req.method === 'DELETE' ? json({ ok: true }) : json({}),
        );

        await new TynnBackend().revokeWorkspaceShareLink('wst1', 'inv1');

        const del = captured.find((c) => c.method === 'DELETE');
        expect(del?.url).toBe('https://tynn.gen/workstations/wst1/share-links/inv1');
    });
});
