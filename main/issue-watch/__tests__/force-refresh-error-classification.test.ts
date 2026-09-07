import { describe, expect, it } from 'vitest';
import { forceRefreshWorkspace, TynnRefreshHttpError } from '../force-refresh';

/**
 * A refresh failure must explain itself WITHOUT shipping exception text
 * (CodeQL `js/stack-trace-exposure`, alert #11).
 *
 * ## The path CodeQL flagged
 *
 * The alert names `main/mobile/api.ts:755` — `sendJson` — but that is only the
 * sink. The SARIF code flow starts here:
 *
 *   force-refresh.ts  catch (e) → String(e) → { reason:'failed', error: … }
 *   → forceRefreshWorkspace → requestIssueWatchRefresh
 *   → mobile/api.ts  /api/desktop/issue-watch/force-refresh → sendJson → res.end
 *
 * So a Tynn fetch error's `.message` crossed the wire to a paired remote device.
 *
 * ## Why the fix is here rather than at the wire
 *
 * `error` is CONSUMED: `refreshControlState` (`renderer/lib/issue-watch-refresh.ts:46`)
 * renders it as `detail` under the Refresh button. Blanking it at the HTTP
 * boundary would trade a security warning for a vaguer message, and would fix
 * only the one route CodeQL happened to flag — the IPC path and any future route
 * would still carry the raw text, which is how this alert came to exist.
 *
 * Classifying at the source fixes every consumer at once, and loses nothing a
 * human acts on: the two things that can land in that catch are a transport
 * failure and a non-OK Tynn status, and "could not reach Tynn" vs "Tynn answered
 * 503" is the whole of what a reader does anything with. It is also what the file
 * already does everywhere else — the `unavailable` branch's `error` is a fixed
 * sentence, not exception text.
 *
 * ## What these tests assert
 *
 * Not "error is absent" — that would pass against blanking it, which is the
 * silent failure this repository has spent a day removing. The claim is BOTH
 * halves: no exception text, AND a sentence that still says why.
 */
describe('a refresh failure explains itself without leaking exception text', () => {
    const row = {
        id: 'ws-local',
        backend: 'tynn',
        path: '/ws/demo.agi',
        tynn_project_id: 'tynn-project-9',
        tynn_project_name: 'Demo',
    };

    it('a TRANSPORT failure names the cause, not the exception', async () => {
        // What `fetch` really throws when the host cannot be resolved. It carries
        // the internal hostname, which is exactly what must not reach a remote
        // device.
        const raw = 'getaddrinfo ENOTFOUND tynn.internal.example';
        const result = await forceRefreshWorkspace('ws-local', {
            workspaceRow: () => row,
            requestRefresh: async () => {
                throw new Error(raw);
            },
        });

        expect(result.reason).toBe('failed');
        // No exception text, and no fragment of it either.
        expect(result.error ?? '').not.toContain(raw);
        expect(result.error ?? '').not.toContain('ENOTFOUND');
        expect(result.error ?? '').not.toContain('tynn.internal.example');
        // …and still a usable sentence. This half is what stops the fix from
        // being a blanking.
        expect(result.error).toBeTruthy();
        expect(result.error!.length).toBeGreaterThan(15);
        expect(result.error!.toLowerCase()).toContain('reach');
    });

    it('a stack trace in the message never survives', async () => {
        const err = new Error('boom');
        err.stack = 'Error: boom\n    at Object.<anonymous> (C:\\_Projects\\genie\\main\\secret.ts:42:11)';
        const result = await forceRefreshWorkspace('ws-local', {
            workspaceRow: () => row,
            requestRefresh: async () => {
                throw err;
            },
        });

        expect(result.error ?? '').not.toContain('secret.ts');
        expect(result.error ?? '').not.toContain('    at ');
        expect(result.error ?? '').not.toContain('C:\\');
    });

    it('a non-OK STATUS keeps the number and drops the endpoint', async () => {
        // The status is the actionable half — 503 is "not you, wait" and 401 is
        // "sign in again". The URL is the half that only tells an attacker how
        // Genie talks to Tynn.
        const result = await forceRefreshWorkspace('ws-local', {
            workspaceRow: () => row,
            requestRefresh: async () => {
                throw new TynnRefreshHttpError(503);
            },
        });

        expect(result.reason).toBe('failed');
        expect(result.error).toContain('503');
        expect(result.error ?? '').not.toContain('/api/v1/');
        expect(result.error ?? '').not.toContain('POST');
    });

    it('the typed error carries the status as DATA — nothing re-parses a message', () => {
        // The point of the class. The old shape put the status in a string, so
        // reading it back meant that string had to travel — and it carried the
        // endpoint with it.
        const err = new TynnRefreshHttpError(401);
        expect(err.status).toBe(401);
        // Its message is for the desktop's own log, and stays there.
        expect(err.message).toContain('401');
    });

    it('a plain Error that merely MENTIONS a status is not mined for one', async () => {
        // A string that looks like a status must not become one: parsing messages
        // is what made the endpoint travel in the first place. Anything not typed
        // gets the safe generic sentence.
        const result = await forceRefreshWorkspace('ws-local', {
            workspaceRow: () => row,
            requestRefresh: async () => {
                throw new Error('Tynn POST /api/v1/user/issue-watch/refresh -> 503 Service Unavailable');
            },
        });

        expect(result.reason).toBe('failed');
        expect(result.error ?? '').not.toContain('/api/v1/');
        expect(result.error ?? '').not.toContain('Service Unavailable');
        expect(result.error).toBeTruthy();
    });

    it('a non-Error throw is classified too, not stringified', async () => {
        const result = await forceRefreshWorkspace('ws-local', {
            workspaceRow: () => row,
            // eslint-disable-next-line @typescript-eslint/no-throw-literal
            requestRefresh: async () => {
                throw { secret: 'internal-token-abc123' };
            },
        });

        expect(result.error ?? '').not.toContain('internal-token-abc123');
        expect(result.error ?? '').not.toContain('[object Object]');
        expect(result.error).toBeTruthy();
    });

    it('POSITIVE CONTROL: a successful refresh still returns its payload', async () => {
        // Without this, every assertion above is satisfied by a function that
        // fails everything and says the same sentence each time.
        const result = await forceRefreshWorkspace('ws-local', {
            workspaceRow: () => row,
            requestRefresh: async () => ({
                refreshed: true,
                reason: 'refreshed' as const,
                error: null,
                cooldown: { seconds: 300, nextAllowedAt: '2026-08-24T10:05:00+00:00', label: '5m' },
                workspace: {
                    workspaceId: 'tynn-project-9',
                    counts: { issue: 2, pr: 0, security: 0, feedback: 0 },
                    items: [],
                },
            }),
            applyDelta: () => {},
        });

        expect(result.refreshed).toBe(true);
        expect(result.reason).toBe('refreshed');
        expect(result.error).toBeUndefined();
        expect(result.cooldown.seconds).toBe(300);
    });
});
