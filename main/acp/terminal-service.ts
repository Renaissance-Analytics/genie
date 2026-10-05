/**
 * Serving `terminal/*` — the requests where the AGENT asks the CLIENT to run a command.
 *
 * This is the keystone of "demote the terminal, do not delete it". Genie already owns the
 * best pty host of anything in this space; ACP's terminal methods mean that host stops
 * being the agent's *interface* and becomes the agent's *tool*. Nothing is thrown away —
 * the thing a person can watch and take over is now the thing the agent reaches for.
 *
 * ## What it refuses
 *
 * **A cwd outside the agent's workspace.** The agent names it, so it is untrusted input,
 * and an agent that wanders out of its workspace is running commands somewhere nobody
 * agreed to.
 *
 * **An unknown terminal id.** Answered with an error rather than an empty success: a
 * silent empty output reads as "the command produced nothing", which is a lie about
 * something that never ran.
 *
 * ## What it reports honestly
 *
 * The output ring is 256 KiB and drops the oldest bytes. The protocol has a `truncated`
 * flag for exactly this, so it is set from the ring rather than hidden — an agent reading
 * a silently-trimmed build log would draw conclusions from evidence that is missing its
 * beginning.
 *
 * Output is returned RAW. `stripAnsi` is lossy by design and exists for display; handing a
 * mangled approximation to something that parses output would be worse than handing it
 * escapes it can ignore.
 */

/** A pty this service created for an agent. */
export interface ToolTerminal {
    /** The Genie terminal spec id. */
    specId: string;
}

export interface TerminalPorts {
    /** Create a pty. Returns the Genie spec id. */
    create: (opts: {
        command: string;
        args: readonly string[];
        env: Record<string, string>;
        cwd: string;
        /** The agent this terminal belongs to, for `meta.acp_tool_of`. */
        ownerSpecId: string;
    }) => string;
    /** Everything written since the given cursor, plus whether the ring dropped bytes. */
    readSince: (specId: string, cursor: number) => { data: string; cursor: number; truncated: boolean };
    kill: (specId: string) => void;
    /** Remove the spec entirely. */
    remove: (specId: string) => void;
    /** Resolves when the pty exits. */
    waitForExit: (specId: string) => Promise<{ exitCode: number | null; signal: string | null }>;
    /** The workspace root an agent is confined to. */
    workspaceRoot: (ownerSpecId: string) => string | null;
    /** Whether `child` is inside `root`. Injected because path containment differs by
     *  platform and is its own decision. */
    isInside: (root: string, child: string) => boolean;
}

export interface CreateParams {
    command: string;
    args?: readonly string[];
    env?: ReadonlyArray<{ name: string; value: string }>;
    cwd?: string;
}

export class AcpTerminalService {
    /** terminalId → spec id and read cursor. */
    private readonly open = new Map<string, { specId: string; cursor: number }>();
    private nextId = 1;

    constructor(
        private readonly ownerSpecId: string,
        private readonly ports: TerminalPorts,
    ) {}

    create(params: CreateParams): { terminalId: string } {
        const root = this.ports.workspaceRoot(this.ownerSpecId);
        if (!root) throw new Error('this agent has no workspace, so it cannot run a terminal');

        // The agent names the cwd, so it is untrusted. Defaulting to the root is right;
        // escaping it is refused — an agent running commands outside its workspace is
        // operating somewhere nobody agreed to.
        const cwd = params.cwd ?? root;
        if (!this.ports.isInside(root, cwd)) {
            throw new Error(`cwd ${cwd} is outside this agent's workspace`);
        }

        const env: Record<string, string> = {};
        for (const e of params.env ?? []) env[e.name] = e.value;

        const specId = this.ports.create({
            command: params.command,
            args: params.args ?? [],
            env,
            cwd,
            ownerSpecId: this.ownerSpecId,
        });

        const terminalId = `acp-term-${this.nextId++}`;
        this.open.set(terminalId, { specId, cursor: 0 });
        return { terminalId };
    }

    output(terminalId: string): { output: string; truncated: boolean } {
        const entry = this.require(terminalId);
        // Cursor-addressed, so each call returns only what is new — the same contract
        // `terminal/output` describes, and the reason the ring keeps a cursor at all.
        const read = this.ports.readSince(entry.specId, entry.cursor);
        entry.cursor = read.cursor;
        return {
            // RAW. stripAnsi is lossy and for display; a parser is better served by
            // escapes it can ignore than by a mangled approximation.
            output: read.data,
            // Reported, not hidden. An agent reading a silently-trimmed build log draws
            // conclusions from evidence missing its beginning.
            truncated: read.truncated,
        };
    }

    kill(terminalId: string): void {
        this.ports.kill(this.require(terminalId).specId);
    }

    async waitForExit(terminalId: string): Promise<{ exitCode: number | null; signal: string | null }> {
        return this.ports.waitForExit(this.require(terminalId).specId);
    }

    /** Kill and forget. `release` is the agent saying it is finished with this terminal. */
    release(terminalId: string): void {
        const entry = this.require(terminalId);
        this.open.delete(terminalId);
        this.ports.kill(entry.specId);
        this.ports.remove(entry.specId);
    }

    /** Every pty this agent still holds, so teardown can reap them. */
    liveSpecIds(): string[] {
        return [...this.open.values()].map((e) => e.specId);
    }

    private require(terminalId: string): { specId: string; cursor: number } {
        const entry = this.open.get(terminalId);
        // An error, not an empty success: a silent empty output reads as "the command
        // produced nothing", which is a lie about something that never ran.
        if (!entry) throw new Error(`unknown terminal ${terminalId}`);
        return entry;
    }
}
