import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserWindow } from 'electron';
import http from 'node:http';
import { WebSocketServer, type WebSocket as WsServerSocket } from 'ws';
import { AddressInfo } from 'node:net';
import {
    connectRemote,
    disconnectConnKey,
    bindWindowToConnection,
    unbindWindow,
    remoteAttachTerminal,
    remoteTerminalInput,
    remoteControlStateFor,
} from '../index';

/** Attribution emoji the fake host's control views carry. */
const DESKTOP = '🖥️';
const TURTLE = '🐢';
const FOX = '🦊';

interface FakeHost {
    port: number;
    setLocked(v: boolean): void;
    pushControl(locked: boolean): void;
    /** Push a multi-user control view: another USER took the baton, not the host. */
    pushControlHeldBy(user: { id: string; name: string; emoji: string }): void;
    dropAllSockets(): void;
    eventsSocketCount(): number;
    termOpenCount(id: string): number;

    termInputs(id: string): string[];
    close(): Promise<void>;
}

function startFakeHost(): Promise<FakeHost> {
    let locked = false;
    const eventsSockets = new Set<WsServerSocket>();
    const termSockets = new Set<WsServerSocket>();
    const termOpens = new Map<string, number>();
    const termInputsById = new Map<string, string[]>();

    const wssEvents = new WebSocketServer({ noServer: true });
    const wssTerm = new WebSocketServer({ noServer: true });

    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname === '/api/ping') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ genie: true, hostname: 'fake', protocolVersion: 1, appVersion: '0.0.0-test' }));
            return;
        }
        if (url.pathname === '/api/pair') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ token: 'tok-1' }));
            return;
        }
        if (url.pathname === '/api/state') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    locked,
                    control: {
                        locked,
                        holder: locked ? 'desktop' : null,
                        holderEmoji: locked ? DESKTOP : null,
                        you: 'me',
                        participants: locked
                            ? [
                                  {
                                      id: 'desktop',
                                      name: 'This computer',
                                      emoji: DESKTOP,
                                      isOwner: true,
                                      holdsControl: true,
                                  },
                              ]
                            : [],
                    },
                    workspaces: [],
                    terminals: [],
                    processes: [],
                    questions: [],
                }),
            );
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
        if (url.pathname === '/ws/term') {
            const id = url.searchParams.get('terminal') ?? '';
            termOpens.set(id, (termOpens.get(id) ?? 0) + 1);
            wssTerm.handleUpgrade(req, socket, head, (ws) => {
                termSockets.add(ws);
                ws.on('close', () => termSockets.delete(ws));
                ws.on('message', (raw) => {
                    const arr = termInputsById.get(id) ?? [];
                    arr.push(String(raw));
                    termInputsById.set(id, arr);
                });
            });
            return;
        }
        socket.destroy();
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolve({
                port,
                setLocked(v) {
                    locked = v;
                },
                pushControl(l) {
                    locked = l;
                    for (const ws of eventsSockets) {
                        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'control:changed', payload: { locked: l } }));
                    }
                },
                pushControlHeldBy(user) {
                    locked = true;
                    const payload = {
                        locked: true,
                        holder: user.id,
                        holderEmoji: user.emoji,
                        you: 'me',
                        participants: [
                            { ...user, isOwner: false, holdsControl: true },
                            { id: 'me', name: 'Me', emoji: FOX, isOwner: false, holdsControl: false },
                        ],
                    };
                    for (const ws of eventsSockets) {
                        if (ws.readyState === 1) {
                            ws.send(JSON.stringify({ type: 'control:changed', payload }));
                        }
                    }
                },
                dropAllSockets() {
                    for (const ws of eventsSockets) ws.close();
                    for (const ws of termSockets) ws.close();
                },
                eventsSocketCount: () => eventsSockets.size,
                termOpenCount: (id) => termOpens.get(id) ?? 0,

                termInputs: (id) => termInputsById.get(id) ?? [],
                close: () =>
                    new Promise<void>((res) => {
                        for (const ws of eventsSockets) ws.terminate();
                        for (const ws of termSockets) ws.terminate();
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

const WC_ID = 7100;
let host: FakeHost;
let connKey: string;
let win: ReturnType<typeof fakeWindow>;

async function connect(): Promise<void> {
    connKey = '127.0.0.1:' + host.port;
    win = fakeWindow(WC_ID);
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([
        win,
    ] as unknown as Electron.BrowserWindow[]);
    const res = await connectRemote({ ip: '127.0.0.1', port: host.port, hostname: 'fake' }, '123456');
    expect(res.ok).toBe(true);
    bindWindowToConnection(WC_ID, connKey);
}

beforeEach(async () => {
    host = await startFakeHost();
});

afterEach(async () => {
    if (connKey) disconnectConnKey(connKey);
    unbindWindow(WC_ID);
    vi.restoreAllMocks();
    await host.close();
});

describe('control model - single source of truth (host kill-switch)', () => {
    it('seeds view-only control from the host /api/state on connect', async () => {
        host.setLocked(true);
        await connect();
        expect(remoteControlStateFor(WC_ID)).toMatchObject({ locked: true });
    });

    it('connects writable when the host has NOT taken control', async () => {
        await connect();
        expect(remoteControlStateFor(WC_ID)).toMatchObject({ locked: false });
    });

    it('propagates a live handoff and pushes remote:control to the window', async () => {
        await connect();
        expect(remoteControlStateFor(WC_ID)).toMatchObject({ locked: false });
        // The events bridge opens asynchronously after connect resolves; a live
        // push only reaches us once its socket is established.
        await vi.waitFor(() => expect(host.eventsSocketCount()).toBe(1));

        host.pushControl(true);

        await vi.waitFor(() => expect(remoteControlStateFor(WC_ID)).toMatchObject({ locked: true }));
        expect(win.webContents.send).toHaveBeenCalledWith(
            'remote:control',
            expect.objectContaining({ locked: true }),
        );

        host.pushControl(false);
        await vi.waitFor(() => expect(remoteControlStateFor(WC_ID)).toMatchObject({ locked: false }));
        expect(win.webContents.send).toHaveBeenCalledWith(
            'remote:control',
            expect.objectContaining({ locked: false }),
        );
    });
});

describe('control model - WHO holds it, not just whether', () => {
    it('names the user driving, so a remote member is not told "the host" took over', async () => {
        await connect();
        await vi.waitFor(() => expect(host.eventsSocketCount()).toBe(1));

        host.pushControlHeldBy({ id: 'u-2', name: 'Turtle', emoji: TURTLE });

        await vi.waitFor(() =>
            expect(remoteControlStateFor(WC_ID)).toEqual({
                locked: true,
                holderEmoji: TURTLE,
                holderName: 'Turtle',
            }),
        );
        expect(win.webContents.send).toHaveBeenCalledWith('remote:control', {
            locked: true,
            holderEmoji: TURTLE,
            holderName: 'Turtle',
        });
    });

    it('seeds the holder from /api/state on connect, not just the locked flag', async () => {
        host.setLocked(true);
        await connect();
        expect(remoteControlStateFor(WC_ID)).toEqual({
            locked: true,
            holderEmoji: DESKTOP,
            holderName: 'This computer',
        });
    });
});

describe('control gate - a view-only driver cannot write', () => {
    it('forwards keystrokes when writable, drops them when the host holds control', async () => {
        await connect();
        remoteAttachTerminal(WC_ID, 't-1');
        await vi.waitFor(() => expect(host.termOpenCount('t-1')).toBe(1));

        remoteTerminalInput(WC_ID, 't-1', 'ls\n');
        await vi.waitFor(() =>
            expect(host.termInputs('t-1').map((s) => JSON.parse(s))).toContainEqual({ type: 'input', data: 'ls\n' }),
        );

        host.pushControl(true);
        await vi.waitFor(() => expect(remoteControlStateFor(WC_ID)).toMatchObject({ locked: true }));
        const before = host.termInputs('t-1').length;
        remoteTerminalInput(WC_ID, 't-1', 'echo hi\n');
        await new Promise((r) => setTimeout(r, 60));
        expect(host.termInputs('t-1').length).toBe(before);
    });
});

describe('reconnect - restores terminal streams AND re-reads control', () => {
    it('re-attaches every wanted terminal and reconciles control after a drop', async () => {
        await connect();
        remoteAttachTerminal(WC_ID, 't-9');
        await vi.waitFor(() => expect(host.termOpenCount('t-9')).toBe(1));

        host.setLocked(true);
        host.dropAllSockets();

        await vi.waitFor(() => expect(host.termOpenCount('t-9')).toBeGreaterThanOrEqual(2), {
            timeout: 15000,
        });
        await vi.waitFor(() => expect(remoteControlStateFor(WC_ID)).toMatchObject({ locked: true }), {
            timeout: 15000,
        });
    }, 30000);
});
