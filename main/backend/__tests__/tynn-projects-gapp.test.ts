import { afterEach, describe, expect, it, vi } from 'vitest';
import { session } from 'electron';
import { TynnBackend } from '../tynn';

// tynn.ts reads `getAllSettings().tynn_host`; stub it so host() resolves to the
// dev default (https://tynn.gen) without touching a real settings DB.
vi.mock('../../db', () => ({ getAllSettings: () => ({}) }));

/**
 * `is_gapp` — "this Tynn project IS a Genie App" (tynn.ai#204, genie#245).
 *
 * ## Why these live here rather than beside the Ops tests
 *
 * `is_ops_project` and `is_gapp` are the SAME KIND of declaration but they do
 * NOT ride the same endpoint, and assuming they did is the whole reason this
 * was half-built. Tynn puts `is_ops_project` on the agent-token mint and on
 * ops-slaves; it puts `is_gapp` on `MeApiController::projectRow()` — the row
 * shared by `GET /api/v1/projects` (list) and `POST /api/v1/projects` (create),
 * which is the ONLY place Genie can learn a project is a GApp. So the mapping
 * belongs to `listProjects` / `createProject`, and these tests pin it there.
 *
 * ## What a GApp project is, and what it is NOT
 *
 * It is the project where a Genie App is DEVELOPED — the developer's own work
 * management. It is NOT a link between an installed GApp and a Tynn project:
 * an installed app never receives a developer's Tynn data, and the store's
 * service side owns that relationship (.ai/plans/gapp-store-and-tynn-linkage.md).
 * Nothing here may grow into such a link.
 *
 * ## Non-vacuity
 *
 * Every list below MIXES a GApp project with a plain one and asserts both, so a
 * mapping hardcoded to `true` (or dropped back to `undefined`) fails. A single
 * `expect(isGapp).toBe(true)` would pass against a constant.
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

describe('TynnBackend.listProjects — is_gapp', () => {
    it('carries a GApp project through as isGapp, and leaves a plain one false', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () =>
            json({
                data: [
                    { id: 'p1', name: 'AI Trader', slug: 'ai-trader', is_gapp: true },
                    { id: 'p2', name: 'The Ripple Effect', slug: 'ripple', is_gapp: false },
                ],
            }),
        );

        const out = await new TynnBackend().listProjects();

        expect(captured[0].url).toBe('https://tynn.gen/api/v1/projects');
        // Both asserted: a constant `true` mapping fails on p2, a dropped
        // mapping fails on p1.
        expect(out.map((p) => [p.id, p.isGapp])).toEqual([
            ['p1', true],
            ['p2', false],
        ]);
    });

    it('maps is_gapp on the bare-array response shape too', async () => {
        // listProjects accepts both `{data:[…]}` and a bare array; a mapping
        // added to only one branch is a bug that shows up on one Tynn version.
        mockFetch([], () =>
            json([
                { id: 'p1', name: 'AI Trader', slug: 'ai-trader', is_gapp: true },
                { id: 'p2', name: 'Ripple', slug: 'ripple' },
            ]),
        );

        const out = await new TynnBackend().listProjects();

        expect(out.map((p) => [p.id, p.isGapp])).toEqual([
            ['p1', true],
            ['p2', false],
        ]);
    });

    it('coerces to a real boolean — absent means false, not undefined', async () => {
        // The `!!` half of the pattern. An older Tynn omits the key entirely;
        // Genie must answer "not a GApp" rather than leaking `undefined` into a
        // UI that renders it.
        mockFetch([], () => json({ data: [{ id: 'p1', name: 'Plain', slug: 'plain' }] }));

        const out = await new TynnBackend().listProjects();

        expect(out[0].isGapp).toBe(false);
        expect(typeof out[0].isGapp).toBe('boolean');
    });
});

describe('TynnBackend.createProject — is_gapp', () => {
    it('maps is_gapp on a freshly created project', async () => {
        // Tynn shares ONE `projectRow()` between list and create precisely so a
        // new project is indistinguishable from a listed one. If Genie maps the
        // flag on only one of them, that guarantee breaks on Genie's side.
        mockFetch([], () =>
            json({
                data: { id: 'p9', name: 'New App', slug: 'new-app', is_gapp: true },
            }),
        );

        const out = await new TynnBackend().createProject({ name: 'New App' });

        expect(out.isGapp).toBe(true);
    });

    it('leaves a plain created project false', async () => {
        mockFetch([], () => json({ data: { id: 'p9', name: 'Plain', slug: 'plain' } }));

        const out = await new TynnBackend().createProject({ name: 'Plain' });

        expect(out.isGapp).toBe(false);
    });
});
