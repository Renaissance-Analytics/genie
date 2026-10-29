import { describe, expect, it } from 'vitest';
import type { SocketLike } from '../src/main/issue-watch-client.js';
import { TynnBoardLive, type BoardLiveRing, type TynnBoardLivePorts } from '../src/main/tynn-board-live.js';
import type { LiveState } from '../src/core/tynn-board.js';
import { readTynnBoardChanges, type TynnBoardPorts } from '../src/main/tynn-board-client.js';

/**
 * THE LIVE BOARD, LISTENING TO TYNN (genie#1295 row B4, workspace-ux 0.4.0).
 *
 * One socket for the Tynn tabs that are open: Genie asks Tynn where to dial (`/api/v1/broadcasting-config`), dials, has
 * Tynn sign each open board's channel — the web board's own, `private-project.{id}` — at the board door
 * (`POST /api/v1/projects/{id}/broadcasting-auth`, the pairing token), and subscribes. Each board event is a ring for
 * that project; every (re)subscription is a ring too, a catch-up, so nothing that changed while the socket was down is
 * missed. A drop says "reconnecting" and tries again with a growing pause; a Tynn that will not sign the channel, or has
 * no socket at all, says "off" and the tab simply is not live.
 */
const P1 = '01JPROJECTONE';
const P2 = '01JPROJECTTWO';

function harness(opts: { signedIn?: boolean; authStatus?: number; config?: unknown } = {}) {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const sockets: Array<SocketLike & { sent: string[]; url: string; closed: boolean; emit(frame: unknown): void; drop(): void }> = [];
    const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    const rings: Array<{ projectId: string; ring: BoardLiveRing }> = [];
    const states: Array<{ projectId: string; state: LiveState }> = [];
    let authStatus = opts.authStatus ?? 200;
    const ports: TynnBoardLivePorts = {
        tynn: () => (opts.signedIn === false ? null : {
            request: async (path, init) => {
                requests.push({ method: init.method, path, body: init.body ?? null });
                if (path === '/api/v1/broadcasting-config') return { ok: true, status: 200, json: async () => opts.config ?? { broadcaster: 'reverb', key: 'rk', host: 'ws.tynn.test', port: 443, scheme: 'https' } };
                const status = authStatus;
                return { ok: status < 300, status, json: async () => ({ auth: `rk:sig-for-${(init.body as { channel_name: string }).channel_name}` }) };
            },
        }),
        socket: (url) => {
            const listeners: Record<string, Array<(e: { data?: unknown }) => void>> = {};
            const s = {
                url, sent: [] as string[], closed: false,
                send: (data: string) => { s.sent.push(data); },
                close: () => { s.closed = true; for (const l of listeners.close ?? []) l({}); },
                addEventListener: (type: string, l: (e: { data?: unknown }) => void) => { (listeners[type] ??= []).push(l); },
                emit: (frame: unknown) => { for (const l of listeners.message ?? []) l({ data: JSON.stringify(frame) }); },
                drop: () => { for (const l of listeners.close ?? []) l({}); },
            };
            sockets.push(s);
            return s;
        },
        schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
        onRing: (projectId, ring) => { rings.push({ projectId, ring }); },
        onState: (projectId, state) => { states.push({ projectId, state }); },
    };
    const live = new TynnBoardLive(ports);
    const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); };
    const establish = async (s: (typeof sockets)[number]) => {
        s.emit({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '123.456' }) });
        await settle();
    };
    const subscribed = async (s: (typeof sockets)[number], projectId: string) => {
        s.emit({ event: 'pusher_internal:subscription_succeeded', channel: `private-project.${projectId}`, data: '{}' });
        await settle();
    };
    const lastState = (projectId: string) => [...states].reverse().find((s) => s.projectId === projectId)?.state;
    return { live, requests, sockets, timers, rings, states, settle, establish, subscribed, lastState, setAuthStatus: (n: number) => { authStatus = n; } };
}

describe('going live', () => {
    it('dials where Tynn says, has the board door sign the project\'s own channel, subscribes, and says live', async () => {
        const h = harness();
        h.live.watch(P1);
        await h.settle();
        expect(h.lastState(P1)).toBe('connecting');
        expect(h.sockets[0]!.url).toBe('wss://ws.tynn.test:443/app/rk?protocol=7&client=genie&version=2.0');

        await h.establish(h.sockets[0]!);
        expect(h.requests.at(-1)).toEqual({ method: 'POST', path: `/api/v1/projects/${P1}/broadcasting-auth`, body: { socket_id: '123.456', channel_name: `private-project.${P1}` } });
        expect(JSON.parse(h.sockets[0]!.sent.at(-1)!)).toEqual({ event: 'pusher:subscribe', data: { auth: `rk:sig-for-private-project.${P1}`, channel: `private-project.${P1}` } });

        await h.subscribed(h.sockets[0]!, P1);
        expect(h.lastState(P1)).toBe('live');
        // Subscribing is a catch-up: the tab asks what changed since its cursor.
        expect(h.rings).toEqual([{ projectId: P1, ring: { ids: [], catchUp: true } }]);
    });

    it('rings the project for each board event, with the ids it names; ignores everything else', async () => {
        const h = harness();
        h.live.watch(P1);
        await h.settle();
        await h.establish(h.sockets[0]!);
        await h.subscribed(h.sockets[0]!, P1);
        h.rings.length = 0;

        const s = h.sockets[0]!;
        s.emit({ event: 'task.updated', channel: `private-project.${P1}`, data: JSON.stringify({ task: { id: 't1', story_id: 's1', status: 'done' } }) });
        s.emit({ event: 'story.deleted', channel: `private-project.${P1}`, data: JSON.stringify({ story: { id: 's2', project_version_id: 'v1' } }) });
        s.emit({ event: 'issue.created', channel: `private-project.${P1}`, data: '{}' });
        s.emit({ event: 'task.updated', channel: `private-project.${P2}`, data: '{}' });
        s.emit({ event: 'comment.created', channel: `private-project.${P1}`, data: '{}' });
        await h.settle();

        expect(h.rings).toEqual([
            { projectId: P1, ring: { ids: ['t1', 's1'], catchUp: false } },
            { projectId: P1, ring: { ids: ['s2', 'v1'], catchUp: false } },
        ]);
    });

    it('answers Tynn\'s ping, so the socket stays open', async () => {
        const h = harness();
        h.live.watch(P1);
        await h.settle();
        await h.establish(h.sockets[0]!);
        h.sockets[0]!.emit({ event: 'pusher:ping', data: '{}' });
        await h.settle();
        expect(JSON.parse(h.sockets[0]!.sent.at(-1)!)).toEqual({ event: 'pusher:pong', data: {} });
    });

    it('two open boards share one socket, each on its own channel', async () => {
        const h = harness();
        h.live.watch(P1);
        h.live.watch(P2);
        await h.settle();
        expect(h.sockets).toHaveLength(1);
        await h.establish(h.sockets[0]!);
        const channels = h.sockets[0]!.sent.map((f) => JSON.parse(f) as { data: { channel: string } }).map((f) => f.data.channel);
        expect(channels.sort()).toEqual([`private-project.${P1}`, `private-project.${P2}`]);
    });

    it('a board opened after the socket is up subscribes on that socket', async () => {
        const h = harness();
        h.live.watch(P1);
        await h.settle();
        await h.establish(h.sockets[0]!);
        h.live.watch(P2);
        await h.settle();
        expect(h.sockets).toHaveLength(1);
        expect(h.requests.at(-1)!.path).toBe(`/api/v1/projects/${P2}/broadcasting-auth`);
    });
});

describe('dropping and coming back', () => {
    it('a drop says reconnecting and dials again after a growing pause; coming back is a catch-up', async () => {
        const h = harness();
        h.live.watch(P1);
        await h.settle();
        await h.establish(h.sockets[0]!);
        await h.subscribed(h.sockets[0]!, P1);

        h.sockets[0]!.drop();
        await h.settle();
        expect(h.lastState(P1)).toBe('reconnecting');
        expect(h.timers.at(-1)!.ms).toBe(1_000);

        // Tynn still unreachable: the next pause is longer.
        h.timers.at(-1)!.fn();
        await h.settle();
        h.sockets[1]!.drop();
        await h.settle();
        expect(h.timers.at(-1)!.ms).toBe(2_000);

        h.timers.at(-1)!.fn();
        await h.settle();
        h.rings.length = 0;
        await h.establish(h.sockets[2]!);
        await h.subscribed(h.sockets[2]!, P1);
        expect(h.lastState(P1)).toBe('live');
        expect(h.rings).toEqual([{ projectId: P1, ring: { ids: [], catchUp: true } }]);

        // Live again: the pause starts over.
        h.sockets[2]!.drop();
        await h.settle();
        expect(h.timers.at(-1)!.ms).toBe(1_000);
    });

    it('a board Tynn will not sign (no board scope, no access, an older Tynn) is off, and is not retried in a loop', async () => {
        const h = harness({ authStatus: 404 });
        h.live.watch(P1);
        await h.settle();
        await h.establish(h.sockets[0]!);
        expect(h.lastState(P1)).toBe('off');
        expect(h.sockets[0]!.sent.filter((f) => f.includes('pusher:subscribe'))).toEqual([]);
        expect(h.timers.filter((t) => !t.cancelled)).toEqual([]);
    });

    it('a Tynn with no socket to listen on is off', async () => {
        const h = harness({ config: { broadcaster: 'log', key: null } });
        h.live.watch(P1);
        await h.settle();
        expect(h.sockets).toHaveLength(0);
        expect(h.lastState(P1)).toBe('off');
    });

    it('signed out is off, and nothing is dialled', async () => {
        const h = harness({ signedIn: false });
        h.live.watch(P1);
        await h.settle();
        expect(h.sockets).toHaveLength(0);
        expect(h.lastState(P1)).toBe('off');
    });

    it('closing the last open board closes the socket and dials nothing more', async () => {
        const h = harness();
        const stop1 = h.live.watch(P1);
        const stop2 = h.live.watch(P1);
        await h.settle();
        await h.establish(h.sockets[0]!);
        stop1();
        expect(h.sockets[0]!.closed).toBe(false);
        stop2();
        await h.settle();
        expect(h.sockets[0]!.closed).toBe(true);
        expect(h.timers.filter((t) => !t.cancelled)).toEqual([]);
    });
});

describe('asking Tynn what changed (the pairing door, the workspace\'s own project)', () => {
    const story = (id: string) => ({ id, story_number: 1, title: `Story ${id}`, status: 'backlog', order: 0, task_count: 0, tasks_done: 0, claimed_by: null, claimed_by_me: false, can_start: true, can_move_to_qa: false, version_active: true });
    const answer = (rows: unknown[]) => ({ project_id: 'p1', level: 'stories', version_id: 'v1', story_id: null, cursor: 'c1', ids: ['s1'], rows, active_version: null, active_story: null, claims: null });
    function ports(answers: Array<{ status: number; body: unknown }>) {
        const calls: string[] = [];
        let i = 0;
        const p: TynnBoardPorts = {
            signedIn: () => true,
            projectFor: (ws) => (ws === 'ws1' ? 'p1' : null),
            request: async (path) => {
                calls.push(path);
                const a = answers[Math.min(i++, answers.length - 1)]!;
                return { ok: a.status < 300, status: a.status, json: async () => a.body };
            },
        };
        return { p, calls };
    }

    it('asks the changes since the cursor for the scope, and answers them parsed', async () => {
        const { p, calls } = ports([{ status: 200, body: answer([story('s1')]) }]);
        const r = await readTynnBoardChanges(p, 'ws1', { version: 'v1' }, 'c0', ['s1']);
        expect(calls).toEqual(['/api/v1/projects/p1/board/changes?version=v1&since=c0&ids%5B%5D=s1']);
        expect(r.ok && r.changes.cursor).toBe('c1');
        expect(r.ok && r.changes.cards.map((c) => c.id)).toEqual(['s1']);
    });

    it('re-reads the open card\'s detail when that card changed, and only then', async () => {
        const detail = { kind: 'story', id: 's1', story_number: 1, title: 'Story s1', status: 'backlog', description: 'd' };
        const { p, calls } = ports([{ status: 200, body: answer([story('s1')]) }, { status: 200, body: detail }]);
        const r = await readTynnBoardChanges(p, 'ws1', { version: 'v1', focus: 'story:s1' }, 'c0', []);
        expect(calls.at(-1)).toBe('/api/v1/projects/p1/stories/s1');
        expect(r.ok && r.detail?.id).toBe('s1');

        const quiet = ports([{ status: 200, body: answer([]) }]);
        const q = await readTynnBoardChanges(quiet.p, 'ws1', { version: 'v1', focus: 'story:s1' }, 'c0', []);
        expect(quiet.calls).toHaveLength(1);
        expect(q.ok && q.detail).toBeUndefined();
    });

    it('a workspace with no project, and Tynn\'s 404, are said as the board says them', async () => {
        expect((await readTynnBoardChanges(ports([]).p, 'ws-unlinked', {}, 'c0', [])).ok).toBe(false);
        const r = await readTynnBoardChanges(ports([{ status: 404, body: null }]).p, 'ws1', {}, 'c0', []);
        expect(!r.ok && r.state).toBe('signed-out');
    });
});
