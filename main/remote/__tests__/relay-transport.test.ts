import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserWindow } from 'electron';
import { WebSocketServer, type WebSocket as WsServerSocket } from 'ws';
import { AddressInfo } from 'node:net';
import {
    connectWorkstation,
    disconnectConnKey,
    bindWindowToConnection,
    unbindWindow,
    remoteRequest,
    remoteAttachTerminal,
    remoteTerminalInput,
    remoteDetachTerminal,
} from '../index';

/**
 * Integration coverage for the RELAY transport wiring (increment 2): drive a
 * real in-process relay member server end-to-end through `connectWorkstation`
 * and the transport-branched bridge ops (`remoteRequest`, terminal attach/input)
 * to prove the `transport === 'relay'` branches route through the
 * RelayMemberClient + frame mux instead of the tailnet `ip:port` path.
 */

interface ServerFrame {
    kind: string;
    channel: string;
    sid: string;
    reqId?: string;
    payload?: unknown;
}

/** A minimal relay member-server stub: welcomes the hello, then lets the test
 *  inspect frames + push replies on the single live socket. */
function startRelayStub() {
    const wss = new WebSocketServer({ port: 0 });
    let socket: WsServerSocket | null = null;
    let closed = false;
    const frames: ServerFrame[] = [];
    const waiters: Array<{ match: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }> = [];
    let sid = 'sid-test-1';

    const replyRestFrame = (reqId: string, status: number, body: unknown): void => {
        socket?.send(
            JSON.stringify({
                kind: 'data',
                channel: 'rest',
                sid,
                reqId,
                payload: { status, body: body === undefined ? undefined : JSON.stringify(body) },
            }),
        );
    };

    wss.on('connection', (ws) => {
        socket = ws;
        ws.on('message', (raw) => {
            const msg = JSON.parse(String(raw)) as Record<string, unknown>;
            if (msg.type === 'member-hello') {
                ws.send(JSON.stringify({ type: 'member-welcome', sid }));
                return;
            }
            const frame = msg as unknown as ServerFrame;
            frames.push(frame);
            // Auto-ack the forwarded-questions sync the events bridge fires on
            // connect, so it never dangles into an unhandled rejection at teardown.
            if (
                frame.channel === 'rest' &&
                frame.kind === 'open' &&
                frame.reqId &&
                (frame.payload as { path?: string } | undefined)?.path === '/api/questions'
            ) {
                replyRestFrame(frame.reqId, 200, []);
            }
            for (let i = waiters.length - 1; i >= 0; i--) {
                if (waiters[i].match(frame)) {
                    waiters.splice(i, 1)[0].resolve(frame);
                }
            }
        });
    });

    const ready = new Promise<void>((resolve) => wss.on('listening', () => resolve()));

    return {
        ready,
        get url(): string {
            const { port } = wss.address() as AddressInfo;
            return `ws://127.0.0.1:${port}`;
        },
        set sid(v: string) {
            sid = v;
        },
        /** Resolve when a frame matching `match` arrives (or already has). */
        waitFor(match: (f: ServerFrame) => boolean): Promise<ServerFrame> {
            const existing = frames.find(match);
            if (existing) return Promise.resolve(existing);
            return new Promise((resolve) => waiters.push({ match, resolve }));
        },
        /** Push a REST reply frame correlated to a request's reqId. */
        replyRest(reqId: string, status: number, body: unknown): void {
            replyRestFrame(reqId, status, body);
        },
        /** Push a term data frame (the host's `{type,data}` wire). */
        pushTerm(message: unknown): void {
            socket?.send(
                JSON.stringify({ kind: 'data', channel: 'term', sid, payload: JSON.stringify(message) }),
            );
        },
        close(): Promise<void> {
            if (closed) return Promise.resolve();
            closed = true;
            return new Promise((resolve) => wss.close(() => resolve()));
        },
    };
}

/** A fake window whose webContents.send is spyable (for emitToConn delivery).
 *  Both `w.isDestroyed()` (emitToConn/broadcastStatus) and `w.webContents.*`
 *  must exist for the iteration to route to it. */
function fakeWindow(id: number) {
    return {
        isDestroyed: () => false,
        webContents: { id, send: vi.fn(), isDestroyed: () => false },
    };
}

const WS_ID = 'ws-int-1';
const CONN_KEY = `ws:${WS_ID}`;
const WC_ID = 9001;

let stub: ReturnType<typeof startRelayStub>;

beforeEach(async () => {
    stub = startRelayStub();
    await stub.ready;
});

afterEach(async () => {
    disconnectConnKey(CONN_KEY);
    unbindWindow(WC_ID);
    vi.restoreAllMocks();
    await stub.close();
});

describe('relay transport — connectWorkstation', () => {
    it('handshakes and registers a relay-kind connection under ws:<id>', async () => {
        const res = await connectWorkstation({
            workstationId: WS_ID,
            name: 'Studio Box',
            relayUrl: stub.url,
            grant: 'jws.test.grant',
        });
        expect(res).toEqual({ ok: true, connKey: CONN_KEY });
    });

    it('reuses a live workstation connection (no duplicate dial)', async () => {
        await connectWorkstation({ workstationId: WS_ID, name: 'A', relayUrl: stub.url, grant: 'g' });
        const again = await connectWorkstation({ workstationId: WS_ID, name: 'A', relayUrl: stub.url, grant: 'g' });
        expect(again).toEqual({ ok: true, connKey: CONN_KEY });
    });

    it('fails closed when the relay handshake cannot complete', async () => {
        const deadUrl = stub.url; // capture the port before we tear it down
        await stub.close(); // nothing listening → the dial is refused fast
        const res = await connectWorkstation({
            workstationId: WS_ID,
            name: 'Dead',
            relayUrl: deadUrl,
            grant: 'g',
        });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/workstation/i);
    });
});

describe('relay transport — bridge ops route through the relay', () => {
    beforeEach(async () => {
        await connectWorkstation({
            workstationId: WS_ID,
            name: 'Studio Box',
            relayUrl: stub.url,
            grant: 'jws.test.grant',
        });
        bindWindowToConnection(WC_ID, CONN_KEY);
    });

    it('remoteRequest sends a rest frame and maps the {status,body} reply to JSON', async () => {
        const pending = remoteRequest(WC_ID, '/api/state', { method: 'GET' });
        const reqFrame = await stub.waitFor(
            (f) =>
                f.channel === 'rest' &&
                f.kind === 'open' &&
                (f.payload as { path?: string } | undefined)?.path === '/api/state',
        );
        expect(reqFrame.reqId).toBeTruthy();
        expect((reqFrame.payload as { method: string; path: string }).method).toBe('GET');

        stub.replyRest(reqFrame.reqId as string, 200, { ok: true, workspaces: [] });
        await expect(pending).resolves.toEqual({ ok: true, workspaces: [] });
    });

    it('remoteAttachTerminal opens a term stream and re-emits terminal:data', async () => {
        const win = fakeWindow(WC_ID);
        vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([
            win,
        ] as unknown as Electron.BrowserWindow[]);

        remoteAttachTerminal(WC_ID, 't-7');
        const open = await stub.waitFor((f) => f.channel === 'term' && f.kind === 'open');
        expect((open.payload as { path: string }).path).toContain('terminal=t-7');

        stub.pushTerm({ type: 'data', data: 'hello-pty' });
        await vi.waitFor(() =>
            expect(win.webContents.send).toHaveBeenCalledWith('terminal:data', {
                id: 't-7',
                data: 'hello-pty',
            }),
        );
    });

    it('remoteTerminalInput forwards keystrokes as a term data frame', async () => {
        remoteAttachTerminal(WC_ID, 't-9');
        await stub.waitFor((f) => f.channel === 'term' && f.kind === 'open');

        remoteTerminalInput(WC_ID, 't-9', 'ls\n');
        const input = await stub.waitFor(
            (f) => f.channel === 'term' && f.kind === 'data' && typeof f.payload === 'string',
        );
        expect(JSON.parse(input.payload as string)).toEqual({ type: 'input', data: 'ls\n' });
    });

    it('remoteDetachTerminal closes the term stream', async () => {
        remoteAttachTerminal(WC_ID, 't-3');
        await stub.waitFor((f) => f.channel === 'term' && f.kind === 'open');

        remoteDetachTerminal(WC_ID, 't-3');
        const close = await stub.waitFor((f) => f.channel === 'term' && f.kind === 'close');
        expect(close.channel).toBe('term');
    });
});
