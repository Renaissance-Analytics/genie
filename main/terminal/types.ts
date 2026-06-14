/**
 * Shared terminal-subsystem types.
 *
 * Lifted out of manager.ts so both the in-process manager and the Tier 3
 * HostClient (which proxies the same shapes over a socket) can reference them
 * without a circular import through the PtyBackend interface.
 */

export interface CreateTerminalOpts {
    /** Stable id chosen by the renderer (ulid). The manager uses it as the key. */
    id: string;
    /** Working directory for the spawned shell. */
    cwd: string;
    /** Shell executable. Defaults to the user's preferred login shell per platform. */
    shell?: string;
    /** Extra args for the shell. */
    args?: string[];
    /** Initial cols × rows. Renderer should send a `resize` immediately after mount. */
    cols?: number;
    rows?: number;
    /** Extra env overrides. Merged on top of process.env. */
    env?: Record<string, string>;
}

export interface TerminalInfo {
    id: string;
    pid: number;
    shell: string;
}

export interface AttachResult extends TerminalInfo {
    /** True when an existing pty was returned (caller is "joining"). */
    existing: boolean;
    /** Bounded scrollback so a late-joining window can replay history. */
    scrollback: string;
    /**
     * A previous-session snapshot to replay, present ONLY on a COLD spawn that
     * found a snapshot on disk. On a warm reattach this is omitted — the live
     * scrollback already covers the history. The renderer frames it as
     * "— previous session —" then resets before the fresh shell.
     */
    snapshot?: { serialized: string; savedAt: number };
}
