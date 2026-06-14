import type { CreateTerminalOpts, TerminalInfo, AttachResult } from './types';

/**
 * PtyBackend — the abstraction the IPC layer (main/terminal/ipc.ts), Tier 1
 * (snapshots) and Tier 2 (retained set) talk to, instead of talking to a
 * concrete pty pool directly.
 *
 * Two implementations:
 *
 *   • InProcessBackend (the TerminalManager singleton) — node-pty instances live
 *     IN the Electron main process. This is today's behaviour and the T1/T2
 *     floor: snapshots survive a full quit, retained ptys survive a window
 *     detach (but die on a real quit, degrading to T1 snapshots).
 *
 *   • HostClient (Tier 3) — node-pty instances live in a DETACHED headless
 *     pty-host process. The backend proxies every call over a local socket; the
 *     ptys (and the host's own scrollback ring buffer) SURVIVE A FULL QUIT of
 *     the Electron app, so reopening reattaches to the still-running shells.
 *
 * ipc.ts is oblivious to which one it holds: same method names, same shapes,
 * same data/exit event subscription. The active backend is chosen once at
 * startup (selectBackend, see manager.ts) and swapped behind this interface.
 *
 * The data/exit subscription mirrors EventEmitter semantics so the InProcess
 * backend can BE an EventEmitter and satisfy this for free, while HostClient
 * fans host-pushed messages out to the same callback shape.
 */
export interface PtyBackend {
    /** Spawn (or rejoin an existing) pty for opts.id. */
    create(opts: CreateTerminalOpts): AttachResult;
    write(id: string, data: string): boolean;
    resize(id: string, cols: number, rows: number): boolean;
    /** Explicit kill (user delete). Clears retained flag + scrollback. */
    kill(id: string): boolean;
    /** Tear down every pty. Called on a real quit for the in-process backend;
     *  a NO-OP for the host client (the whole point of T3 is they survive). */
    killAll(): void;
    list(): TerminalInfo[];
    isLive(id: string): boolean;

    // Tier 2 — retained (disabled-not-deleted) -----------------------------
    setRetained(id: string, retained: boolean): void;
    isRetained(id: string): boolean;
    retainedCount(): number;
    retainedIds(): string[];
    getScrollback(id: string): string | undefined;

    // Events ---------------------------------------------------------------
    /** Subscribe to pushed pty output. */
    on(event: 'data', listener: (id: string, data: string) => void): this;
    /** Subscribe to pty exit. */
    on(
        event: 'exit',
        listener: (id: string, payload: { exitCode: number; signal?: number }) => void,
    ): this;
}
