import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type http from 'node:http';
import type { SessionSaveReport } from '../../workspace/session-save';

/**
 * `POST /api/desktop/session-save` — the host endpoint the GCC / Tynn calls
 * BEFORE tearing a session workstation down (Phase 1b of Tynn #229). It runs the
 * host git-save op and hands back its structured report.
 *
 * The property the whole feature rests on: a save that did NOT fully succeed must
 * never look like success. The box is about to be destroyed, so a caller that
 * only checks the HTTP status has to be told "no" — `report.ok === false` is a
 * NON-2xx (409) carrying the full report, and an op that throws is a 500, never
 * a 200 with a hopeful body. Authed + baton-gated exactly like the sibling
 * `/api/desktop/*` mutations; a refusal there is safe (teardown blocks, work
 * survives), so the gate stays.
 *
 * The op itself is unit-tested in main/workspace/__tests__/session-save.test.ts;
 * here it is mocked so these assertions are purely about the route.
 */

const save = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../workspace/session-save', () => ({ runHostSessionSave: save.run }));

import { handleApi, type MobileDataDeps } from '../api';
import { initAuth, attemptPair, _setPinForTest, _resetAuthForTest } from '../auth';
import { _resetAuditForTest, recentAudit } from '../audit';
import { setLocked, _resetBatonForTest } from '../baton';

const ROUTE = '/api/desktop/session-save';

function fakeRes() {
    let status = 0;
    let body = '';
    const res = {
        writeHead(s: number) {
            status = s;
            return res;
        },
        end(d?: string) {
            if (typeof d === 'string') body = d;
        },
    } as unknown as http.ServerResponse;
    return {
        res,
        get status() {
            return status;
        },
        get json() {
            return body ? (JSON.parse(body) as Record<string, unknown>) : null;
        },
    };
}

/** A POST with no body — the endpoint takes no input. */
function req(headers: http.IncomingHttpHeaders = {}, method = 'POST'): http.IncomingMessage {
    return { method, headers, url: ROUTE } as unknown as http.IncomingMessage;
}

async function mintToken(): Promise<string> {
    initAuth({ userDataDir: null, confirmPair: async () => true });
    _setPinForTest('123456');
    const r = await attemptPair('123456', { ip: '100.0.0.1', ua: 'test' });
    if (!r.ok) throw new Error('failed to mint test token');
    return r.token;
}

const bearer = (t: string): http.IncomingHttpHeaders => ({ authorization: `Bearer ${t}` });

const DEPS = {} as MobileDataDeps;

const call = (headers: http.IncomingHttpHeaders = {}, method = 'POST') => {
    const r = fakeRes();
    return handleApi(req(headers, method), r.res, ROUTE, DEPS, {
        ip: '100.0.0.1',
        ua: 'test',
    }).then((handled) => ({ ...r, handled, status: r.status, json: r.json }));
};

const SAVED: SessionSaveReport = {
    timestamp: '2026-07-28T14:32:05.123Z',
    branch: 'genie-session/2026-07-28T14-32-05Z',
    repos: [
        {
            path: '/ws/one.agi',
            workspaceId: 'w1',
            workspaceName: 'one',
            result: 'saved',
            branch: 'genie-session/2026-07-28T14-32-05Z',
            commit: 'abc1234',
            pushed: true,
            workingBranch: 'main',
            dirtyFiles: 3,
            unpushedCommits: 0,
        },
    ],
    ok: true,
    counts: { saved: 1, clean: 0, failed: 0 },
    cannotSave: {
        ignoredPaths: [{ path: '/ws/one.agi', ignored: ['node_modules/'], truncated: false }],
        notes: ['Files excluded by .gitignore are deliberately NOT committed'],
    },
};

const FAILED: SessionSaveReport = {
    ...SAVED,
    repos: [
        { ...SAVED.repos[0], result: 'failed', pushed: false, reason: 'push: permission denied' },
    ],
    ok: false,
    counts: { saved: 0, clean: 0, failed: 1 },
};

beforeEach(() => {
    _resetAuthForTest();
    _resetAuditForTest();
    _resetBatonForTest();
    save.run.mockReset();
    save.run.mockResolvedValue(SAVED);
});
afterEach(() => {
    _resetAuthForTest();
    _resetAuditForTest();
    _resetBatonForTest();
    setLocked(false);
});

describe('POST /api/desktop/session-save', () => {
    it('rejects an unauthenticated request with 401 and never runs the save', async () => {
        const r = await call();
        expect(r.handled).toBe(true);
        expect(r.status).toBe(401);
        // A push to the owner's remotes must never be reachable without a token.
        expect(save.run).not.toHaveBeenCalled();
    });

    it('rejects a GET with 405 (the save is a mutation)', async () => {
        const token = await mintToken();
        const r = await call(bearer(token), 'GET');
        expect(r.status).toBe(405);
        expect(save.run).not.toHaveBeenCalled();
    });

    it('returns 423 when another driver holds the baton, and does not save', async () => {
        const token = await mintToken();
        setLocked(true);
        const r = await call(bearer(token));
        expect(r.status).toBe(423);
        expect(save.run).not.toHaveBeenCalled();
    });

    it('runs the host save and returns the structured report', async () => {
        const token = await mintToken();
        const r = await call(bearer(token));
        expect(save.run).toHaveBeenCalledTimes(1);
        // No arguments: the route uses the op's REAL host wiring (db workspaces,
        // simple-git, owner gh push auth), never a caller-supplied one.
        expect(save.run).toHaveBeenCalledWith();
        expect(r.status).toBe(200);
        expect(r.json).toEqual({ report: SAVED });
    });

    it('surfaces the per-repo detail and the cannot-save warning verbatim', async () => {
        const token = await mintToken();
        const r = await call(bearer(token));
        const report = (r.json as { report: SessionSaveReport }).report;
        expect(report.repos[0]).toMatchObject({ result: 'saved', pushed: true, commit: 'abc1234' });
        expect(report.branch).toBe('genie-session/2026-07-28T14-32-05Z');
        expect(report.cannotSave.ignoredPaths[0].ignored).toEqual(['node_modules/']);
        expect(report.cannotSave.notes.length).toBeGreaterThan(0);
    });

    it('is safe on a host with nothing to save (every repo clean ⇒ ok)', async () => {
        const CLEAN: SessionSaveReport = {
            ...SAVED,
            repos: [
                {
                    path: '/ws/one.agi',
                    workspaceId: 'w1',
                    workspaceName: 'one',
                    result: 'clean',
                    workingBranch: 'main',
                    dirtyFiles: 0,
                    unpushedCommits: 0,
                },
            ],
            ok: true,
            counts: { saved: 0, clean: 1, failed: 0 },
        };
        save.run.mockResolvedValue(CLEAN);
        const token = await mintToken();
        const r = await call(bearer(token));
        expect(r.status).toBe(200);
        expect(r.json).toEqual({ report: CLEAN });
    });

    it('does NOT report success when a repo failed — 409 with the full report', async () => {
        save.run.mockResolvedValue(FAILED);
        const token = await mintToken();
        const r = await call(bearer(token));
        // The caller must be able to block teardown on the status ALONE; a 200
        // here would let a naive `if (res.ok) teardown()` destroy the work.
        expect(r.status).toBe(409);
        expect(r.json).toEqual({ report: FAILED });
        const report = (r.json as { report: SessionSaveReport }).report;
        expect(report.ok).toBe(false);
        expect(report.repos[0].reason).toContain('permission denied');
    });

    it('returns 500 (never a 200) when the save itself throws', async () => {
        save.run.mockRejectedValue(new Error('workspace db unreadable'));
        const token = await mintToken();
        const r = await call(bearer(token));
        expect(r.status).toBe(500);
        expect(r.json).not.toHaveProperty('report');
        expect(r.json).toHaveProperty('error');
    });

    it('audits a compact outcome, not the raw report', async () => {
        const token = await mintToken();
        await call(bearer(token));
        const entry = recentAudit().find((e) => e.action === 'session.save');
        expect(entry).toBeDefined();
        expect(entry?.detail).toContain('saved=1');
        // The trail carries counts — never repo paths, branches or push output
        // (a push error can echo the spawned argv).
        expect(entry?.detail ?? '').not.toContain('/ws/one.agi');
    });
});
