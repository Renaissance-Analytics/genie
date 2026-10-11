/**
 * TERMINALS — for shells, builds, services and hosted sites. **No agent has one.**
 *
 * This file exists to make that sentence enforceable rather than merely true today. The
 * previous build's failure was not a decision, it was an ORDER: `createAgentTerminal` spawned
 * a pty unconditionally about seventy lines *before* anything decided which engine an agent
 * would use, so removing the pty *engine* changed nothing a user could see — agents still held
 * ptys and still read `claude · pty` on screen.
 *
 * Three layers keep it from coming back, and none of them is "we were careful":
 *
 *  1. **The type system.** `AgentEngine` has one member, so "agent on a pty" does not compile.
 *  2. **The shape of this API.** {@link TerminalOptions} takes a workspace and a command. There
 *     is no agent parameter, so "a terminal for this agent" cannot be *expressed* — the same
 *     reasoning as `railIsCollapsed` taking only a width.
 *  3. **A counted test.** `test/no-agent-pty.test.ts` starts every provider and counts the
 *     ptys, with a positive control proving a plain terminal still spawns exactly one.
 *
 * ## The port is the seam
 *
 * The real engine is `fancy-term-host` — in-kit, with `node-pty` as its declared peer — and
 * `fancy-term-port.ts` adapts it to {@link PtyPort}. Nothing in this file knows what a pty is.
 * That keeps the no-agent rule provable without spawning anything, and keeps the engine
 * replaceable: snapshot replay, retained ptys, the detached host and the OSC-7 cwd hook are
 * the package's job, not Genie's.
 */

export interface PtySpawnOptions {
    cwd: string;
    /**
     * What to run. **Absent means the user's own login shell**, resolved by the engine.
     *
     * Optional because `+terminal` is the common case and names no command. A required
     * command would make the ordinary thing the special case and force a default to be
     * invented here — which is how a build ends up spawning `/bin/sh` for somebody whose
     * shell is fish.
     */
    command?: string | undefined;
    cols?: number | undefined;
    rows?: number | undefined;
    /**
     * Extra environment for a SUPERVISED process or a site's server (§6.6) — the service env a
     * queue worker needs to reach the managed database. Merged over the user's environment by
     * the engine. Absent for a plain shell.
     */
    env?: Readonly<Record<string, string>> | undefined;
}

/** A live pty, as the engine reports it. */
export interface PtyOpened {
    id: string;
    pid: number;
    shell: string;
    /** Bounded history, so a window joining a running build sees what it missed. */
    scrollback: string;
}

/**
 * What Genie asks of a pty engine.
 *
 * Deliberately smaller than `fancy-term-host`'s own `PtyBackend`: retained ptys, the detached
 * host and snapshot encryption are the package's concerns, and naming them here would invite
 * Genie to reimplement them.
 */
export interface PtyPort {
    /** Spawn, or rejoin an existing pty. */
    open(options: PtySpawnOptions): PtyOpened;
    write(id: string, data: string): boolean;
    resize(id: string, cols: number, rows: number): boolean;
    kill(id: string): boolean;
    scrollback(id: string): string | undefined;
    /** Subscribe to output. Returns an unsubscribe. */
    onData(listener: (id: string, data: string) => void): () => void;
    /** Subscribe to a pty ending on its own. Returns an unsubscribe. */
    onExit(listener: (id: string, exitCode: number) => void): () => void;
    /** Subscribe to the shell's working directory, as the engine learns it (OSC-7). Optional: an engine without it tracks nothing. */
    onCwd?(listener: (id: string, cwd: string) => void): () => void;
}

export interface TerminalOptions {
    /**
     * The workspace this terminal belongs to.
     *
     * **A workspace, never an agent.** There is no `agentId` here and there will not be one:
     * the absence is this API's half of the one rule.
     */
    workspaceId: string;
    cwd: string;
    command?: string | undefined;
    cols?: number | undefined;
    rows?: number | undefined;
    /** Extra environment: the Take Over contract (GENIE_MCP_URL / GENIE_TERMINAL_ID / GENIE_MCP_TOKEN) or a site's service env. */
    env?: Readonly<Record<string, string>> | undefined;
}

export interface Terminal {
    id: string;
    workspaceId: string;
    pid: number;
    shell: string;
    /** The shell's working directory as last reported (OSC-7), or absent when never reported. */
    cwd?: string;
    /** When the cwd was last reported — the newest wins for `lastCwd`. */
    cwdAt?: number;
}

export class TerminalHost {
    readonly #pty: PtyPort;
    #terminals: Terminal[] = [];
    readonly #dataListeners = new Set<(id: string, data: string) => void>();
    readonly #exitListeners = new Set<(id: string, exitCode: number) => void>();
    #cwdClock = 0;

    constructor(pty: PtyPort) {
        this.#pty = pty;

        this.#pty.onData((id, data) => {
            for (const listener of this.#dataListeners) listener(id, data);
        });

        this.#pty.onCwd?.((id, cwd) => {
            // A report for a terminal this host does not know is ignored, not a throw.
            this.#terminals = this.#terminals.map((t) => (t.id === id ? { ...t, cwd, cwdAt: ++this.#cwdClock } : t));
        });

        this.#pty.onExit((id, exitCode) => {
            /*
             * FORGET IT FIRST, then tell anybody watching.
             *
             * A shell that ends on its own — `exit`, a build finishing, a crash — has to leave
             * the list, or the count keeps a dead terminal in it forever and `closeWorkspace`
             * later tries to kill something that is already gone. Removing it before the
             * listeners run means a listener that asks `list()` sees the truth rather than the
             * state from a moment ago.
             */
            this.#terminals = this.#terminals.filter((t) => t.id !== id);
            for (const listener of this.#exitListeners) listener(id, exitCode);
        });
    }

    /** How many terminals are open. **Never** a source for agent capacity. */
    get count(): number {
        return this.#terminals.length;
    }

    list(): readonly Terminal[] {
        return this.#terminals;
    }

    /** The workspace's most recently reported shell directory (§6.5 cwd resume), or `null` — never a guess. */
    lastCwd(workspaceId: string): string | null {
        const reported = this.#terminals.filter((t) => t.workspaceId === workspaceId && t.cwd !== undefined);
        if (reported.length === 0) return null;
        return reported.reduce((a, b) => ((a.cwdAt ?? 0) >= (b.cwdAt ?? 0) ? a : b)).cwd ?? null;
    }

    open(options: TerminalOptions): PtyOpened {
        const opened = this.#pty.open({
            cwd: options.cwd,
            command: options.command,
            ...(options.cols === undefined ? {} : { cols: options.cols }),
            ...(options.rows === undefined ? {} : { rows: options.rows }),
            ...(options.env === undefined ? {} : { env: options.env }),
        });

        this.#terminals = [
            ...this.#terminals,
            { id: opened.id, workspaceId: options.workspaceId, pid: opened.pid, shell: opened.shell },
        ];
        return opened;
    }

    /**
     * Every one of these answers `false` for an id it does not have, rather than throwing.
     *
     * A renderer holding a stale id is ordinary — a window that was open when the terminal
     * closed. `false` is something it can act on; a throw from an IPC handler is an unhandled
     * rejection in the main process.
     */
    write(id: string, data: string): boolean {
        if (!this.#has(id)) return false;
        return this.#pty.write(id, data);
    }

    resize(id: string, cols: number, rows: number): boolean {
        if (!this.#has(id)) return false;
        return this.#pty.resize(id, cols, rows);
    }

    scrollback(id: string): string | undefined {
        if (!this.#has(id)) return undefined;
        return this.#pty.scrollback(id);
    }

    close(id: string): boolean {
        if (!this.#has(id)) return false;

        this.#pty.kill(id);
        this.#terminals = this.#terminals.filter((t) => t.id !== id);
        return true;
    }

    /**
     * Close every terminal in one workspace, and nothing outside it.
     *
     * Hibernating a workspace stops its work; it must not reach into another's. The same
     * scoping discipline as `killTree` taking only this session's own pids — on a machine
     * running a dozen agents, the difference is stopping one thing or stopping the room.
     */
    closeWorkspace(workspaceId: string): number {
        const mine = this.#terminals.filter((t) => t.workspaceId === workspaceId);
        for (const terminal of mine) this.#pty.kill(terminal.id);
        this.#terminals = this.#terminals.filter((t) => t.workspaceId !== workspaceId);
        return mine.length;
    }

    /**
     * Close everything, for a real quit or an upgrade.
     *
     * §7.1: an upgrade jammed on 31 orphaned `OpenConsole.exe` processes with no error message
     * at all, because nothing reaped what the app had spawned.
     */
    closeAll(): number {
        const all = this.#terminals;
        for (const terminal of all) this.#pty.kill(terminal.id);
        this.#terminals = [];
        return all.length;
    }

    /** Subscribe to output from any terminal. Returns an unsubscribe. */
    onData(listener: (id: string, data: string) => void): () => void {
        this.#dataListeners.add(listener);
        return () => this.#dataListeners.delete(listener);
    }

    /** Subscribe to any terminal ending. Returns an unsubscribe. */
    onExit(listener: (id: string, exitCode: number) => void): () => void {
        this.#exitListeners.add(listener);
        return () => this.#exitListeners.delete(listener);
    }

    #has(id: string): boolean {
        return this.#terminals.some((t) => t.id === id);
    }
}
