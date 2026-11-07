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

/** v1 was implicit. v2 carries authoritative UTF-16 positions and producer epochs. */
export const SPAWN_PROTOCOL = 2;
export const SPAWN_METHODS = ['host.env', 'spawn.exec', 'spawn.stream', 'spawn.unstream', 'pty.open', 'pty.write', 'pty.resize', 'pty.kill', 'pty.list', 'spawn.unstreamAll', 'host.shutdown'] as const;
export type SpawnMethod = (typeof SPAWN_METHODS)[number];

/**
 * WHAT A PTY IS TO THE WINDOW that opened it (the host split, P2.1): given at `pty.open` (its third argument) and kept by
 * the spawn host, so a NEW window — the spawn host outlives the window under genie-host — can find what is still running
 * and take it back (`pty.list`) instead of starting it twice.
 */
export type PtyTag =
    | { readonly kind: 'process'; readonly processId: string; readonly workspaceId: string }
    // `disposable`: a throwaway terminal (Tynn story #378) — never adopted; it ends with its window.
    | { readonly kind: 'terminal'; readonly workspaceId: string; readonly shell: string; readonly disposable?: true };

/** One live pty, as `pty.list` answers it. `tag` is null for a pty opened without one. */
export interface ListedPty {
    readonly id: string;
    readonly pid: number;
    readonly tag: PtyTag | null;
    /** The shell the engine started (resolved: the default shell has its real name here). Absent from an older host. */
    readonly shell?: string;
    readonly scrollback: string;
    /** Missing on an older producer: unknown, never inferred from scrollback.length. */
    readonly epoch?: string;
    readonly endOffset?: number;
}

// `pty.cwd {id, cwd}`: an interactive terminal's working directory as its shell reports it (OSC-7), for the cwd resume.
export const SPAWN_EVENTS = ['host.ready', 'pty.opened', 'pty.data', 'pty.exit', 'pty.cwd', 'stream.line', 'stream.end'] as const;
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
