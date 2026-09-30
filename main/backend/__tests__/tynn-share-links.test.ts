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

        const out = await new TynnBackend().mintWorkspaceShareLink('wst1', 'ws-design', 'readonly');

        const post = captured.find((c) => c.method === 'POST');
        expect(post?.url).toBe('https://tynn.gen/workstations/wst1/share-links');
        expect(JSON.parse(post?.body ?? '{}')).toEqual({
            workspace: 'ws-design',
            capability: 'readonly',
        });
        expect(out.url).toBe('https://tynn.gen/invites/accept/tok-abc');
        expect(out.id).toBe('inv1');
    });

    it('never sends a scopes array — a link that can say host:all eventually will', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, (req) =>
            req.url.includes('/share-links') ? json({ link: { id: 'i', url: 'u' } }) : json({}),
        );

        await new TynnBackend().mintWorkspaceShareLink('wst1', 'ws-design', 'control');

        const body = JSON.parse(captured.find((c) => c.method === 'POST')?.body ?? '{}');
        expect(body).not.toHaveProperty('scopes');
        expect(body.capability).toBe('control');
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
