import { describe, expect, it } from 'vitest';
import {
    applyIssueChanges,
    closeBody,
    convertBody,
    issueActionRequest,
    issueChangesPath,
    issueChannel,
    issueCreateBody,
    issueEditBody,
    issueRingIds,
    issuesQueryPath,
    ISSUES_LIVE,
    normalizeIssueFilters,
    parseIssueChanges,
    parseIssueQueue,
    triageOf,
    type IssueQueueView,
} from '../src/core/tynn-issues.js';
import { readTynnIssueChanges, readTynnIssues, runTynnIssueAction } from '../src/main/tynn-issues-client.js';
import type { TynnBoardPorts } from '../src/main/tynn-board-client.js';
import { TynnBoardLive, type BoardLiveRing, type TynnBoardLivePorts } from '../src/main/tynn-board-live.js';
import { TYNN_ISSUES_FEED } from '../src/main/tynn-issues-live.js';
import type { LiveState } from '../src/core/tynn-board.js';
import type { SocketLike } from '../src/main/issue-watch-client.js';

/**
 * THE TYNN TAB'S ISSUES (genie#1295 row I1, workspace-ux 0.7.0 surface `issues`).
 *
 * tynn.ai's Issues page, natively: the project's one intake queue, filtered by status (Open first), by source and by a
 * search; file, edit, delete, convert into a story, resolve or discard with a reason — through Tynn's issue-queue door
 * (`/api/v1/projects/{id}/issues…`, pairing scope `genie:issue-queue`) as the person. Every refusal Tynn makes is its 404,
 * which the tab reads as "sign in to Tynn again" (an older pairing has no issue-queue scope); an illegal step is a 422 in
 * Tynn's own words. Live on the queue's own channel: a ring is a doorbell, the tab asks what changed since its cursor.
 */
const issue = (over: Record<string, unknown> = {}) => ({
    id: 'i1', issue_number: 7, title: 'Dark mode', description: 'Please', status: 'open', type: 'enhancement', priority: 'normal',
    source: 'issue', context_url: null, from: 'Ada', version_number: null, feature_ids: [], solutions: [], converted_story_id: null,
    converted_story_number: null, github: null, created_at: '2026-10-31T10:00:00+00:00', ...over,
});
const QUEUE = {
    project_id: 'p1', cursor: '2026-10-31T12:00:00Z',
    issues: [issue(), issue({ id: 'i2', issue_number: 6, title: 'Slow export', source: 'feedback', created_at: '2026-10-30T10:00:00+00:00', github: { repo: 'acme/app', number: 42, url: 'https://github.com/acme/app/issues/42', state: 'open' } })],
    filters: { status: 'open', source: null, q: '' },
    statuses: ['open', 'converted', 'discarded', 'resolved'],
    features: [{ id: 'f1', title: 'Theming', slug: 'theming' }],
    convertible_versions: [{ id: 'v1', number: '0.4', title: 'Now', status: 'active' }],
    can_triage: true,
};
const view = () => parseIssueQueue(QUEUE)!;

describe('the queue, as the tab reads it', () => {
    it('reads Tynn\'s answer: the issues, the filters it applied, features, versions to convert onto, and the cursor', () => {
        const v = view();
        expect(v.issues.map((i) => i.id)).toEqual(['i1', 'i2']);
        expect(v.issues[0]).toMatchObject({ number: '#7', title: 'Dark mode', status: 'open', type: 'enhancement', from: 'Ada', github: null });
        expect(v.issues[1]!.github).toEqual({ repo: 'acme/app', number: 42, url: 'https://github.com/acme/app/issues/42', state: 'open' });
        expect(v.filters).toEqual({ status: 'open', source: null, q: '' });
        expect(v.versions).toEqual([{ id: 'v1', number: '0.4', title: 'Now', status: 'active' }]);
        expect(v.features).toEqual([{ id: 'f1', title: 'Theming' }]);
        expect(v.canTriage).toBe(true);
        expect(v.cursor).toBe('2026-10-31T12:00:00Z');
    });

    it('is null for something that is not a queue — never an empty one', () => {
        expect(parseIssueQueue({ level: 'versions' })).toBeNull();
        expect(parseIssueQueue(null)).toBeNull();
        // A row without an id or a status is dropped, not drawn half.
        expect(parseIssueQueue({ ...QUEUE, issues: [{ title: 'x' }, issue()] })!.issues).toHaveLength(1);
    });

    it('offers triage only on an open issue, and only to a person who may triage', () => {
        const v = view();
        expect(triageOf(v, v.issues[0]!)).toBe(true);
        expect(triageOf({ ...v, canTriage: false }, v.issues[0]!)).toBe(false);
        expect(triageOf(v, { ...v.issues[0]!, status: 'resolved' })).toBe(false);
    });

    it('asks with the page\'s filters, leaving out the defaults; an unknown status or source is the default', () => {
        expect(issuesQueryPath('p 1', normalizeIssueFilters({}))).toBe('/api/v1/projects/p%201/issues');
        expect(issuesQueryPath('p1', normalizeIssueFilters({ status: 'all', source: 'feedback', q: ' dark ' }))).toBe('/api/v1/projects/p1/issues?status=all&source=feedback&q=dark');
        expect(normalizeIssueFilters({ status: 'bogus', source: 'nowhere', q: 3 })).toEqual({ status: 'open', source: null, q: '' });
    });
});

describe('each action, where the contract says', () => {
    it('reaches the door with the method and path the contract names', () => {
        expect(issueActionRequest('p1', 'issue.create', null)).toEqual({ method: 'POST', path: '/api/v1/projects/p1/issues' });
        expect(issueActionRequest('p1', 'issue.update', 'i 1')).toEqual({ method: 'PATCH', path: '/api/v1/projects/p1/issues/i%201' });
        expect(issueActionRequest('p1', 'issue.delete', 'i1')).toEqual({ method: 'DELETE', path: '/api/v1/projects/p1/issues/i1' });
        expect(issueActionRequest('p1', 'issue.convert', 'i1')).toEqual({ method: 'POST', path: '/api/v1/projects/p1/issues/i1/convert' });
        expect(issueActionRequest('p1', 'issue.resolve', 'i1')).toEqual({ method: 'POST', path: '/api/v1/projects/p1/issues/i1/close' });
        expect(issueActionRequest('p1', 'issue.discard', 'i1')).toEqual({ method: 'POST', path: '/api/v1/projects/p1/issues/i1/close' });
        // An action on an issue needs the issue; an action the tab does not have is not sent.
        expect(issueActionRequest('p1', 'issue.update', null)).toBeNull();
        expect(issueActionRequest('p1', 'issue.teleport', 'i1')).toBeNull();
    });

    it('files what the web form files: a title, and only the fields it has', () => {
        expect(issueCreateBody({ title: '  Keys ', description: 'j/k', type: 'fix', priority: 'high', feature_ids: ['f1', 3] })).toEqual({ title: 'Keys', description: 'j/k', type: 'fix', priority: 'high', feature_ids: ['f1'] });
        expect(issueCreateBody({ title: ' ' })).toBeNull();
        expect(issueCreateBody({ title: 'x', type: 'whatever', priority: 'soon' })).toEqual({ title: 'x' });
    });

    it('saves only what changed in an edit, and never an empty title', () => {
        const before = view().issues[0]!;
        expect(issueEditBody(before, { title: 'Dark mode', description: 'Please', priority: 'critical' })).toEqual({ priority: 'critical' });
        expect(issueEditBody(before, { title: 'Dark mode' })).toBeNull();
        expect(issueEditBody(before, { title: '' })).toBeNull();
    });

    it('converts onto a version, and closes with a verdict and a reason — never without one', () => {
        expect(convertBody({ version_id: 'v1' })).toEqual({ version_id: 'v1' });
        expect(convertBody({})).toBeNull();
        expect(closeBody('issue.resolve', { reason: ' Shipped ' })).toEqual({ verdict: 'resolve', reason: 'Shipped' });
        expect(closeBody('issue.discard', { reason: 'No' })).toEqual({ verdict: 'discard', reason: 'No' });
        expect(closeBody('issue.resolve', { reason: '  ' })).toBeNull();
    });
});

describe('live: the queue\'s own channel, what changed since a cursor', () => {
    it('listens on the queue\'s channel to the issue events, and reads the ring\'s issue id', () => {
        expect(issueChannel('01JP')).toBe('private-project-issues.01JP');
        expect(ISSUES_LIVE.events).toEqual(['issue.created', 'issue.updated', 'issue.deleted']);
        expect(issueRingIds('issue.updated', { issue: { id: 'i1', title: 'x' } })).toEqual(['i1']);
        expect(issueRingIds('issue.deleted', { issue: { id: 'i9' } })).toEqual(['i9']);
        expect(issueRingIds('issue.updated', 'garbage')).toEqual([]);
    });

    it('asks what changed under the same filters', () => {
        expect(issueChangesPath('p1', normalizeIssueFilters({ status: 'all', q: 'x' }), '2026-10-31T12:00:00Z', ['i1']))
            .toBe('/api/v1/projects/p1/issues/changes?status=all&q=x&since=2026-10-31T12%3A00%3A00Z&ids%5B%5D=i1');
    });

    it('applies only what changed: a changed row is replaced, an untouched one keeps its object, a gone one leaves', () => {
        const before = view();
        const changes = parseIssueChanges({ project_id: 'p1', cursor: '2026-10-31T12:05:00Z', filters: QUEUE.filters, ids: ['i3', 'i1'], rows: [issue({ id: 'i3', issue_number: 8, title: 'New one', created_at: '2026-10-31T11:00:00+00:00' })] })!;
        const after = applyIssueChanges(before, changes);

        expect(after.issues.map((i) => i.id)).toEqual(['i3', 'i1']);
        expect(after.issues[1]).toBe(before.issues[0]);
        expect(after.cursor).toBe('2026-10-31T12:05:00Z');
    });

    it('hands back the same view when nothing it shows changed', () => {
        const before = view();
        const same = applyIssueChanges(before, parseIssueChanges({ project_id: 'p1', cursor: before.cursor, filters: QUEUE.filters, ids: ['i1', 'i2'], rows: [] })!);
        expect(same).toBe(before);
    });
});

// ── The client: as an app, on the workspace's own project ─────────────────────────────────────────────────────────

type Call = { path: string; method: string; body?: unknown };
function ports(answer: { status: number; body: unknown }, opts: { signedIn?: boolean; project?: string | null } = {}) {
    const calls: Call[] = [];
    const p: TynnBoardPorts = {
        signedIn: () => opts.signedIn ?? true,
        projectFor: () => (opts.project === undefined ? 'p1' : opts.project),
        request: async (path, init) => {
            calls.push({ path, method: init.method, ...(init.body !== undefined ? { body: init.body } : {}) });
            return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body };
        },
    };
    return { p, calls };
}

describe('reading and acting through the pairing', () => {
    it('reads the workspace\'s own project\'s queue, with the filters asked for', async () => {
        const { p, calls } = ports({ status: 200, body: QUEUE });
        const r = await readTynnIssues(p, 'w1', { status: 'resolved' });
        expect(r).toMatchObject({ ok: true, view: { canTriage: true } });
        expect(calls).toEqual([{ path: '/api/v1/projects/p1/issues?status=resolved', method: 'GET' }]);
    });

    it('says why there is nothing — not linked, not signed in — and asks Tynn nothing', async () => {
        const unlinked = ports({ status: 200, body: QUEUE }, { project: null });
        expect(await readTynnIssues(unlinked.p, 'w1', {})).toMatchObject({ ok: false, state: 'not-linked' });
        const out = ports({ status: 200, body: QUEUE }, { signedIn: false });
        expect(await readTynnIssues(out.p, 'w1', {})).toMatchObject({ ok: false, state: 'signed-out' });
        expect([...unlinked.calls, ...out.calls]).toEqual([]);
    });

    it('reads Tynn\'s 404 as "sign in again so the pairing includes the issue queue"', async () => {
        const r = await readTynnIssues(ports({ status: 404, body: {} }).p, 'w1', {});
        expect(r).toMatchObject({ ok: false, state: 'signed-out' });
        expect((r as { reason: string }).reason).toMatch(/sign in to Tynn again/i);
        expect((r as { reason: string }).reason).toMatch(/issue/i);
        expect(await readTynnIssues(ports({ status: 200, body: { level: 'versions' } }).p, 'w1', {})).toMatchObject({ ok: false, state: 'error' });
    });

    it('sends each action with its body, and answers the issue Tynn returns', async () => {
        const { p, calls } = ports({ status: 201, body: issue({ id: 'i9', issue_number: 9, title: 'Keys' }) });
        const r = await runTynnIssueAction(p, 'w1', { action: 'issue.create', issueId: null, body: { title: 'Keys', priority: 'high' } });
        expect(r).toMatchObject({ ok: true, issue: { id: 'i9', title: 'Keys' } });
        expect(calls).toEqual([{ path: '/api/v1/projects/p1/issues', method: 'POST', body: { title: 'Keys', priority: 'high' } }]);

        const del = ports({ status: 204, body: null });
        expect(await runTynnIssueAction(del.p, 'w1', { action: 'issue.delete', issueId: 'i1' })).toEqual({ ok: true, issue: null });
        expect(del.calls).toEqual([{ path: '/api/v1/projects/p1/issues/i1', method: 'DELETE' }]);

        const close = ports({ status: 200, body: issue({ status: 'resolved' }) });
        await runTynnIssueAction(close.p, 'w1', { action: 'issue.resolve', issueId: 'i1', body: { reason: 'Done' } });
        expect(close.calls[0]).toEqual({ path: '/api/v1/projects/p1/issues/i1/close', method: 'POST', body: { verdict: 'resolve', reason: 'Done' } });
    });

    it('refuses to send what the web form would not, with the reason, and asks Tynn nothing', async () => {
        const { p, calls } = ports({ status: 200, body: {} });
        expect(await runTynnIssueAction(p, 'w1', { action: 'issue.create', issueId: null, body: { title: ' ' } })).toMatchObject({ ok: false, state: 'error' });
        expect(await runTynnIssueAction(p, 'w1', { action: 'issue.discard', issueId: 'i1', body: {} })).toMatchObject({ ok: false, reason: expect.stringMatching(/reason/i) });
        expect(await runTynnIssueAction(p, 'w1', { action: 'issue.convert', issueId: 'i1', body: {} })).toMatchObject({ ok: false, reason: expect.stringMatching(/version/i) });
        expect(calls).toEqual([]);
    });

    it('says a refused step in Tynn\'s own words (422), and every other refusal as "sign in again" (404)', async () => {
        const twice = ports({ status: 422, body: { message: 'x', errors: { issue: ['This issue has already been converted.'] } } });
        expect(await runTynnIssueAction(twice.p, 'w1', { action: 'issue.convert', issueId: 'i1', body: { version_id: 'v1' } }))
            .toEqual({ ok: false, state: 'transition-refused', reason: 'This issue has already been converted.' });
        expect(await runTynnIssueAction(ports({ status: 404, body: {} }).p, 'w1', { action: 'issue.delete', issueId: 'i1' })).toMatchObject({ ok: false, state: 'signed-out' });
    });

    it('asks what changed since a cursor, under the filters, and never re-reads the queue', async () => {
        const { p, calls } = ports({ status: 200, body: { project_id: 'p1', cursor: 'c2', filters: QUEUE.filters, ids: ['i1'], rows: [] } });
        const r = await readTynnIssueChanges(p, 'w1', {}, 'c1', ['i1']);
        expect(r).toMatchObject({ ok: true, changes: { cursor: 'c2', ids: ['i1'] } });
        expect(calls).toEqual([{ path: '/api/v1/projects/p1/issues/changes?since=c1&ids%5B%5D=i1', method: 'GET' }]);
    });
});

// ── Live: the same one-socket follower as the board, on the queue's own channel ─────────────────────────────────────

function liveHarness() {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const sockets: Array<SocketLike & { sent: string[]; emit(frame: unknown): void }> = [];
    const rings: Array<{ projectId: string; ring: BoardLiveRing }> = [];
    const states: Array<{ projectId: string; state: LiveState }> = [];
    const ports: TynnBoardLivePorts = {
        tynn: () => ({
            request: async (path, init) => {
                requests.push({ method: init.method, path, body: init.body ?? null });
                if (path === '/api/v1/broadcasting-config') return { ok: true, status: 200, json: async () => ({ broadcaster: 'reverb', key: 'rk', host: 'ws.tynn.test', port: 443, scheme: 'https' }) };
                return { ok: true, status: 200, json: async () => ({ auth: `rk:sig-for-${(init.body as { channel_name: string }).channel_name}` }) };
            },
        }),
        socket: () => {
            const listeners: Record<string, Array<(e: { data?: unknown }) => void>> = {};
            const s = {
                sent: [] as string[],
                send: (data: string) => { s.sent.push(data); },
                close: () => { for (const l of listeners.close ?? []) l({}); },
                addEventListener: (type: string, l: (e: { data?: unknown }) => void) => { (listeners[type] ??= []).push(l); },
                emit: (frame: unknown) => { for (const l of listeners.message ?? []) l({ data: JSON.stringify(frame) }); },
            };
            sockets.push(s);
            return s;
        },
        schedule: () => () => {},
        onRing: (projectId, ring) => { rings.push({ projectId, ring }); },
        onState: (projectId, state) => { states.push({ projectId, state }); },
        feed: TYNN_ISSUES_FEED,
    };
    const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); };
    return { live: new TynnBoardLive(ports), requests, sockets, rings, states, settle };
}

describe('the live queue, listening to Tynn', () => {
    it('has the issue-queue door sign the queue\'s own channel — never the board\'s — and rings on issue events only', async () => {
        const h = liveHarness();
        h.live.watch('P1');
        await h.settle();
        h.sockets[0]!.emit({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '1.2' }) });
        await h.settle();
        expect(h.requests.at(-1)).toEqual({ method: 'POST', path: '/api/v1/projects/P1/issues/broadcasting-auth', body: { socket_id: '1.2', channel_name: 'private-project-issues.P1' } });

        h.sockets[0]!.emit({ event: 'pusher_internal:subscription_succeeded', channel: 'private-project-issues.P1', data: '{}' });
        await h.settle();
        expect(h.states.at(-1)).toEqual({ projectId: 'P1', state: 'live' });
        h.sockets[0]!.emit({ event: 'issue.updated', channel: 'private-project-issues.P1', data: JSON.stringify({ issue: { id: 'i1' } }) });
        h.sockets[0]!.emit({ event: 'story.updated', channel: 'private-project-issues.P1', data: JSON.stringify({ story: { id: 's1' } }) });
        h.sockets[0]!.emit({ event: 'issue.updated', channel: 'private-project-board.P1', data: JSON.stringify({ issue: { id: 'i2' } }) });
        await h.settle();
        expect(h.rings).toEqual([
            { projectId: 'P1', ring: { ids: [], catchUp: true } },
            { projectId: 'P1', ring: { ids: ['i1'], catchUp: false } },
        ]);
    });
});

// Type-only use, so the view type stays exported for the panel.
export type { IssueQueueView };
