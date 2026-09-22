import { describe, expect, it, vi } from 'vitest';

/**
 * Forcing a workspace's IssueWatch feed to refresh, from Genie.
 *
 * Tynn owns the rate limit — one 5-minute window per WORKSPACE, shared by every
 * agent and the human — so this side deliberately holds NO counter of its own. It
 * resolves which Tynn project the local workspace is, asks, applies whatever
 * snapshot comes back, and passes the cooldown through untouched. A second
 * limiter here would be a second answer to "when may I refresh", and the two
 * would drift the moment a different Genie window (or the flyout) spent the
 * window first.
 *
 * The three outcomes each have to survive the trip intact:
 *   - refreshed: the snapshot is applied and the cooldown says 5 minutes;
 *   - refused: NOT an error — the current snapshot still applies, and the
 *     cooldown says what is actually left;
 *   - unreachable: reported as a failure, never as a refresh that happened.
 */

// The WIRED entry point resolves the workspace from the real db; every other
// test here injects `workspaceRow` and never touches it. Stubbed so the CSRF
// tests below can exercise the real request path without a database.
vi.mock('../../db', () => ({
    getWorkspace: (id: string) => ({ id, path: 'C:/ws', tynn_project_id: 'tynn-project-9' }),
}));

import {
    forceRefreshWorkspace,
    requestIssueWatchRefresh,
    setIssueWatchRefreshTransport,
    TynnRefreshHttpError,
    type TynnRefreshResponse,
} from '../force-refresh';

const LINKED = {
    id: 'ws-local',
    backend: 'tynn',
    path: '/ws/demo.agi',
    tynn_project_id: 'tynn-project-9',
    tynn_project_name: 'Demo',
};

function tynnAnswer(over: Partial<TynnRefreshResponse> = {}): TynnRefreshResponse {
    return {
        refreshed: true,
        reason: 'refreshed',
        error: null,
        cooldown: { seconds: 300, nextAllowedAt: '2026-08-24T10:05:00+00:00', label: '5m' },
        workspace: {
            workspaceId: 'tynn-project-9',
            counts: { issue: 2, pr: 0, security: 0, feedback: 0 },
            items: [],
        },
        ...over,
    };
}

describe('forceRefreshWorkspace', () => {
    it('asks Tynn for the workspace by its TYNN PROJECT id, not the local one', async () => {
        const requestRefresh = vi.fn().mockResolvedValue(tynnAnswer());

        await forceRefreshWorkspace('ws-local', {
            workspaceRow: () => LINKED,
            requestRefresh,
            applyDelta: () => {},
        });

        // Tynn keys IssueWatch by PROJECT; a locally scaffolded envelope mints its
        // own workspace id and records the link in project.json, so sending the
        // local id would ask Tynn to refresh a project that does not exist.
        expect(requestRefresh).toHaveBeenCalledWith('tynn-project-9');
    });

    it('falls back to the workspace id when no explicit link is recorded', async () => {
        const requestRefresh = vi.fn().mockResolvedValue(tynnAnswer());

        await forceRefreshWorkspace('ws-local', {
            // No project.json link and no row link: the Add-workspace flow uses
            // `id := project.id`, so the workspace id IS the project id.
            workspaceRow: () => ({ ...LINKED, tynn_project_id: null, tynn_project_name: null }),
            resolveLink: () => null,
            requestRefresh,
            applyDelta: () => {},
        });

        expect(requestRefresh).toHaveBeenCalledWith('ws-local');
    });

    it('applies the refreshed snapshot and passes the cooldown through', async () => {
        const applyDelta = vi.fn();

        const result = await forceRefreshWorkspace('ws-local', {
            workspaceRow: () => LINKED,
            requestRefresh: async () => tynnAnswer(),
            applyDelta,
        });

        expect(applyDelta).toHaveBeenCalledTimes(1);
        expect(applyDelta.mock.calls[0][0]).toMatchObject({
            workspaceId: 'tynn-project-9',
            counts: { issue: 2 },
        });
        expect(result).toMatchObject({
            refreshed: true,
            reason: 'refreshed',
            cooldown: { seconds: 300, label: '5m' },
        });
    });

    it('treats a REFUSED refresh as a normal answer — snapshot applied, cooldown reported, no throw', async () => {
        const applyDelta = vi.fn();

        const result = await forceRefreshWorkspace('ws-local', {
            workspaceRow: () => LINKED,
            requestRefresh: async () =>
                tynnAnswer({
                    refreshed: false,
                    reason: 'cooldown',
                    cooldown: { seconds: 192, nextAllowedAt: '2026-08-24T10:03:12+00:00', label: '3m 12s' },
                }),
            applyDelta,
        });

        // Another agent (or the human) already spent this workspace's window.
        // Asking was not a mistake, so the caller still gets real state.
        expect(applyDelta).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
            refreshed: false,
            reason: 'cooldown',
            cooldown: { seconds: 192, label: '3m 12s' },
        });
        expect(result.error).toBeUndefined();
    });

    it('reports a failed request as a failure — never as a refresh that happened', async () => {
        const applyDelta = vi.fn();

        const result = await forceRefreshWorkspace('ws-local', {
            workspaceRow: () => LINKED,
            requestRefresh: async () => {
                // The status is DATA now, not a formatted message the result had
                // to re-parse — and the endpoint that message used to carry is
                // what reached a remote device (CodeQL alert #11).
                throw new TynnRefreshHttpError(503);
            },
            applyDelta,
        });

        expect(result.refreshed).toBe(false);
        expect(result.reason).toBe('failed');
        // Unchanged: the status still reaches the caller. Only its route here did.
        expect(result.error).toContain('503');
        // Nothing came back, so nothing may be written over the feed — a
        // fabricated empty snapshot would wipe real issues from the panel.
        expect(applyDelta).not.toHaveBeenCalled();
        // Tynn never charged the window for a request it did not serve, so the
        // caller is free to try again immediately.
        expect(result.cooldown.seconds).toBe(0);
    });

    it('reports an unknown workspace instead of asking Tynn to refresh nothing', async () => {
        const requestRefresh = vi.fn();

        const result = await forceRefreshWorkspace('ws-nope', {
            workspaceRow: () => null,
            requestRefresh,
            applyDelta: () => {},
        });

        expect(requestRefresh).not.toHaveBeenCalled();
        expect(result).toMatchObject({ refreshed: false, reason: 'unavailable' });
        expect(result.cooldown.seconds).toBe(0);
    });

    it('SAYS WHY it refused — an outcome with no reason reads as a button that did nothing', () => {
        // The owner: "the issue watch refresh button doesn't do anything at
        // all." It had in fact run and failed; the only feedback was a rose
        // border and a hover tooltip. This branch made that worse by returning
        // no `error` at all, so the UI fell back to a sentence it had invented.
        //
        // This module's own docblock already claims otherwise — "the
        // `unavailable` branch's `error` is a fixed sentence, not exception
        // text" — so the code and its documentation disagreed, and the test
        // above could not tell, because it only ever asserted the `reason`.
        return forceRefreshWorkspace('ws-nope', {
            workspaceRow: () => null,
            requestRefresh: vi.fn(),
            applyDelta: () => {},
        }).then((result) => {
            expect(result.error, 'an unavailable refresh must say why').toBeTruthy();
            expect(result.error).toMatch(/workspace/i);
        });
    });

    it('POSITIVE CONTROL: a SUCCESSFUL refresh carries no error to explain away', async () => {
        const result = await forceRefreshWorkspace('ws-local', {
            workspaceRow: () => LINKED,
            requestRefresh: async () => tynnAnswer(),
            applyDelta: () => {},
        });
        expect(result.error).toBeUndefined();
    });
});

/**
 * THE POST HAS TO CARRY A CSRF TOKEN, or Laravel never runs the controller.
 *
 * The owner: "the issue watch refresh button doesn't do anything at all."
 *
 * `/api/v1/user/issue-watch/refresh` lives in `routes/web.php` — Tynn's SESSION
 * surface, where the desktop authenticates with a `laravel_session` cookie
 * rather than a bearer token. That group carries Laravel's CSRF middleware, so
 * a POST without `X-XSRF-TOKEN` is rejected at 419 UPSTREAM of the controller.
 * Measured, not assumed: an unauthenticated probe of the live endpoint answers
 * `419`, which is CSRF, not auth.
 *
 * Every other POST Genie makes to that surface goes through
 * `TynnBackend.fetch`, which reads the `XSRF-TOKEN` cookie and sets the header
 * (`main/backend/tynn.ts`) — which is why submitting feedback works and this
 * did not. This one call was built on a second, hand-rolled fetch that sent
 * `content-type` and `accept` and nothing else.
 *
 * The GET reconcile on the same surface is unaffected, because CSRF does not
 * apply to GET — so the feed and the counts kept working while the button
 * silently failed. That asymmetry is exactly what made it look like a dead
 * control rather than a broken request.
 */
describe('the force-refresh POST is accepted by Tynn’s session surface', () => {
    it('sends the CSRF token Laravel requires', async () => {
        const seen: { headers?: Record<string, string> } = {};
        setIssueWatchRefreshTransport({
            fetchImpl: (async (_url: string, init: { headers?: Record<string, string> }) => {
                seen.headers = init?.headers;
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        refreshed: true,
                        reason: 'refreshed',
                        cooldown: { seconds: 0, nextAllowedAt: null, label: 'now' },
                    }),
                };
            }) as unknown as typeof fetch,
            apiBaseUrl: () => 'https://tynn.example',
            csrfToken: async () => 'the-xsrf-token',
        });

        await requestIssueWatchRefresh('ws-local');

        const headers = Object.fromEntries(
            Object.entries(seen.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
        );
        expect(headers['x-xsrf-token']).toBe('the-xsrf-token');
        // Laravel's session surface also keys "is this XHR" off this header,
        // which is what makes it answer JSON instead of a redirect to a login page.
        expect(headers['x-requested-with']).toBe('XMLHttpRequest');
    });

    it('still posts when no token can be read, rather than refusing locally', async () => {
        // POSITIVE CONTROL for the shape: a missing cookie is Tynn's call to
        // make, not a reason for Genie to invent a local failure — and asserting
        // only "the header is present" would pass against a version that refused
        // to send anything at all.
        let called = false;
        setIssueWatchRefreshTransport({
            fetchImpl: (async () => {
                called = true;
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        refreshed: true,
                        reason: 'refreshed',
                        cooldown: { seconds: 0, nextAllowedAt: null, label: 'now' },
                    }),
                };
            }) as unknown as typeof fetch,
            apiBaseUrl: () => 'https://tynn.example',
            csrfToken: async () => null,
        });

        await requestIssueWatchRefresh('ws-local');
        expect(called).toBe(true);
    });
});
