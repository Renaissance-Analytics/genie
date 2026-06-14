/**
 * Genie detached pty-host (Tier 3).
 *
 * A HEADLESS Node process — NO electron import — that owns the real node-pty
 * instances so they survive a full quit of the Electron app. The in-app
 * HostClient connects over a local socket (named pipe on Windows, unix domain
 * socket on POSIX) and proxies create/write/resize/kill; the host pushes back
 * `data`/`exit`. The host keeps its OWN scrollback ring buffer per pty so a
 * reattach AFTER a full quit can replay history.
 *
 * Launched detached by background.ts:
 *   spawn(process.execPath, [hostScript], {
 *     detached: true, stdio: 'ignore',
 *     env: { ELECTRON_RUN_AS_NODE: '1', GENIE_USERDATA: <userData>, … }
 *   }).unref()
 *
 * ELECTRON_RUN_AS_NODE makes Electron's binary run as plain Node so node-pty's
 * native ABI matches the one the app was built against (critical — a system Node
 * with a different ABI would fail to load the .node).
 *
 * Self-terminates after an idle period with zero live ptys AND no connected
 * client, so a host can never become a forever-orphan.
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, IPty } from 'node-pty';
import {
    encodeFrame,
    FrameDecoder,
    PROTOCOL_VERSION,
    type ClientMessage,
    type HostMessage,
} from './host-protocol';
import { socketPathFor, pidfilePath } from './host-locate';

const SCROLLBACK_MAX = 1_000_000;
/** Self-exit after this long with no ptys AND no connected client. */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const IDLE_CHECK_MS = 60 * 1000;

const userData = process.env.GENIE_USERDATA;
if (!userData) {
    // Without a userData path we can't write a pidfile the client can find.
    process.exit(2);
}

interface HostPty {
    pty: IPty;
    shell: string;
    scrollback: string;
}

const ptys = new Map<string, HostPty>();
const clients = new Set<net.Socket>();
let lastActivity = Date.now();

function broadcast(msg: HostMessage): void {
    const frame = encodeFrame(msg);
    for (const sock of clients) {
        try {
            sock.write(frame);
        } catch {
            /* dropped client — close handler cleans it up */
        }
    }
}

function createPty(opts: {
    id: string;
    cwd: string;
    shell?: string;
    args?: string[];
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
}): { pid: number; shell: string; existing: boolean; scrollback: string } {
    const existing = ptys.get(opts.id);
    if (existing) {
        return {
            pid: existing.pty.pid,
            shell: existing.shell,
            existing: true,
            scrollback: existing.scrollback,
        };
    }
    const shell = opts.shell ?? defaultShell();
    const env = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;
    env.TERM = env.TERM || 'xterm-256color';

    const pty = spawn(shell, opts.args ?? [], {
        name: 'xterm-color',
        cwd: opts.cwd,
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        env,
    });

    const entry: HostPty = { pty, shell, scrollback: '' };
    ptys.set(opts.id, entry);

    pty.onData((data) => {
        const next = entry.scrollback + data;
        entry.scrollback =
            next.length > SCROLLBACK_MAX ? next.slice(-SCROLLBACK_MAX) : next;
        broadcast({ kind: 'data', id: opts.id, data });
    });
    pty.onExit(({ exitCode, signal }) => {
        ptys.delete(opts.id);
        broadcast({ kind: 'exit', id: opts.id, exitCode, signal });
        lastActivity = Date.now();
    });

    return { pid: pty.pid, shell, existing: false, scrollback: '' };
}

function defaultShell(): string {
    if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
    return process.env.SHELL ?? '/bin/bash';
}

function handleClientMessage(sock: net.Socket, msg: ClientMessage): void {
    lastActivity = Date.now();
    switch (msg.kind) {
        case 'hello':
            reply(sock, {
                kind: 'hello-ok',
                seq: msg.seq,
                protocolVersion: PROTOCOL_VERSION,
                pid: process.pid,
            });
            break;
        case 'create': {
            const r = createPty(msg.opts);
            reply(sock, {
                kind: 'created',
                seq: msg.seq,
                result: {
                    id: msg.opts.id,
                    pid: r.pid,
                    shell: r.shell,
                    existing: r.existing,
                    scrollback: r.scrollback,
                },
            });
            break;
        }
        case 'write': {
            const e = ptys.get(msg.id);
            if (e) e.pty.write(msg.data);
            break;
        }
        case 'resize': {
            const e = ptys.get(msg.id);
            if (e) {
                try {
                    e.pty.resize(Math.max(1, msg.cols | 0), Math.max(1, msg.rows | 0));
                } catch {
                    /* transient 0×0 during layout */
                }
            }
            break;
        }
        case 'kill': {
            const e = ptys.get(msg.id);
            if (e) {
                try {
                    e.pty.kill();
                } catch {
                    /* already exited */
                }
                ptys.delete(msg.id);
            }
            break;
        }
        case 'list':
            reply(sock, {
                kind: 'list-result',
                seq: msg.seq,
                terminals: Array.from(ptys.entries()).map(([id, e]) => ({
                    id,
                    pid: e.pty.pid,
                    shell: e.shell,
                })),
            });
            break;
        case 'set-retained':
            // The host keeps EVERYTHING alive across quit regardless; the
            // retained flag is meaningful to the client (fallback/UX). The host
            // only needs to not-die, which it doesn't. Acknowledge by no-op.
            break;
        case 'get-scrollback':
            reply(sock, {
                kind: 'scrollback-result',
                seq: msg.seq,
                scrollback: ptys.get(msg.id)?.scrollback ?? null,
            });
            break;
        case 'ping':
            reply(sock, { kind: 'pong', seq: msg.seq });
            break;
    }
}

function reply(sock: net.Socket, msg: HostMessage): void {
    try {
        sock.write(encodeFrame(msg));
    } catch {
        /* client gone */
    }
}

function startServer(socketPath: string): void {
    // On POSIX a stale socket file blocks bind; remove it first. (On Windows the
    // pipe namespace handles this.)
    if (process.platform !== 'win32') {
        try {
            fs.rmSync(socketPath, { force: true });
        } catch {
            /* ignore */
        }
        try {
            fs.mkdirSync(path.dirname(socketPath), { recursive: true });
        } catch {
            /* ignore */
        }
    }

    const server = net.createServer((sock) => {
        clients.add(sock);
        lastActivity = Date.now();
        const decoder = new FrameDecoder();
        sock.on('data', (chunk: Buffer) => {
            const frames = decoder.push(chunk);
            if (decoder.desynced) {
                try {
                    sock.destroy();
                } catch {
                    /* ignore */
                }
                return;
            }
            for (const f of frames) handleClientMessage(sock, f as ClientMessage);
        });
        const drop = () => {
            clients.delete(sock);
            lastActivity = Date.now();
        };
        sock.on('close', drop);
        sock.on('error', drop);
    });

    server.on('error', (err) => {
        // EADDRINUSE: another host beat us to it. Exit quietly — the client will
        // connect to the winner.
        // eslint-disable-next-line no-console
        console.error('[pty-host] server error:', (err as Error).message);
        process.exit(3);
    });

    server.listen(socketPath, () => {
        try {
            writePidfileLocal(socketPath);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[pty-host] pidfile write failed:', (err as Error).message);
        }
    });

    // Idle watchdog: exit when nothing is running and nobody is connected.
    const idle = setInterval(() => {
        if (ptys.size === 0 && clients.size === 0 && Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
            cleanupAndExit(socketPath, server);
        }
    }, IDLE_CHECK_MS);
    if (typeof idle.unref === 'function') idle.unref();
}

function writePidfileLocal(socketPath: string): void {
    const target = pidfilePath(userData!);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(
        tmp,
        JSON.stringify({
            pid: process.pid,
            socketPath,
            protocolVersion: PROTOCOL_VERSION,
            startedAt: Date.now(),
        }),
    );
    fs.renameSync(tmp, target);
}

function cleanupAndExit(socketPath: string, server: net.Server): void {
    try {
        // Only remove the pidfile if it still points at US (avoid clobbering a
        // successor host that took over the socket).
        const pf = JSON.parse(fs.readFileSync(pidfilePath(userData!), 'utf8'));
        if (pf?.pid === process.pid) fs.rmSync(pidfilePath(userData!), { force: true });
    } catch {
        /* ignore */
    }
    if (process.platform !== 'win32') {
        try {
            fs.rmSync(socketPath, { force: true });
        } catch {
            /* ignore */
        }
    }
    try {
        server.close();
    } catch {
        /* ignore */
    }
    process.exit(0);
}

// --- main ------------------------------------------------------------------

const socketPath = socketPathFor(userData);

// A dead-mans-switch so we don't keep a host with no shells AND no client when
// the parent vanished without a clean disconnect: covered by the idle watchdog.
process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error('[pty-host] uncaught:', err);
});

startServer(socketPath);
