/**
 * TERMINALS — for shells, builds, services and hosted sites. **No agent has one.**
 *
 * This file exists to make that sentence enforceable rather than merely true today. The
 * previous build's failure was not a decision, it was an ORDER: `createAgentTerminal` spawned
 * a pty unconditionally about seventy lines *before* anything decided which engine an agent
 * would use, so removing the pty engine changed nothing a user could see — agents still held
 * ptys and still read `claude · pty` on screen.
 *
 * Three layers keep it from coming back, and none of them is "we were careful":
 *
 *  1. **The type system.** `AgentEngine` has one member, so "agent on a pty" does not compile.
 *  2. **The shape of this API.** `open` takes a workspace and a command. There is no agent
 *     parameter, so "a terminal for this agent" cannot be *expressed* — the same reasoning as
 *     `railIsCollapsed` taking only a width.
 *  3. **A counted test.** `test/no-agent-pty.test.ts` starts every provider and counts the
 *     ptys, with a positive control proving a plain terminal still spawns exactly one.
 *
 * ## The port is narrow because it is the seam
 *
 * The real engine is `fancy-term-host` — in-kit, with `node-pty` as its declared peer — and it
 * lands with P5 along with multi-attach, scrollback replay, snapshots and the rest. What is
 * here is the boundary that rule 2 is enforced at, injected so a test can prove no pty was
 * asked for without spawning one to find out.
 */

export interface PtySpawnOptions {
    cwd: string;
    command: string;
}

/** The one thing Genie asks of a pty engine. Deliberately four lines wide. */
export interface PtyPort {
    /** Returns an opaque id for the spawned pty. */
    spawn(options: PtySpawnOptions): string;
    kill(id: string): void;
}

export interface TerminalOptions {
    /**
     * The workspace this terminal belongs to.
     *
     * **A workspace, never an agent.** There is no `agentId` here and there will not be one:
     * the absence is the API's half of the one rule.
     */
    workspaceId: string;
    cwd: string;
    command: string;
}

interface Terminal {
    id: string;
    workspaceId: string;
}

export class TerminalHost {
    readonly #pty: PtyPort;
    #terminals: Terminal[] = [];

    constructor(pty: PtyPort) {
        this.#pty = pty;
    }

    /** How many terminals are open. **Never** a source for agent capacity. */
    get count(): number {
        return this.#terminals.length;
    }

    open(options: TerminalOptions): string {
        const id = this.#pty.spawn({ cwd: options.cwd, command: options.command });
        this.#terminals = [...this.#terminals, { id, workspaceId: options.workspaceId }];
        return id;
    }

    close(id: string): boolean {
        const found = this.#terminals.some((t) => t.id === id);
        if (!found) return false;

        this.#pty.kill(id);
        this.#terminals = this.#terminals.filter((t) => t.id !== id);
        return true;
    }

    /**
     * Close every terminal in one workspace, and nothing outside it.
     *
     * Hibernating a workspace stops its work; it must not reach into another one's. The same
     * scoping discipline as `killTree` taking only this session's own pids — on a machine
     * running a dozen agents, the difference is stopping one thing or stopping the room.
     */
    closeWorkspace(workspaceId: string): number {
        const mine = this.#terminals.filter((t) => t.workspaceId === workspaceId);
        for (const terminal of mine) this.#pty.kill(terminal.id);
        this.#terminals = this.#terminals.filter((t) => t.workspaceId !== workspaceId);
        return mine.length;
    }
}
