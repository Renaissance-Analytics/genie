import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { attachControlServer, type FrameCodec } from './control-channel';
import { createShuttleCore, SWAP_GRACE_MS, type ShuttleCore, type ShuttleState } from './core';
import { lengthPrefixedJsonCodec } from './frame-codec';
import { createShuttleListener } from './listener';
import { createManifestStore } from './manifest-store';
import { createPublisherGate } from './publisher-gate';
import { createTopologyStore } from './topology-store';

/**
 * THE SHUTTLE PROCESS — the layers, owning a port, a pipe and a directory.
 *
 * genie#346 Phase 1, `.ai/plans/genie-mcp-shuttle-spec.md` §3.2, §9.1, §9.2. The
 * core, gate, stores, listener and control channel are each tested alone; this
 * composes them into the thing that runs, and owns the parts only a running thing
 * has:
 *
 *  - **The port, exactly.** A shuttle that cannot bind the configured port REFUSES
 *    (§9.2). Every `.mcp.json` names that port as a literal, so a shuttle on any
 *    other port would be healthy and reachable by nobody. The refusal is written
 *    down, so Genie falling back in-process is visible rather than silent.
 *  - **The control channel, exclusively.** One shuttle per user. A live one
 *    already holding the pipe means "attach to that one", which is a different
 *    answer from "something else has the port", so the two refusals are named
 *    apart and the pipe is bound first.
 *  - **State that outlives Genie.** The manifest and topology a Genie published
 *    are persisted and read back at boot, so a cold shuttle with no Genie still
 *    answers discovery and still knows where each URL leads.
 *  - **Time.** The core only moves a detached shuttle to orphaned when told the
 *    grace has passed. Leaving that to the next request would leave the one agent
 *    that is waiting hanging for as long as nobody else calls — with Genie gone,
 *    possibly forever. So the shuttle arms a timer at boot and on every detach.
 */

export interface StartShuttleOptions {
    /** The configured MCP port. Bound exactly, or not at all. */
    port: number;
    /** Loopback only (§3.4). */
    host?: string;
    /** Named pipe (Windows) or unix socket path — see {@link shuttleControlPath}. */
    controlPath: string;
    /** `<userData>/genie/mcp-shuttle`. */
    stateDir: string;
    /** The publisher secret — see {@link readOrCreatePublisherSecret}. */
    secret: string;
    wireGeneration: number;
    shuttleVersion: string;
    /** How long a publisher may be gone before waiting calls give up. */
    graceMs?: number;
    now?: () => number;
    codec?: FrameCodec;
    /** One event per lifecycle change — a Genie attaching or going (§9.1). */
    log?: (event: Record<string, unknown>) => void;
}

export type ShuttleRefusal = 'port-in-use' | 'control-in-use' | 'failed';

export type StartShuttleResult =
    | { ok: true; shuttle: RunningShuttle }
    | { ok: false; reason: ShuttleRefusal; error: string };

export interface RunningShuttle {
    readonly port: number;
    readonly controlPath: string;
    state(): ShuttleState;
    /** Stop listening and release the port and pipe. The persisted state stays. */
    close(): Promise<void>;
}

/** Files in the state directory. */
export const SHUTTLE_FILES = {
    record: 'shuttle.json',
    refused: 'refused.json',
    manifest: 'manifest.json',
    topology: 'topology.json',
    secret: 'publisher.secret',
} as const;

/**
 * The control channel's address for a state directory. Derived, so Genie and the
 * shuttle find each other with nothing to hand over.
 *
 * A unix socket path has a hard length limit (104 bytes on macOS), and a user's
 * data directory can exceed it; past that the socket moves to the temp directory
 * under the same derived name.
 */
export function shuttleControlPath(stateDir: string): string {
    const id = crypto.createHash('sha256').update(path.resolve(stateDir)).digest('hex').slice(0, 16);
    if (process.platform === 'win32') return `\\\\.\\pipe\\genie-mcp-shuttle-${id}`;
    const inDir = path.join(stateDir, 'control.sock');
    return Buffer.byteLength(inDir) < 100 ? inDir : path.join(os.tmpdir(), `genie-mcp-shuttle-${id}.sock`);
}

/**
 * The secret a publisher proves it is Genie with. Created once, owner-readable
 * only, and read back unchanged — Genie and the shuttle both read this file, so
 * rotating it on every start would lock out the Genie that is already running.
 */
export function readOrCreatePublisherSecret(stateDir: string): string {
    fs.mkdirSync(stateDir, { recursive: true });
    const file = path.join(stateDir, SHUTTLE_FILES.secret);
    try {
        const existing = fs.readFileSync(file, 'utf8').trim();
        if (existing) return existing;
    } catch {
        /* not created yet */
    }
    const secret = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return fs.readFileSync(file, 'utf8').trim();
}

/** Write via a sibling temp file, so a crash mid-write never leaves a torn file. */
function writeAtomic(file: string, body: string): void {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
}

function fileBacked(file: string): { read(): string | null; write(body: string): void } {
    return {
        read: () => {
            try {
                return fs.readFileSync(file, 'utf8');
            } catch {
                return null;
            }
        },
        write: (body) => writeAtomic(file, body),
    };
}

type ListenOutcome = { ok: true } | { ok: false; code: string; error: string };

function listen(server: net.Server, ...args: [number, string] | [string]): Promise<ListenOutcome> {
    return new Promise((resolve) => {
        const onError = (e: NodeJS.ErrnoException) => {
            server.off('listening', onListening);
            resolve({ ok: false, code: e.code ?? 'UNKNOWN', error: e.message });
        };
        const onListening = () => {
            server.off('error', onError);
            resolve({ ok: true });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(...(args as [number, string]));
    });
}

/** Whether something is accepting connections on a control path right now. */
function answers(controlPath: string): Promise<boolean> {
    return new Promise((resolve) => {
        const probe = net.connect(controlPath);
        probe.once('connect', () => {
            probe.destroy();
            resolve(true);
        });
        probe.once('error', () => resolve(false));
    });
}

async function listenControl(server: net.Server, controlPath: string): Promise<ListenOutcome> {
    const first = await listen(server, controlPath);
    if (first.ok || first.code !== 'EADDRINUSE' || process.platform === 'win32') return first;
    // A unix socket FILE outlives a shuttle that crashed. Only a live one is in use.
    if (await answers(controlPath)) return first;
    try {
        fs.unlinkSync(controlPath);
    } catch {
        /* already gone */
    }
    return listen(server, controlPath);
}

function closeServer(server: net.Server): Promise<void> {
    return new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
    });
}

export async function startShuttle(opts: StartShuttleOptions): Promise<StartShuttleResult> {
    const host = opts.host ?? '127.0.0.1';
    const now = opts.now ?? Date.now;
    const graceMs = opts.graceMs ?? SWAP_GRACE_MS;
    const file = (name: string) => path.join(opts.stateDir, name);

    try {
        fs.mkdirSync(opts.stateDir, { recursive: true });
    } catch (e) {
        return { ok: false, reason: 'failed', error: `Cannot create ${opts.stateDir}: ${(e as Error).message}` };
    }

    const refuse = (reason: ShuttleRefusal, error: string): StartShuttleResult => {
        try {
            writeAtomic(
                file(SHUTTLE_FILES.refused),
                JSON.stringify({ reason, error, port: opts.port, controlPath: opts.controlPath, at: now() }),
            );
        } catch {
            /* the refusal is still returned; only its record is lost */
        }
        return { ok: false, reason, error };
    };

    const manifest = createManifestStore(fileBacked(file(SHUTTLE_FILES.manifest)));
    manifest.boot();
    const topology = createTopologyStore(fileBacked(file(SHUTTLE_FILES.topology)));
    topology.boot();

    const inner = createShuttleCore({ now, graceMs });
    let orphanTimer: ReturnType<typeof setTimeout> | null = null;
    const disarm = () => {
        if (orphanTimer) clearTimeout(orphanTimer);
        orphanTimer = null;
    };
    const arm = () => {
        disarm();
        orphanTimer = setTimeout(() => {
            orphanTimer = null;
            inner.tick();
        }, graceMs);
        orphanTimer.unref?.();
    };
    const say = (event: Record<string, unknown>) => {
        try {
            opts.log?.({ ...event, at: now() });
        } catch {
            /* a log must never be able to break routing */
        }
    };
    const core: ShuttleCore = {
        ...inner,
        attach(publisher, generation) {
            disarm();
            inner.attach(publisher, generation);
            say({ event: 'attached', generation });
        },
        detach() {
            inner.detach();
            arm();
            say({ event: 'detached' });
        },
    };

    const gate = createPublisherGate({
        secret: opts.secret,
        wireGeneration: opts.wireGeneration,
        core,
        onPublish: (m) => void manifest.publish(m),
        onTopology: (t) => void topology.publish(t),
    });

    // The pipe first: a live shuttle already holding it is the one to attach to.
    const control = net.createServer();
    const controlSockets = new Set<net.Socket>();
    control.on('connection', (socket) => {
        controlSockets.add(socket);
        socket.on('close', () => controlSockets.delete(socket));
    });
    attachControlServer(control, { gate, codec: opts.codec ?? lengthPrefixedJsonCodec() });
    const controlBound = await listenControl(control, opts.controlPath);
    if (!controlBound.ok) {
        return controlBound.code === 'EADDRINUSE'
            ? refuse('control-in-use', `Another MCP shuttle is already running on ${opts.controlPath}.`)
            : refuse('failed', `Cannot open the control channel ${opts.controlPath}: ${controlBound.error}`);
    }

    const listener = createShuttleListener({ core, manifest, routes: topology.routes() });
    const server = http.createServer(listener.handle);
    const bound = await listen(server, opts.port, host);
    if (!bound.ok) {
        listener.close();
        await closeServer(control);
        if (process.platform !== 'win32') fs.rmSync(opts.controlPath, { force: true });
        return bound.code === 'EADDRINUSE'
            ? refuse(
                  'port-in-use',
                  `Port ${opts.port} on ${host} is already in use. Every agent's MCP config names this port, ` +
                      'so the shuttle will not take another one.',
              )
            : refuse('failed', `Cannot listen on ${host}:${opts.port}: ${bound.error}`);
    }

    // A cold shuttle is detached from the moment it exists.
    arm();

    fs.rmSync(file(SHUTTLE_FILES.refused), { force: true });
    writeAtomic(
        file(SHUTTLE_FILES.record),
        JSON.stringify({
            pid: process.pid,
            port: opts.port,
            host,
            controlPath: opts.controlPath,
            wireGeneration: opts.wireGeneration,
            shuttleVersion: opts.shuttleVersion,
            startedAt: now(),
        }),
    );

    let closing: Promise<void> | null = null;
    return {
        ok: true,
        shuttle: {
            port: opts.port,
            controlPath: opts.controlPath,
            state: () => core.state(),
            close() {
                closing ??= (async () => {
                    disarm();
                    listener.close();
                    server.closeAllConnections();
                    for (const socket of controlSockets) socket.destroy();
                    await Promise.all([closeServer(server), closeServer(control)]);
                    if (process.platform !== 'win32') fs.rmSync(opts.controlPath, { force: true });
                })();
                return closing;
            },
        },
    };
}
