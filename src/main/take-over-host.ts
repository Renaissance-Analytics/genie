import type { AgentId, AgentRecord } from '../core/identity.js';
import { type Burst, type TakeOverProbe } from '../core/observed.js';
import { randomUUID } from 'node:crypto';
import { takeOverEnv } from '../core/take-over-env.js';
import type { TerminalsApi } from './terminals-host.js';

/**
 * TAKE OVER — §1, the only TUI support there is:
 *
 * > **Take Over** opens a terminal **in a new window** running whatever TUI the user chooses.
 * > That window is a separate, new session — it never attaches a managed agent to a pty; it is
 * > **not managed by Genie** — Genie does not start it, stop it, restart it or revive it; and
 * > it is visible as an **Observed row** so the user can see it exists.
 *
 * This host does exactly the click: it asks `TerminalHost` for a terminal in the agent's
 * WORKSPACE running the TUI, opens a window on it, and then only WATCHES — bytes and when. The
 * link from agent to terminal lives in this host's own map, for the Observed row, and nowhere
 * else: nothing with an `agentId` reaches the terminal host or the pty port, which
 * `test/take-over-host.test.ts` counts.
 *
 * ## What "not managed" means in code
 *
 * There is no `stop`, `restart` or `revive` on this class, on purpose — what cannot be
 * expressed cannot be done by a later refactor. When the TUI exits the take-over simply ends;
 * when the window closes the terminal is closed, because the window IS the session.
 *
 * ## What is NOT here yet, said plainly
 *
 * §1 says the TUI gets "Genie's MCP available in it". genie2 has no MCP server yet (§6.9's
 * loopback server is not built), so no `GENIE_MCP_URL` is set — not a fake one, not a stale
 * one. The TUI runs without Genie's tools until that server exists.
 */

export interface TakeOverOptions {
    terminals: Pick<TerminalsApi, 'open' | 'close' | 'onData' | 'onExit'>;
    /** Open (or re-open — the opener decides whether that means focus) a window on a route. */
    openWindow: (route: string) => void;
    clock?: () => number;
    /**
     * The Genie MCP server, when one is running: its loopback URL and this process's bearer token.
     * `null` means no server — and then NO environment is set, not a fake URL, not a stale one.
     * The TUI reads GENIE_MCP_URL / GENIE_MCP_TOKEN / GENIE_TERMINAL_ID from its environment.
     */
    mcp?: (() => { mcpUrl: string; token: string } | null) | undefined;
}

interface Live {
    terminalId: string;
    startedAt: number;
    lastOutputAt: number | null;
    bursts: Burst[];
}

/** How many bursts to remember. A minute of bars needs twelve; this is ten minutes at 1 Hz. */
const BURSTS_KEPT = 600;

export class TakeOverHost {
    readonly #terminals: TakeOverOptions['terminals'];
    readonly #listeners = new Set<() => void>();
    readonly #openWindow: (route: string) => void;
    readonly #clock: () => number;
    readonly #mcp: () => { mcpUrl: string; token: string } | null;
    /** GENIE_TERMINAL_ID values this host minted, back to the agent they were minted for. */
    readonly #callers = new Map<string, { agentId: AgentId; agentName: string; workspaceId: string; workspacePath: string }>();
    readonly #live = new Map<AgentId, Live>();

    constructor(options: TakeOverOptions) {
        this.#terminals = options.terminals;
        this.#openWindow = options.openWindow;
        this.#clock = options.clock ?? (() => Date.now());
        this.#mcp = options.mcp ?? (() => null);

        // Every terminal's output arrives here; only a take-over's is an agent's activity. A
        // build somebody ran in the workspace panel must not draw bars on an agent's row.
        this.#terminals.onData((id, data) => {
            const entry = this.#byTerminal(id);
            if (!entry) return;
            const at = this.#clock();
            entry.lastOutputAt = at;
            entry.bursts.push({ at, bytes: data.length });
            if (entry.bursts.length > BURSTS_KEPT) entry.bursts.splice(0, entry.bursts.length - BURSTS_KEPT);
            this.#changed();
        });

        // The TUI ended. The take-over simply ends with it — no restart, no revive, no fault.
        this.#terminals.onExit((id) => {
            for (const [agentId, entry] of this.#live) {
                if (entry.terminalId === id) { this.#live.delete(agentId); this.#changed(); }
            }
        });
    }

    /**
     * The click. Opens the TUI in a terminal in the agent's workspace and a window on it.
     *
     * One take-over per agent: a second click re-opens the window (focus) rather than starting
     * a second TUI on the same persona. AGENT.md names no provider (Tynn story #380): nothing in
     * it refuses a Take Over.
     */
    /**
     * `window: false` (Tynn #529 part A): the click came from ANOTHER machine, whose own Take Over window attaches to this
     * terminal over the link — no window here. `started` then says whether this click started the TUI (the remote window
     * may end it) or found one already open (not its to end).
     */
    start(record: AgentRecord, cwd: string, tui: string, options: { window?: boolean } = {}): { ok: true; terminalId: string; started?: boolean } | { ok: false; reason: string } {
        const window = options.window !== false;
        const existing = this.#live.get(record.id);
        if (existing) {
            if (window) this.#openWindow(`genie://takeover/${existing.terminalId}`);
            return window ? { ok: true, terminalId: existing.terminalId } : { ok: true, terminalId: existing.terminalId, started: false };
        }

        // The attribution id the TUI will pass as `terminalId` on every tool call. Minted HERE, before
        // the pty exists, because the environment must be in place at spawn; the pty's own id is a
        // different key and stays the terminal host's. This host is the one place that maps the two.
        const mcp = this.#mcp();
        const callerId = `takeover_${randomUUID()}`;
        const env = mcp === null ? undefined : takeOverEnv({ mcpUrl: mcp.mcpUrl, token: mcp.token, terminalId: callerId });
        // A WORKSPACE terminal. There is no agent parameter to pass, which is the point.
        const opened = this.#terminals.open({ workspaceId: record.workspaceId, cwd, command: tui, personal: true, limited: false, ...(env === undefined ? {} : { env }) });
        if (env !== undefined) this.#callers.set(callerId, { agentId: record.id, agentName: record.name, workspaceId: record.workspaceId, workspacePath: cwd });
        this.#live.set(record.id, { terminalId: opened.id, startedAt: this.#clock(), lastOutputAt: null, bursts: [] });
        this.#changed();
        if (!window) return { ok: true, terminalId: opened.id, started: true };
        this.#openWindow(`genie://takeover/${opened.id}`);
        return { ok: true, terminalId: opened.id };
    }

    /** Who a GENIE_TERMINAL_ID this host minted belongs to — the MCP tools' `resolveCaller`. `null` for any other id. */
    callerFor(terminalId: string): { agentId: AgentId; agentName: string; workspaceId: string; workspacePath: string } | null {
        return this.#callers.get(terminalId) ?? null;
    }

    /** Every Take Over terminal's caller (the host split, P3.1): genie-host resolves these agents' calls to its tools. */
    callers(): Record<string, { agentId: AgentId; agentName: string; workspaceId: string; workspacePath: string }> {
        return Object.fromEntries(this.#callers);
    }

    /** What is known about this agent's TUI, or `null` — never a fake Observed row. */
    probe(agentId: AgentId): TakeOverProbe | null {
        const entry = this.#live.get(agentId);
        if (!entry) return null;
        return { terminalId: entry.terminalId, startedAt: entry.startedAt, lastOutputAt: entry.lastOutputAt, bursts: [...entry.bursts] };
    }

    /** The user closed the window. The window IS the session, so the terminal goes with it. */
    windowClosed(terminalId: string): void {
        for (const [agentId, entry] of this.#live) {
            if (entry.terminalId !== terminalId) continue;
            this.#live.delete(agentId);
            this.#terminals.close(terminalId);
            this.#changed();
        }
    }

    /** Every open TUI, as {@link probe} reads each. */
    live(): Record<string, TakeOverProbe> {
        return Object.fromEntries([...this.#live.keys()].map((id) => [id, this.probe(id)!]));
    }

    /** Something a reader would see changed: a TUI started or ended, or one printed. */
    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #changed(): void {
        for (const listener of this.#listeners) listener();
    }

    #byTerminal(terminalId: string): Live | null {
        for (const entry of this.#live.values()) {
            if (entry.terminalId === terminalId) return entry;
        }
        return null;
    }
}
