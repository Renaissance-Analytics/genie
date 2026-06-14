import net from 'node:net';
import { EventEmitter } from 'node:events';
import type { PtyBackend } from './backend';
import type { CreateTerminalOpts, TerminalInfo, AttachResult } from './types';
import {
    encodeFrame,
    FrameDecoder,
    PROTOCOL_VERSION,
    type ClientMessage,
    type HostMessage,
} from './host-protocol';
import { readSnapshot } from './sessions';

/**
 * HostClient — the Tier 3 PtyBackend that proxies every call to the DETACHED
 * pty-host over a local socket (named pipe on Windows, unix domain socket on
 * POSIX). The real node-pty instances live in the host, so they survive a full
 * quit of the Electron app; the client just relays create/write/resize/kill and
 * fans the host's pushed `data`/`exit` messages out to subscribers.
 *
 * Design constraints that shape this:
 *
 *   • ipc.ts calls are SYNCHRONOUS (create returns an AttachResult, write returns
 *     a boolean) because the in-process backend is synchronous. We can't make the
 *     socket round-trip synchronous, so the client keeps a LOCAL MIRROR of host
 *     state — known terminal ids, their pid/shell, retained flags, and a local
 *     scrollback ring fed from pushed `data` — and answers create/list/isLive/
 *     scrollback from that mirror immediately. The actual create request is sent
 *     fire-and-forget AFTER seeding the mirror; the host echoes the real pid via
 *     a `created` reply which we reconcile. This keeps the existing IPC contract
 *     intact without rewriting it async.
 *
 *   • On connect we `hello` (version handshake) then `list` + `get-scrollback`
 *     for each live host pty, seeding the mirror so a reattach-after-quit replays
 *     the host's retained history into the renderer exactly like a warm rejoin.
 *
 * Connection failures surface via the `error` event; the lifecycle layer
 * (background.ts) catches a failed connect/spawn and falls back to the in-process
 * backend with a non-fatal toast.
 */

const SCROLLBACK_MAX = 1_000_000;

interface MirrorEntry {
    pid: number;
    shell: string;
    scrollback: string;
}

export class HostClient extends EventEmitter implements PtyBackend {
    private socket: net.Socket | null = null;
    private readonly decoder = new FrameDecoder();
    private seq = 0;
    private readonly pending = new Map<number, (msg: HostMessage) => void>();

    private readonly mirror = new Map<string, MirrorEntry>();
    private readonly retained = new Set<string>();
    /** Host pid, learned from hello-ok — surfaced for diagnostics. */
    hostPid = 0;
    private connected = false;

    private constructor(private readonly socketPath: string) {
        super();
    }

    /**
     * Connect to a running host at `socketPath`, perform the version handshake,
     * and seed the local mirror from the host's live ptys (list + per-pty
     * scrollback). Resolves to a ready client, or rejects on connect failure /
     * version mismatch / timeout — the caller then falls back to in-process.
     */
    static connect(socketPath: string, timeoutMs = 3000): Promise<HostClient> {
        return new Promise<HostClient>((resolve, reject) => {
            const client = new HostClient(socketPath);
            const sock = net.createConnection(socketPath);
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try {
                    sock.destroy();
                } catch {
                    /* ignore */
                }
                reject(new Error('pty-host connect timeout'));
            }, timeoutMs);

            sock.on('error', (err) => {
                if (settled) {
                    client.handleSocketError(err);
                    return;
                }
                settled = true;
                clearTimeout(timer);
                reject(err);
            });

            sock.once('connect', async () => {
                client.socket = sock;
                client.wireSocket(sock);
                try {
                    const hello = (await client.request({
                        kind: 'hello',
                        seq: client.nextSeq(),
                        protocolVersion: PROTOCOL_VERSION,
                    })) as Extract<HostMessage, { kind: 'hello-ok' }>;
                    if (hello.protocolVersion !== PROTOCOL_VERSION) {
                        throw new Error(
                            `pty-host protocol mismatch: host=${hello.protocolVersion} client=${PROTOCOL_VERSION}`,
                        );
                    }
                    client.hostPid = hello.pid;
                    client.connected = true;
                    await client.seedFromHost();
                    settled = true;
                    clearTimeout(timer);
                    resolve(client);
                } catch (err) {
                    settled = true;
                    clearTimeout(timer);
                    try {
                        sock.destroy();
                    } catch {
                        /* ignore */
                    }
                    reject(err as Error);
                }
            });
        });
    }

    private wireSocket(sock: net.Socket): void {
        sock.on('data', (chunk: Buffer) => {
            const frames = this.decoder.push(chunk);
            if (this.decoder.desynced) {
                this.handleSocketError(new Error('pty-host stream desync'));
                return;
            }
            for (const frame of frames) this.handleHostMessage(frame as HostMessage);
        });
        sock.on('close', () => {
            if (this.connected) {
                this.connected = false;
                this.emit('error', new Error('pty-host connection closed'));
            }
        });
    }

    private handleSocketError(err: Error): void {
        if (!this.connected) return;
        this.connected = false;
        this.emit('error', err);
    }

    private handleHostMessage(msg: HostMessage): void {
        switch (msg.kind) {
            case 'data': {
                const entry = this.mirror.get(msg.id);
                if (entry) {
                    const next = entry.scrollback + msg.data;
                    entry.scrollback =
                        next.length > SCROLLBACK_MAX ? next.slice(-SCROLLBACK_MAX) : next;
                }
                this.emit('data', msg.id, msg.data);
                return;
            }
            case 'exit': {
                this.mirror.delete(msg.id);
                this.retained.delete(msg.id);
                this.emit('exit', msg.id, {
                    exitCode: msg.exitCode,
                    signal: msg.signal,
                });
                return;
            }
            default: {
                // Replies carry a seq — resolve the matching pending request.
                const seq = (msg as { seq?: number }).seq;
                if (seq != null) {
                    const resolver = this.pending.get(seq);
                    if (resolver) {
                        this.pending.delete(seq);
                        resolver(msg);
                    }
                }
            }
        }
    }

    private nextSeq(): number {
        return ++this.seq;
    }

    /** Send a request and await the correlated reply. */
    private request(msg: ClientMessage & { seq: number }): Promise<HostMessage> {
        return new Promise<HostMessage>((resolve, reject) => {
            if (!this.socket) {
                reject(new Error('pty-host not connected'));
                return;
            }
            this.pending.set(msg.seq, resolve);
            try {
                this.socket.write(encodeFrame(msg));
            } catch (err) {
                this.pending.delete(msg.seq);
                reject(err as Error);
            }
        });
    }

    /** Fire-and-forget send for messages with no reply (write/resize/kill/…). */
    private send(msg: ClientMessage): void {
        if (!this.socket) return;
        try {
            this.socket.write(encodeFrame(msg));
        } catch {
            /* surfaced via the socket error/close handlers */
        }
    }

    /** Seed the local mirror from the host's live ptys after a (re)connect. */
    private async seedFromHost(): Promise<void> {
        const listed = (await this.request({
            kind: 'list',
            seq: this.nextSeq(),
        })) as Extract<HostMessage, { kind: 'list-result' }>;
        for (const t of listed.terminals) {
            const sb = (await this.request({
                kind: 'get-scrollback',
                seq: this.nextSeq(),
                id: t.id,
            })) as Extract<HostMessage, { kind: 'scrollback-result' }>;
            this.mirror.set(t.id, {
                pid: t.pid,
                shell: t.shell,
                scrollback: sb.scrollback ?? '',
            });
        }
    }

    /** Ids the host currently has live — used by the lifecycle layer to drive
     *  the reattach (renderer remounts these specs, replaying host scrollback). */
    liveIds(): string[] {
        return Array.from(this.mirror.keys());
    }

    isConnected(): boolean {
        return this.connected;
    }

    /** Disconnect WITHOUT killing host ptys (before-quit leave-running). */
    disconnect(): void {
        this.connected = false;
        if (this.socket) {
            try {
                this.socket.end();
            } catch {
                /* ignore */
            }
            this.socket = null;
        }
    }

    // --- PtyBackend ---------------------------------------------------------

    create(opts: CreateTerminalOpts): AttachResult {
        const existing = this.mirror.get(opts.id);
        if (existing) {
            // Warm rejoin from the mirror — the host already runs this pty and we
            // hold its replayed scrollback. No new spawn request.
            return {
                id: opts.id,
                pid: existing.pid,
                shell: existing.shell,
                existing: true,
                scrollback: existing.scrollback,
            };
        }
        // Cold create: seed the mirror immediately (pid 0 until the host echoes
        // the real one), fire the create request, and surface any on-disk
        // snapshot exactly like the in-process backend does on a cold spawn.
        this.mirror.set(opts.id, { pid: 0, shell: opts.shell ?? '', scrollback: '' });
        this.request({ kind: 'create', seq: this.nextSeq(), opts })
            .then((reply) => {
                if (reply.kind !== 'created') return;
                const entry = this.mirror.get(opts.id);
                if (entry) {
                    entry.pid = reply.result.pid;
                    entry.shell = reply.result.shell;
                }
            })
            .catch(() => {
                /* connection error surfaces via the error event → fallback */
            });
        const snap = readSnapshot(opts.id);
        return {
            id: opts.id,
            pid: 0,
            shell: opts.shell ?? '',
            existing: false,
            scrollback: '',
            snapshot: snap ?? undefined,
        };
    }

    write(id: string, data: string): boolean {
        if (!this.mirror.has(id)) return false;
        this.send({ kind: 'write', id, data });
        return true;
    }

    resize(id: string, cols: number, rows: number): boolean {
        if (!this.mirror.has(id)) return false;
        this.send({
            kind: 'resize',
            id,
            cols: Math.max(1, cols | 0),
            rows: Math.max(1, rows | 0),
        });
        return true;
    }

    kill(id: string): boolean {
        const had = this.mirror.delete(id);
        this.retained.delete(id);
        this.send({ kind: 'kill', id });
        return had;
    }

    /**
     * NO-OP for the host backend. The whole point of Tier 3 is that ptys survive
     * a full quit, so the before-quit teardown must NOT kill them. The lifecycle
     * layer disconnects the client and leaves the host running instead.
     */
    killAll(): void {
        /* intentionally empty — host ptys survive quit */
    }

    list(): TerminalInfo[] {
        return Array.from(this.mirror.entries()).map(([id, e]) => ({
            id,
            pid: e.pid,
            shell: e.shell,
        }));
    }

    isLive(id: string): boolean {
        return this.mirror.has(id);
    }

    setRetained(id: string, retained: boolean): void {
        if (retained) this.retained.add(id);
        else this.retained.delete(id);
        this.send({ kind: 'set-retained', id, retained });
    }

    isRetained(id: string): boolean {
        return this.retained.has(id);
    }

    retainedCount(): number {
        return this.retained.size;
    }

    retainedIds(): string[] {
        return Array.from(this.retained);
    }

    getScrollback(id: string): string | undefined {
        return this.mirror.get(id)?.scrollback;
    }
}
