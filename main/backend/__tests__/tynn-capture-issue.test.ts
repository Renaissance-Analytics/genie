import { afterEach, describe, expect, it, vi } from 'vitest';
import { session } from 'electron';
import { TynnBackend } from '../tynn';

// tynn.ts reads `getAllSettings().tynn_host`; stub it so host() resolves to the
// dev default without touching a real settings DB.
vi.mock('../../db', () => ({ getAllSettings: () => ({}) }));

/**
 * Quick capture files an ISSUE.
 *
 * Tynn retired Wishes into one Issue intake (tynn.ai `d7357a4d`, "Retire Wish
 * and Feedback: one Issue intake"). `POST /api/v1/wishes` is GONE from
 * `routes/web.php` — production answers 404 — so every quick capture from the
 * global hotkey has been failing since that deploy. The route that exists is
 * `POST /api/v1/issues` → `MeApiController::storeIssue`.
 *
 * ## Why the path is asserted rather than the outcome
 *
 * A capture that 404s and one that succeeds both return from `fetch`; only the
 * URL distinguishes them before the server is involved. Pinning the path is the
 * only assertion that fails on the actual bug — a test that merely checked "a
 * request was made" passed happily the whole time the feature was dead.
 *
 * ## Non-vacuity
 *
 * The retired path is asserted absent, which alone would pass against a backend
 * that made no request at all. The positive control is the assertion beside it:
 * the live path IS requested, with a body the server's validator accepts.
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

describe('TynnBackend.captureIssue — the quick-capture hotkey files an Issue', () => {
    it('posts to /api/v1/issues, never the retired /api/v1/wishes', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () => json({ id: 'i-1', issue_number: 12, title: 'Ship it' }));

        const result = await new TynnBackend().captureIssue('p-1', 'Ship it');

        const paths = captured.map((r) => new URL(r.url).pathname);
        // Positive control: a request WAS made, to the route that still exists.
        expect(paths).toEqual(['/api/v1/issues']);
        // …which is what makes the absence below mean something.
        expect(paths).not.toContain('/api/v1/wishes');
        expect(captured[0]?.method).toBe('POST');
        expect(result).toEqual({ backend: 'tynn', id: 'i-1' });
    });

    it('sends the body `MeApiController::storeIssue` validates — project_id + title', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () => json({ id: 'i-2', issue_number: 13, title: 'x' }));

        await new TynnBackend().captureIssue('p-42', 'A short one');

        const body = JSON.parse(captured[0]?.body ?? '{}') as Record<string, unknown>;
        expect(body.project_id).toBe('p-42');
        expect(body.title).toBe('A short one');
    });

    it('keeps the whole text: a long capture carries `description` as well as a `title`', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () => json({ id: 'i-3', issue_number: 14, title: 'x' }));

        const long = 'z'.repeat(300);
        await new TynnBackend().captureIssue('p-1', long);

        const body = JSON.parse(captured[0]?.body ?? '{}') as Record<string, unknown>;
        // `title` is capped at 255 server-side; the full text must survive
        // somewhere, so it rides in `description`.
        expect(String(body.title).length).toBeLessThanOrEqual(255);
        expect(body.description).toBe(long);
    });
});

describe('TynnBackend.submitFeedback — a separate channel the rename must not sweep up', () => {
    it('still posts to /api/v1/feedback', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () => json({ id: 'f-1' }));

        await new TynnBackend().submitFeedback('p-1', 'the tray icon is blurry', {
            genie_version: '0.7.0',
        });

        expect(captured.map((r) => new URL(r.url).pathname)).toEqual(['/api/v1/feedback']);
    });
});
