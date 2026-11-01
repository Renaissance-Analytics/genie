/**
 * THE SPAWN HOST'S WIRE (genie#1397). Main asks the spawn host (main/spawn-host.ts, a child process) to create every
 * process main used to create on its own thread: `execFileRunner`'s commands (the Docker CLI first among them), the
 * long-lived streams (`docker events`), and the supervisor's ptys (sites, queue workers, the front door).
 *
 * The frames are the host protocol's (core/remote-protocol.ts `WireMessage`, which the host split's engine protocol
 * reuses too): `call{id,method,args}` → `result{id,ok,value|reason}`, and `event{channel,payload}`. A call with `id: 0`
 * wants no answer (a pty write, a resize, a kill: the order on the channel is the order they happen in). A failed result
 * may carry the error's `code` (ENOENT, ETIMEDOUT), which `execFileRunner`'s callers read.
 *
 * `host.env [env]` makes main's environment the child's, whole, before any call made after it changed: what a process is
 * started with is main's environment NOW (a toolchain install puts a directory on main's PATH; config is hot-swappable),
 * never what it was when the child was forked, and never the fork's own ELECTRON_RUN_AS_NODE.
 *
 * When the host split (#1387 P5) moves the supervisor and the service engines into genie-host, this child goes with
 * them and these methods are the genie-host side's to serve; nothing here knows it is talking to Electron.
 */

export const SPAWN_METHODS = ['host.env', 'spawn.exec', 'spawn.stream', 'spawn.unstream', 'pty.open', 'pty.write', 'pty.resize', 'pty.kill', 'host.shutdown'] as const;
export type SpawnMethod = (typeof SPAWN_METHODS)[number];

export const SPAWN_EVENTS = ['host.ready', 'pty.opened', 'pty.data', 'pty.exit', 'stream.line', 'stream.end'] as const;
export type SpawnEvent = (typeof SPAWN_EVENTS)[number];

export type SpawnFrame =
    | { kind: 'call'; id: number; method: SpawnMethod; args: unknown[] }
    | { kind: 'result'; id: number; ok: true; value: unknown }
    | { kind: 'result'; id: number; ok: false; reason: string; code?: string }
    | { kind: 'event'; channel: SpawnEvent; payload: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A frame as it arrived over the channel, checked; `null` for anything else (never thrown: the other side is a process). */
export function parseSpawnFrame(v: unknown): SpawnFrame | null {
    if (!isRecord(v)) return null;
    if (v['kind'] === 'call' && typeof v['id'] === 'number' && (SPAWN_METHODS as readonly unknown[]).includes(v['method']) && Array.isArray(v['args'])) return v as SpawnFrame;
    if (v['kind'] === 'result' && typeof v['id'] === 'number' && typeof v['ok'] === 'boolean') {
        if (v['ok'] === true) return v as SpawnFrame;
        if (typeof v['reason'] === 'string') return v as SpawnFrame;
        return null;
    }
    if (v['kind'] === 'event' && (SPAWN_EVENTS as readonly unknown[]).includes(v['channel'])) return v as SpawnFrame;
    return null;
}

/** One end of the channel: a forked child's IPC on either side (the client's ChildProcess, the child's `process`). */
export interface SpawnChannel {
    send(frame: SpawnFrame): void;
    onFrame(listener: (frame: SpawnFrame) => void): void;
    /** The other side is gone (the child exited, or the parent disconnected). */
    onClose(listener: (reason: string) => void): void;
}

/** The child's own end: its `process` (forked with an IPC channel). */
export function processChannel(proc: Pick<NodeJS.Process, 'send' | 'on' | 'connected'>): SpawnChannel {
    return {
        send: (frame) => { if (proc.connected) proc.send?.(frame); },
        onFrame: (listener) => { proc.on('message', (m: unknown) => { const f = parseSpawnFrame(m); if (f) listener(f); }); },
        onClose: (listener) => { proc.on('disconnect', () => listener('the parent disconnected')); },
    };
}
