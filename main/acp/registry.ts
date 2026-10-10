import type { AgentEngine } from '../agents/engine';
import type { PermissionDecision } from './permission';
import type { DriverCapabilities } from './session';

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
    /**
     * Send the agent a prompt.
     *
     * Held HERE because the registry is already the one thing that knows an agent is an ACP
     * session — the same reason `isLive` lives here. Without it `AcpSessionDriver.prompt()`
     * had no production caller, so a session could be started and observed and never talked
     * to, and `writeRefusal` had no caller either, so a write went to a pty that was not
     * there and reported nothing at all.
     *
     * Survivable while ACP was opt-in. Not survivable now that it is the mechanism: every
     * Claude agent takes this path.
     */
    prompt: (text: string) => Promise<{ delivered: boolean; submitted: boolean }>;
    /**
     * Ask the agent to stop the turn.
     *
     * `session/cancel` only ASKS — the protocol's own schema says so — and the outcome reports
     * whether it was honoured. Held here for the same reason as `prompt`: this registry is the
     * one thing that knows an agent is an ACP session, and `AcpSessionDriver.cancel()` had no
     * production caller, so a turn could be started and never stopped from any surface.
     */
    cancel: () => Promise<{ honoured: boolean }>;
    /**
     * A human decided on a held permission.
     *
     * Resolves the request the agent is parked on. Without a caller, an ACP agent that asked
     * permission waited forever: alive, mid-turn, and silent about why.
     */
    decide: (approvalId: string, decision: PermissionDecision) => void;
    /**
     * What the driver on the other end DECLARED it can do, or `null` for "not declared".
     *
     * Held here for the same reason as everything above: this registry is the one thing
     * that knows an agent is an ACP session, so it is the only place a surface can ask.
     *
     * A FUNCTION, not a value, because the answer is per session and is learned at the
     * handshake — an entry registered before `start()` completes would have captured
     * `null` forever. The same mistake as caching it against a provider name, made one
     * layer down.
     *
     * **Nothing renders this yet, and that is deliberate rather than forgotten.** The one
     * UI decision it should drive — not offering an approval affordance for an agent that
     * cannot be asked — is a board surface the owner has not designed, and claude's
     * `permissionRequests` flips to `true` when prism 0.7.0's bridge lands, so a surface
     * built against today's value would be built against a value with a known expiry.
     * Reachable and measured now; rendered when there is a design to render.
     */
    capabilities: () => DriverCapabilities | null;
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

    /**
     * This session's prompt function, or null when there is no live session for the spec.
     *
     * Null is the discriminator for the whole write path: most agents are pty agents, and
     * the absence of an entry is what keeps their behaviour exactly as it was. A CLOSED
     * entry is also null — prompting a dead channel would hang or throw inside a tool call,
     * and a closed entry is not a session, which is the rule `isLive` already holds to.
     */
    promptFor(specId: string): AcpSessionEntry['prompt'] | null {
        const entry = this.sessions.get(specId);
        if (!entry || entry.closed) return null;
        return entry.prompt;
    }

    /**
     * This session's cancel, or null when there is no live session.
     *
     * Same discriminator as `promptFor`: null for every pty agent, so their path is untouched,
     * and null for a CLOSED entry, because cancelling a dead channel would hang or throw inside
     * an IPC handler.
     */
    cancelFor(specId: string): AcpSessionEntry['cancel'] | null {
        const entry = this.sessions.get(specId);
        if (!entry || entry.closed) return null;
        return entry.cancel;
    }

    /** This session's permission decider, or null when there is no live session. */
    decideFor(specId: string): AcpSessionEntry['decide'] | null {
        const entry = this.sessions.get(specId);
        if (!entry || entry.closed) return null;
        return entry.decide;
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
export function writeRefusal(_engine: AgentEngine): string | null {
    // Previously: `if (engine === 'pty') return null` — a keystroke write was allowed through
    // for a pty agent. There are no pty agents now (`AgentEngine` has one member), so every
    // agent write is refused with the same explanation. The parameter is kept so call sites
    // and the signature are unchanged, and so a future second engine has to decide here.
    return 'This agent runs as a structured ACP session, so there is no terminal to type into. Send it a prompt instead.';
}
