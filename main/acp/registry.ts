import type { AgentEngine } from '../agents/engine';

/**
 * The seam that makes an ACP session a first-class Genie agent.
 *
 * `isTerminalLive` is imported by the roster, the agent cap, drain, triage,
 * `savedAgentsOf` and `runAgent`. An ACP session has no pty, so without this it reads as
 * DEAD in all of them at once — and that is not cosmetic: drain would let an upgrade
 * proceed over a working agent, and triage would prescribe a restart for something that
 * is running perfectly.
 *
 * Teaching ONE function about ACP is what lets the other seventy-odd call sites stay
 * exactly as they are.
 */

export interface AcpSessionEntry {
    /** Stop the child. */
    kill: () => void;
    /** Whether the JSON-RPC channel has gone. */
    closed: boolean;
}

export class AcpRegistry {
    private readonly sessions = new Map<string, AcpSessionEntry>();

    /**
     * Hold a session against its terminal spec id.
     *
     * Registering over an existing id KILLS the previous child. Spec ids are reused across
     * restarts on purpose — that reuse is what carries an agent's AgentInbox identity and
     * queued mail — so two entries for one id would leak the first process with nothing
     * holding a handle to it.
     */
    register(specId: string, entry: AcpSessionEntry): void {
        const existing = this.sessions.get(specId);
        if (existing) existing.kill();
        this.sessions.set(specId, entry);
    }

    unregister(specId: string): void {
        this.sessions.delete(specId);
    }

    /**
     * Live means registered AND the channel still open.
     *
     * A registered entry whose channel died is not live — reporting otherwise hides a dead
     * agent behind a healthy-looking roster row, which is the shape of confident wrongness
     * this model exists to avoid.
     */
    isLive(specId: string): boolean {
        const entry = this.sessions.get(specId);
        return entry !== undefined && !entry.closed;
    }

    liveSpecIds(): string[] {
        return [...this.sessions.entries()].filter(([, e]) => !e.closed).map(([id]) => id);
    }

    /** Stop and forget. Safe for an id it is not holding, because teardown paths cannot
     *  know which engine an agent used. */
    stop(specId: string): void {
        const entry = this.sessions.get(specId);
        this.sessions.delete(specId);
        entry?.kill();
    }
}

/** The one live ACP registry. */
export const acpRegistry = new AcpRegistry();

export interface LivenessPorts {
    ptyLive: (specId: string) => boolean;
    acpLive: (specId: string) => boolean;
}

/**
 * Whether an agent terminal is live under EITHER engine.
 *
 * The pty is asked first: it is the overwhelmingly common case today, and
 * short-circuiting keeps the added cost at zero for every existing agent.
 */
export function terminalIsLive(specId: string, ports: LivenessPorts): boolean {
    return ports.ptyLive(specId) || ports.acpLive(specId);
}

/**
 * Why a keystroke write cannot go to this engine, or null when it can.
 *
 * An ACP session has no input box to type into. A silent no-op would look exactly like
 * the agent ignoring the message — the failure `submit.ts` was built to detect and could
 * still only describe as "we could not check". Here it can be said plainly, and the
 * message names the thing to do instead.
 */
export function writeRefusal(engine: AgentEngine): string | null {
    if (engine === 'pty') return null;
    return 'This agent runs as a structured ACP session, so there is no terminal to type into. Send it a prompt instead.';
}
