import type { AgentId, AgentRecord } from '../core/identity.js';
import { type Burst, type TakeOverProbe } from '../core/observed.js';
import type { TerminalHost } from './terminal-host.js';

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
    terminals: TerminalHost;
    /** Open (or re-open — the opener decides whether that means focus) a window on a route. */
    openWindow: (route: string) => void;
    clock?: () => number;
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
    readonly #terminals: TerminalHost;
    readonly #openWindow: (route: string) => void;
    readonly #clock: () => number;
    readonly #live = new Map<AgentId, Live>();

    constructor(options: TakeOverOptions) {
        this.#terminals = options.terminals;
        this.#openWindow = options.openWindow;
        this.#clock = options.clock ?? (() => Date.now());

        // Every terminal's output arrives here; only a take-over's is an agent's activity. A
        // build somebody ran in the workspace panel must not draw bars on an agent's row.
        this.#terminals.onData((id, data) => {
            const entry = this.#byTerminal(id);
            if (!entry) return;
            const at = this.#clock();
            entry.lastOutputAt = at;
            entry.bursts.push({ at, bytes: data.length });
            if (entry.bursts.length > BURSTS_KEPT) entry.bursts.splice(0, entry.bursts.length - BURSTS_KEPT);
        });

        // The TUI ended. The take-over simply ends with it — no restart, no revive, no fault.
        this.#terminals.onExit((id) => {
            for (const [agentId, entry] of this.#live) {
                if (entry.terminalId === id) this.#live.delete(agentId);
            }
        });
    }

    /**
     * The click. Opens the TUI in a terminal in the agent's workspace and a window on it.
     *
     * One take-over per agent: a second click re-opens the window (focus) rather than starting
     * a second TUI on the same persona. A persona that lists `tuis:` and does not name the
     * requested one is REFUSED — §6.2's rule for switching driver, which this is by another
     * name — with the TUI named so the reader knows what to edit.
     */
    start(
        record: AgentRecord,
        cwd: string,
        tui: string,
        persona: { tuis?: readonly string[] | undefined } = {},
    ): { ok: true; terminalId: string } | { ok: false; reason: string } {
        if (persona.tuis && !persona.tuis.includes(tui)) {
            return {
                ok: false,
                reason: `${record.name}'s AGENT.md lists tuis: [${persona.tuis.join(', ')}] and "${tui}" is not among them.`,
            };
        }

        const existing = this.#live.get(record.id);
        if (existing) {
            this.#openWindow(`genie://takeover/${existing.terminalId}`);
            return { ok: true, terminalId: existing.terminalId };
        }

        // A WORKSPACE terminal. There is no agent parameter to pass, which is the point.
        const opened = this.#terminals.open({ workspaceId: record.workspaceId, cwd, command: tui });
        this.#live.set(record.id, { terminalId: opened.id, startedAt: this.#clock(), lastOutputAt: null, bursts: [] });
        this.#openWindow(`genie://takeover/${opened.id}`);
        return { ok: true, terminalId: opened.id };
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
        }
    }

    #byTerminal(terminalId: string): Live | null {
        for (const entry of this.#live.values()) {
            if (entry.terminalId === terminalId) return entry;
        }
        return null;
    }
}
