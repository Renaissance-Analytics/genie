import { beforeAll, describe, expect, it } from 'vitest';
import {
    PROBE_METHOD,
    TYNN_ENDPOINTS,
    TYNN_PRODUCTION,
    probePath,
    type TynnEndpoint,
} from '../tynn-contract';

/**
 * The LIVE half of Genie's Tynn contract check — it asks the real Tynn whether
 * every route Genie calls still resolves.
 *
 * This is the test genie#411 asked for. Tynn retired `POST /api/v1/wishes`; the
 * desktop kept posting there and 404'd on every quick capture for a day, with
 * both repositories' suites green the whole time. Tynn's tests know nothing
 * about a desktop client, and Genie's knew nothing about which Tynn routes
 * exist, so the failure lived exactly in the gap between them. It lives here
 * now.
 *
 * ## It does NOT run on `npm test`
 *
 * The unit suite must work on a plane. This file matches `*.live.test.ts`,
 * which `vitest.config.ts` excludes for the same reason it excludes
 * `*.real.test.ts`; it runs under `npm run test:contract`, which CI schedules
 * daily and runs on any PR that touches a Tynn client. The offline half
 * (`tynn-contract.test.ts`) asserts that wiring still exists, because a check
 * nothing invokes is a check that has quietly stopped happening.
 *
 * ## It does NOT pass when it cannot check
 *
 * Nothing here is skipped, softened or caught on a network failure. DNS
 * failure, timeout, TLS error, 502 from the edge — all of it FAILS, loudly,
 * naming what could not be reached. A contract test that goes green when it
 * could not reach the thing it is under contract with is the precise defect it
 * exists to prevent, and it would be worse than having no test at all: it would
 * report the integration healthy on the day it broke.
 *
 * ## Why OPTIONS
 *
 * Sending each endpoint's real method would put unauthorized writes on
 * production every time this ran. Laravel answers OPTIONS from inside the
 * router, before a single piece of route middleware — so the probe never
 * authenticates, never meets CSRF, never binds a model, never reaches a
 * controller, and cannot write. It answers 200 with an `Allow` header for a
 * path that has any route, and 404 for a path that has none, which is exactly
 * the question this file asks. See `PROBE_METHOD` in `../tynn-contract`.
 */

const BASE = (process.env.TYNN_CONTRACT_BASE ?? TYNN_PRODUCTION).replace(/\/+$/, '');

/** No route can exist here. The probe must say so — see the control below. */
const IMPOSSIBLE_PATH = '/api/v1/__genie_contract_probe_no_such_route__';

interface Probe {
    status: number;
    /** Methods Tynn says the path accepts, from the `Allow` header. */
    allow: string[];
}

/**
 * One probe. Network failure is NOT caught: it propagates and fails the suite
 * with the underlying cause attached, which is the whole point of this file.
 */
async function probe(path: string): Promise<Probe> {
    const url = `${BASE}${path}`;
    let res: Response;
    try {
        res = await fetch(url, {
            method: PROBE_METHOD,
            headers: { accept: 'application/json' },
            redirect: 'manual',
            signal: AbortSignal.timeout(20_000),
        });
    } catch (cause) {
        // Rethrown, never swallowed. "Could not reach Tynn" is a failing
        // contract check, not an absent one.
        throw new Error(
            `${PROBE_METHOD} ${url} could not be reached — the Tynn contract is UNVERIFIED, not intact.`,
            { cause },
        );
    }
    return {
        status: res.status,
        allow: (res.headers.get('allow') ?? '')
            .split(',')
            .map((m) => m.trim().toUpperCase())
            .filter(Boolean),
    };
}

const label = (e: TynnEndpoint): string => `${e.method} ${e.path}`;

describe(`Tynn contract — every endpoint Genie calls, against ${BASE}`, () => {
    const results = new Map<string, Probe>();

    beforeAll(async () => {
        const paths = [IMPOSSIBLE_PATH, ...TYNN_ENDPOINTS.map(probePath)];
        const probes = await Promise.all(paths.map(async (p) => [p, await probe(p)] as const));
        for (const [p, r] of probes) results.set(p, r);
    }, 120_000);

    // ── Controls, first: the probe has to be able to fail ────────────────────
    // Every assertion below reads a 200 as "the route is there". That means
    // nothing until we have seen this probe return something OTHER than 200 for
    // a route that is not there — otherwise an edge that answers 200 to
    // everything (a captive portal, a misrouted CDN, a maintenance page) would
    // certify the whole contract while checking none of it.

    it('reports 404 for a path that cannot exist — the probe can tell absence from presence', () => {
        expect(results.get(IMPOSSIBLE_PATH)?.status).toBe(404);
    });

    it('probed every declared endpoint', () => {
        const missing = TYNN_ENDPOINTS.filter((e) => !results.has(probePath(e))).map(label);
        expect(missing).toEqual([]);
        // Distinct PATHS, not endpoints: one path can carry two methods
        // (`/api/v1/projects` is both a list and a create) and OPTIONS answers
        // for the path, so those two endpoints share a single probe.
        const paths = new Set([IMPOSSIBLE_PATH, ...TYNN_ENDPOINTS.map(probePath)]);
        expect(results.size).toBe(paths.size);
    });

    // ── The contract itself ──────────────────────────────────────────────────

    it.each(TYNN_ENDPOINTS.map((e) => [label(e), e] as const))(
        '%s still resolves, and still accepts that method',
        (_name, endpoint) => {
            const result = results.get(probePath(endpoint));
            expect(result, 'no probe result — see the coverage assertion above').toBeDefined();

            // 404 here is a RETIRED ROUTE. Whatever `breaks` says is what is
            // broken for a user right now.
            expect(
                result?.status,
                `${label(endpoint)} does not resolve on ${BASE}. ${endpoint.breaks} Called from ${endpoint.caller}.`,
            ).toBe(200);

            // A route that survived but changed method is just as dead to the
            // caller, and answers 405 rather than 404 — invisible to a check
            // that only asked whether the path exists.
            expect(
                result?.allow,
                `${label(endpoint)} exists but no longer accepts ${endpoint.method}. ${endpoint.breaks}`,
            ).toContain(endpoint.method);
        },
    );
});
