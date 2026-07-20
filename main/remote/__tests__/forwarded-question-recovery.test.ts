import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserWindow } from 'electron';
import http from 'node:http';
import { WebSocketServer, type WebSocket as WsServerSocket } from 'ws';
import { AddressInfo } from 'node:net';

/**
 * The forwarded-ForceTheQuestion RECOVERY path (main/remote/index.ts
 * `syncForwardedQuestions`).
 *
 * Two bugs made a driver's answer vanish without trace, and both are pinned here:
 *
 *  1. The answer POST back to the host was fire-and-forget under a swallowing
 *     `.catch(() => {})`. A rejected POST looked EXACTLY like a delivered one —
 *     the driver's modal closed, nothing was retried, and the host sat blocked
 *     with its own modal open forever.
 *  2. The kill-switch wasn't consulted before forwarding. The host's questions
 *     READ is unguarded while the answer POST is guarded (423), so a locked host
 *     handed out prompts it would then refuse — the driver answered into a void.
 *
 * `forwardedAnswerFailureMessage` and `shouldForwardToDriver` are pure and
 * covered by their own unit tests. What was NOT covered is the BEHAVIOUR that
 * makes those decisions matter: that a failed answer brings the question BACK,
 * that a lock retracts what's already open, and that unlocking restores it.
 * That needs the connection registry driving, so this drives a real fake host
 * over real HTTP + WebSocket (the `control-state.test.ts` harness) and mocks
 * only the modal layer — the piece that would otherwise open BrowserWindows.
 */

/**
 * Stand-in for the ForceTheQuestion modal queue. Mirrors the real contract in
 * main/ask/force-question.ts: raising returns a promise that stays pending until
 * the user answers (`{cancelled:false}`) or the question is dismissed/cancelled
 * (`{cancelled:true}` — which is exactly what `finish` resolves on dismissal).
 * Keeping a raise LOG (not just what's open) is the point: re-raising after a
 * failure is the recovery behaviour under test, and only the log can see it.
 */
const ask = vi.hoisted(() => {
    interface Raised {
        connKey: string;
        hostId: string;
        resolve: (r: { cancelled: boolean; answers: unknown[] }) => void;
    }
    const open: Raised[] = [];
    const raises: { connKey: string; hostId: string }[] = [];

    const settle = (hostId: string, r: { cancelled: boolean; answers: unknown[] }): void => {
        const idx = open.findIndex((o) => o.hostId === hostId);
        if (idx === -1) return;
        const [item] = open.splice(idx, 1);
        item.resolve(r);
    };

    return {
        open,
        raises,
        raiseForwardedQuestion(opts: {
            connKey: string;
            hostId: string;
            questions: unknown[];
            workspaceLabel?: string;
        }): Promise<{ cancelled: boolean; answers: unknown[] }> {
            raises.push({ connKey: opts.connKey, hostId: opts.hostId });
            return new Promise((resolve) => {
                open.push({ connKey: opts.connKey, hostId: opts.hostId, resolve });
            });
        },
        dismissForwardedQuestion(_connKey: string, hostId: string): void {
            settle(hostId, { cancelled: true, answers: [] });
        },
        dismissForwardedQuestionsForConn(connKey: string): void {
            for (const o of [...open]) {
                if (o.connKey === connKey) settle(o.hostId, { cancelled: true, answers: [] });
            }
        },
        /** The driver answers the open modal (→ POST back to the host). */
        answer(hostId: string, answers: unknown[]): void {
            settle(hostId, { cancelled: false, answers });
        },
        /** The driver dismisses the modal without answering. */
        cancel(hostId: string): void {
            settle(hostId, { cancelled: true, answers: [] });
        },
        raiseCount(hostId: string): number {
            return raises.filter((r) => r.hostId === hostId).length;
        },
        reset(): void {
            open.length = 0;
            raises.length = 0;
        },
    };
});

vi.mock('../../ask/force-question', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../ask/force-question')>()),
    raiseForwardedQuestion: ask.raiseForwardedQuestion,
    dismissForwardedQuestion: ask.dismissForwardedQuestion,
    dismissForwardedQuestionsForConn: ask.dismissForwardedQuestionsForConn,
}));

import { connectRemote, disconnectConnKey, bindWindowToConnection, unbindWindow } from '../index';

interface HostQuestion {
    id: string;
    questions: { text: string }[];
    workspaceLabel?: string;
}

interface FakeHost {
    port: number;
    /** Seed the host's pending ForceTheQuestion list. */
    setQuestions(qs: HostQuestion[]): void;
    /** Status the answer POST replies with (423 = kill-switch refusal). */
    setAnswerStatus(status: number): void;
    /** Host-side `question:changed` push over /ws/events. */
    pushQuestionChanged(): void;
    /** Host-side kill-switch toggle + `control:changed` push. */
    pushControl(locked: boolean): void;
    answerPosts(): { id: string; body: string }[];
    questionReads(): number;
    eventsSocketCount(): number;
    close(): Promise<void>;
}

function startFakeHost(): Promise<FakeHost> {
    let locked = false;
    let answerStatus = 200;
    let pending: HostQuestion[] = [];
    let reads = 0;
    const posts: { id: string; body: string }[] = [];
    const eventsSockets = new Set<WsServerSocket>();
    const wssEvents = new WebSocketServer({ noServer: true });

    const json = (res: http.ServerResponse, status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
    };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname === '/api/ping') {
            json(res, 200, {
                genie: true,
                hostname: 'fake',
                protocolVersion: 1,
                appVersion: '0.0.0-test',
            });
            return;
        }
        if (url.pathname === '/api/pair') {
            json(res, 200, { token: 'tok-1' });
            return;
        }
        if (url.pathname === '/api/state') {
            json(res, 200, {
                locked,
                workspaces: [],
                terminals: [],
                processes: [],
                questions: pending,
            });
            return;
        }
        if (url.pathname === '/api/questions' && req.method === 'GET') {
            reads += 1;
            json(res, 200, { questions: pending });
            return;
        }
        const answerMatch = /^\/api\/questions\/([^/]+)\/answer$/.exec(url.pathname);
        if (answerMatch && req.method === 'POST') {
            const id = decodeURIComponent(answerMatch[1]);
            let body = '';
            req.on('data', (c) => (body += String(c)));
            req.on('end', () => {
                posts.push({ id, body });
                if (answerStatus !== 200) {
                    // The real host refuses a state-changing call while the
                    // kill-switch is on — the question STAYS pending.
                    json(res, answerStatus, { error: 'locked' });
                    return;
                }
                pending = pending.filter((q) => q.id !== id);
                json(res, 200, { ok: true });
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });

    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname === '/ws/events') {
            wssEvents.handleUpgrade(req, socket, head, (ws) => {
                eventsSockets.add(ws);
                ws.on('close', () => eventsSockets.delete(ws));
            });
            return;
        }
        socket.destroy();
    });

    const emit = (type: string, payload: unknown): void => {
        for (const ws of eventsSockets) {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
        }
    };

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolve({
                port,
                setQuestions: (qs) => {
                    pending = qs;
                },
                setAnswerStatus: (s) => {
                    answerStatus = s;
                },
                pushQuestionChanged: () => emit('question:changed', {}),
                pushControl: (l) => {
                    locked = l;
                    emit('control:changed', { locked: l });
                },
                answerPosts: () => posts,
                questionReads: () => reads,
                eventsSocketCount: () => eventsSockets.size,
                close: () =>
                    new Promise<void>((res) => {
                        for (const ws of eventsSockets) ws.terminate();
                        server.close(() => res());
                    }),
            });
        });
    });
}

function fakeWindow(id: number) {
    return {
        isDestroyed: () => false,
        webContents: { id, send: vi.fn(), isDestroyed: () => false },
    };
}

const WC_ID = 7200;
const Q1: HostQuestion = {
    id: 'hq-1',
    questions: [{ text: 'Ship it?' }],
    workspaceLabel: 'genie',
};

let host: FakeHost;
let connKey: string;

/** Connect the driver and wait until its /ws/events bridge is live, so a
 *  host-side push in the test can actually reach it. */
async function connect(): Promise<void> {
    connKey = '127.0.0.1:' + host.port;
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([
        fakeWindow(WC_ID),
    ] as unknown as Electron.BrowserWindow[]);
    const res = await connectRemote(
        { ip: '127.0.0.1', port: host.port, hostname: 'fake' },
        '123456',
    );
    expect(res.ok).toBe(true);
    bindWindowToConnection(WC_ID, connKey);
    await vi.waitFor(() => expect(host.eventsSocketCount()).toBe(1));
}

beforeEach(async () => {
    ask.reset();
    host = await startFakeHost();
});

afterEach(async () => {
    if (connKey) disconnectConnKey(connKey);
    unbindWindow(WC_ID);
    vi.restoreAllMocks();
    await host.close();
});

describe('forwarded answer delivery failure — the answer must not vanish', () => {
    it('re-raises the still-pending question when the answer POST is refused', async () => {
        host.setQuestions([Q1]);
        await connect();
        await vi.waitFor(() => expect(ask.raiseCount('hq-1')).toBe(1));

        // The host's kill-switch engages between the READ and the answer: the
        // POST is refused and the question stays pending on the host.
        host.setAnswerStatus(423);
        ask.answer('hq-1', [{ text: 'yes' }]);

        await vi.waitFor(() => expect(host.answerPosts()).toHaveLength(1));
        // The recovery contract: the question comes BACK, visibly unanswered,
        // instead of the modal closing as if the answer had landed.
        await vi.waitFor(() => expect(ask.raiseCount('hq-1')).toBe(2));
        expect(ask.open.map((o) => o.hostId)).toEqual(['hq-1']);
    });

    it('keeps recovering while the host keeps refusing (no one-shot retry)', async () => {
        host.setQuestions([Q1]);
        await connect();
        await vi.waitFor(() => expect(ask.raiseCount('hq-1')).toBe(1));
        host.setAnswerStatus(423);

        ask.answer('hq-1', [{ text: 'yes' }]);
        await vi.waitFor(() => expect(ask.raiseCount('hq-1')).toBe(2));
        // Answer the re-raised modal — still refused, so it must come back again.
        ask.answer('hq-1', [{ text: 'yes' }]);
        await vi.waitFor(() => expect(ask.raiseCount('hq-1')).toBe(3));
        expect(host.answerPosts()).toHaveLength(2);
    });

    it('does NOT re-raise once the answer is accepted', async () => {
        host.setQuestions([Q1]);
        await connect();
        await vi.waitFor(() => expect(ask.raiseCount('hq-1')).toBe(1));

        ask.answer('hq-1', [{ text: 'yes' }]);
        await vi.waitFor(() => expect(host.answerPosts()).toHaveLength(1));
        expect(JSON.parse(host.answerPosts()[0].body)).toEqual({ answers: [{ text: 'yes' }] });

        // The host resolved it, so the round-tripped question:changed must leave
        // the driver quiet — recovery must not fire on the success path.
        host.pushQuestionChanged();
        await vi.waitFor(() => expect(host.questionReads()).toBeGreaterThanOrEqual(2));
        expect(ask.raiseCount('hq-1')).toBe(1);
        expect(ask.open).toHaveLength(0);
    });

    it('posts nothing when the driver dismisses instead of answering', async () => {
        host.setQuestions([Q1]);
        await connect();
        await vi.waitFor(() => expect(ask.raiseCount('hq-1')).toBe(1));

        // A cancel means the host owner keeps control of the question — the
        // driver must never speak for them.
        ask.cancel('hq-1');
        host.pushQuestionChanged();
        await vi.waitFor(() => expect(ask.raiseCount('hq-1')).toBe(2));
        expect(host.answerPosts()).toHaveLength(0);
    });
});

describe('kill-switch — a locked host is not forwarded, and open modals retract', () => {
    it('retracts an already-open forwarded modal when the host takes control', async () => {
        host.setQuestions([Q1]);
        await connect();
        await vi.waitFor(() => expect(ask.raiseCount('hq-1')).toBe(1));

        host.pushControl(true);

        // The modal is now unanswerable (the host would 423 the POST), so
        // leaving it up would invite the driver to answer into a void.
        await vi.waitFor(() => expect(ask.open).toHaveLength(0));
        expect(host.answerPosts()).toHaveLength(0);
    });

    it('raises nothing at all while locked', async () => {
        host.setQuestions([Q1]);
        await connect();
        await vi.waitFor(() => expect(ask.raiseCount('hq-1')).toBe(1));
        host.pushControl(true);
        await vi.waitFor(() => expect(ask.open).toHaveLength(0));

        // A fresh host question arriving mid-lock must stay on the host, where
        // it can actually be answered.
        host.setQuestions([Q1, { id: 'hq-2', questions: [{ text: 'Deploy?' }] }]);
        host.pushQuestionChanged();
        await new Promise((r) => setTimeout(r, 80));
        expect(ask.raiseCount('hq-2')).toBe(0);
        expect(ask.open).toHaveLength(0);
    });

    it('brings a still-pending question back when the host releases control', async () => {
        host.setQuestions([Q1]);
        await connect();
        await vi.waitFor(() => expect(ask.raiseCount('hq-1')).toBe(1));
        host.pushControl(true);
        await vi.waitFor(() => expect(ask.open).toHaveLength(0));

        host.pushControl(false);

        // Nothing was lost by retracting: unlocking re-syncs and the question
        // the host is STILL blocked on reappears on the driver.
        await vi.waitFor(() => expect(ask.raiseCount('hq-1')).toBe(2));
        expect(ask.open.map((o) => o.hostId)).toEqual(['hq-1']);
    });

    it('forwards nothing on a connect to an already-locked host', async () => {
        host.setQuestions([Q1]);
        host.pushControl(true); // no sockets yet — just seeds /api/state locked
        await connect();

        await new Promise((r) => setTimeout(r, 80));
        expect(ask.raises).toHaveLength(0);
    });
});

describe('forwardedShown bookkeeping — one modal per host question', () => {
    it('does not raise a second modal for a question already shown', async () => {
        host.setQuestions([Q1]);
        await connect();
        await vi.waitFor(() => expect(ask.raiseCount('hq-1')).toBe(1));

        // The host pushes question:changed for ANY queue movement, so repeated
        // syncs over one unanswered question are normal — they must not stack
        // duplicate modals on the driver.
        host.pushQuestionChanged();
        host.pushQuestionChanged();
        host.pushQuestionChanged();
        await vi.waitFor(() => expect(host.questionReads()).toBeGreaterThanOrEqual(4));
        expect(ask.raiseCount('hq-1')).toBe(1);
        expect(ask.open).toHaveLength(1);
    });

    it('dismisses the local modal when the host owner answers first', async () => {
        host.setQuestions([Q1]);
        await connect();
        await vi.waitFor(() => expect(ask.raiseCount('hq-1')).toBe(1));

        // First-answer-wins: the host owner answered on the desktop, so the
        // question leaves the host's pending list and our modal must go too.
        host.setQuestions([]);
        host.pushQuestionChanged();

        await vi.waitFor(() => expect(ask.open).toHaveLength(0));
        expect(host.answerPosts()).toHaveLength(0);
        // …and the id is released, so it is not treated as "already shown" if a
        // later question reuses it.
        host.setQuestions([Q1]);
        host.pushQuestionChanged();
        await vi.waitFor(() => expect(ask.raiseCount('hq-1')).toBe(2));
    });
});
