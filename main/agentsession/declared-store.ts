import { applySessionUpdate, type AcpSessionUpdate } from '../acp/update-to-session';
import {
    emptyAgentSession,
    type AgentSession,
    type AgentSessionIdentity,
    type PendingApproval,
} from './model';
import type { AgentEngine } from '../agents/budget';
import type { AgentUsageEvent } from '../agents/usage-rollup';

/**
 * Where a declared session lives between updates, and where telemetry is recorded.
 *
 * `applySessionUpdate` had no production caller. The ACP transport started, the handshake
 * completed, `session/prompt` went out — and the stream of `session/update` notifications
 * coming back was subscribed to by nothing, so the transcript, plan, tool calls, approvals
 * and usage never reached an `AgentSession`. "The agent declares its state; Genie renders
 * it" was true in the mapper and nowhere else.
 *
 * This is the missing middle: one place that keeps the current session per agent, folds each
 * update into it, and emits the telemetry events that make the ACP path measurable.
 *
 * ## Why telemetry is recorded HERE
 *
 * It is the only point that sees every declared fact exactly once. Recording from the UI
 * would miss everything that happens while no window is open; recording in the mapper would
 * make a pure function write to a database. This seam already has the agent's identity, the
 * engine, and the update — which is the whole row.
 *
 * ## Ports, not imports
 *
 * `record` and `now` are injected so the store is testable without a database and so
 * `createHostCore` can use it without importing Electron. The same reason `HostSpawner` is a
 * port.
 */

export interface DeclaredStorePorts {
    /** Append one telemetry row. Injected: the store must not know about sqlite. */
    record: (e: Omit<AgentUsageEvent, 'day'> & { workspaceId: string | null }) => void;
    now: () => number;
    /**
     * Resolve a terminal spec to the AGENT that owns it.
     *
     * Needed because the two ends of this disagree about identity, and silently: the ACP
     * transport knows a `terminal_specs.id`, while sessions are keyed by
     * `workspace_agents.id` — *"an agent is not its TUI"*, and `gatherAgentFromRow` uses
     * `row.id`. Keying the store by the spec, or by `meta.agent_id` (the AgentInbox UUID
     * minted at launch), would mean `mergeDeclared` never found a single declared session
     * while everything looked wired.
     *
     * Resolved LAZILY, on the first update, for an ordering reason: at the moment
     * `createAgentTerminal` starts the transport the agent row may not point at the new spec
     * yet, so a lookup at launch returns nothing. By the time updates flow it is fronted.
     */
    identityForSpec?: (specId: string) => AgentSessionIdentity | null;
    /**
     * The provider's own session id has arrived — persist it against the agent's record.
     *
     * Fired on the TRANSITION from absent to present, not on every update: every chunk of a
     * streaming reply is its own update, and `updateTerminalSpec` is a database write, so
     * reporting each one would be hundreds of writes per turn for a single value.
     *
     * It must be persisted at all because a value in memory is no use to a resume after the
     * process holding it is gone — and a Genie restart is exactly the case resume exists for.
     */
    onSessionIdCaptured?: (specId: string | null, sessionId: string) => void;
}

/** What a turn costs, kept per agent so a turn's duration can be reported when it ends. */
interface TurnInFlight {
    startedAt: number;
}

export class DeclaredSessionStore {
    private readonly sessions = new Map<string, AgentSession>();
    private readonly turns = new Map<string, TurnInFlight>();

    constructor(private readonly ports: DeclaredStorePorts) {}

    /**
     * Open a session for an agent that has just connected.
     *
     * Deliberately NOT lazy. A session that exists but has declared nothing is how the UI
     * learns the difference between "connected and quiet" and "not connected" — and
     * `mergeDeclared` is written so an all-null declared session leaves the floor projection
     * intact, so creating it early costs nothing and hides nothing.
     */
    open(identity: AgentSessionIdentity): void {
        this.sessions.set(identity.agentId, emptyAgentSession(identity, this.ports.now()));
    }

    /**
     * The turn finished.
     *
     * Called when `session/prompt` RESOLVES, not from an update — and that is a protocol
     * fact, not a shortcut: the mapper contains no `'idle'` at all, because ACP has no
     * "turn over" notification. The request completing IS the end of the turn, which is
     * also why `AcpSessionDriver` carries `noteTurnEnded`.
     *
     * Recording the end here rather than inferring idleness from silence is the difference
     * this whole model exists for: `agentinbox/wake.ts` had to treat quiet as idle, and a
     * slow turn therefore read as a finished one.
     */
    endTurn(agentId: string): void {
        const current = this.sessions.get(agentId);
        if (!current) return;
        const started = this.turns.get(agentId);
        // No in-flight turn: a duplicate resolve, or a prompt that never started one.
        if (!started) return;
        this.turns.delete(agentId);

        const now = this.ports.now();
        const next: AgentSession = { ...current, turn: { state: 'idle', since: now }, live: null };
        this.sessions.set(agentId, next);
        this.ports.record({
            agentId,
            workspaceId: current.session.workspaceId,
            engine: 'acp',
            at: now,
            kind: 'turn-ended',
            durationMs: now - started.startedAt,
            // The turn's own cost. `usage_update` reports a running total, so the day's
            // spend is a sum of deltas — see `deltaCost`.
            costUsd: current.usage?.costUsd ?? null,
            tokensIn: null,
            tokensOut: null,
        });
    }

    /** Forget an agent's session — the child exited, or the agent was deleted. */
    close(agentId: string): void {
        this.sessions.delete(agentId);
        this.turns.delete(agentId);
    }

    /** The declared session for this agent, or null. `mergeDeclared` takes it from here. */
    get(agentId: string): AgentSession | null {
        return this.sessions.get(agentId) ?? null;
    }

    /** Every declared session, for the list the Deck reads. */
    all(): ReadonlyMap<string, AgentSession> {
        return this.sessions;
    }

    /**
     * Fold an update in, addressed by SPEC — what the ACP transport actually knows.
     *
     * Opens the session on first use. See `identityForSpec` for why the resolution is lazy
     * and why keying by the spec itself would have been wrong.
     */
    applyForSpec(specId: string, update: AcpSessionUpdate): void {
        const identity = this.ports.identityForSpec?.(specId) ?? null;
        if (!identity) return; // Not an agent we can key yet: the row is not fronted.
        if (!this.sessions.has(identity.agentId)) this.open(identity);
        this.apply(identity.agentId, update);
    }

    /**
     * A permission request the agent is PARKED on, addressed by spec.
     *
     * Not an update, so it cannot go through `apply`: `session/request_permission` is a request
     * the agent makes of US, held open by `AcpSessionDriver` until a human decides. The driver
     * announces it through `onApproval` — which production code called from nowhere, so an ACP
     * agent that asked permission parked forever and no surface said why. The agent stays alive,
     * the turn never ends, and the only symptom is an agent that went quiet.
     *
     * Opens the session if the permission is the first thing this agent does — a first turn
     * whose first act is an edit. Dropping it for want of a session would be the same silence.
     */
    addApprovalForSpec(specId: string, approval: PendingApproval): void {
        const identity = this.ports.identityForSpec?.(specId) ?? null;
        if (!identity) return;
        if (!this.sessions.has(identity.agentId)) this.open(identity);
        const current = this.sessions.get(identity.agentId);
        if (!current) return;
        // Already held: the driver disambiguates colliding ids, so one id twice can only be a
        // re-announcement — most plausibly a listener attached twice — and counting it would
        // report one block as two.
        if (current.approvals.some((a) => a.id === approval.id)) return;

        const now = this.ports.now();
        this.sessions.set(identity.agentId, {
            ...current,
            approvals: [...current.approvals, approval],
        });
        // A human being blocked is the measure that compares honestly across engines: not how
        // fast an agent is, but how often it stops and waits for a person.
        this.ports.record({
            agentId: identity.agentId,
            workspaceId: current.session.workspaceId,
            engine: 'acp',
            at: now,
            kind: 'approval-asked',
            durationMs: null,
            costUsd: null,
            tokensIn: null,
            tokensOut: null,
        });
    }

    /**
     * A decision landed, or the turn was cancelled — the agent is no longer waiting on this one.
     *
     * A no-op for an id it does not hold rather than a throw: this is reached straight from an
     * IPC handler after a human clicked, and a cancel settles every held request, so a second
     * click on a row that is already gone is ordinary.
     */
    clearApprovalForSpec(specId: string, approvalId: string): void {
        const identity = this.ports.identityForSpec?.(specId) ?? null;
        if (!identity) return;
        const current = this.sessions.get(identity.agentId);
        if (!current) return;
        if (!current.approvals.some((a) => a.id === approvalId)) return;

        const now = this.ports.now();
        this.sessions.set(identity.agentId, {
            ...current,
            approvals: current.approvals.filter((a) => a.id !== approvalId),
        });
        this.ports.record({
            agentId: identity.agentId,
            workspaceId: current.session.workspaceId,
            engine: 'acp',
            at: now,
            kind: 'approval-decided',
            durationMs: null,
            costUsd: null,
            tokensIn: null,
            tokensOut: null,
        });
    }

    /** The turn finished, addressed by spec. */
    endTurnForSpec(specId: string): void {
        const identity = this.ports.identityForSpec?.(specId) ?? null;
        if (identity) this.endTurn(identity.agentId);
    }

    /**
     * Fold one `session/update` into this agent's session, and record what it tells us.
     *
     * Unknown-to-us update kinds are a no-op on the session (the mapper decides that) but
     * still safe to pass in: an adapter version bump that adds a kind must not throw inside
     * a notification handler and take the subscription down with it.
     */
    apply(agentId: string, update: AcpSessionUpdate): void {
        const current = this.sessions.get(agentId);
        if (!current) return; // No session open: an update for an agent we are not tracking.

        const now = this.ports.now();
        const next = applySessionUpdate(current, update, now);
        this.sessions.set(agentId, next);

        // The id the mapper just extracted, reported once. See `onSessionIdCaptured`.
        if (!current.session.sessionId && next.session.sessionId) {
            this.ports.onSessionIdCaptured?.(next.specId, next.session.sessionId);
        }
        this.recordFor(agentId, current, next, update, now);
    }

    /**
     * Emit telemetry for the transition, by comparing before and after.
     *
     * Derived from the SESSION rather than from the update's own shape, so one rule covers
     * every kind and a new kind cannot silently stop being measured. The exception is cost:
     * `usage` is cumulative for the turn, so the DELTA is what a day's sum needs — adding
     * the running total on every update would multiply the day's cost by the number of
     * updates.
     */
    private recordFor(
        agentId: string,
        before: AgentSession,
        after: AgentSession,
        update: AcpSessionUpdate,
        now: number,
    ): void {
        const engine: AgentEngine = 'acp';
        const workspaceId = after.session.workspaceId;
        const base = { agentId, workspaceId, engine, at: now };

        const wasWorking = before.turn.state !== 'idle';
        const isWorking = after.turn.state !== 'idle';

        if (!wasWorking && isWorking) {
            this.turns.set(agentId, { startedAt: now });
            this.ports.record({ ...base, kind: 'turn-started', durationMs: null, costUsd: null, tokensIn: null, tokensOut: null });
        }

        // NO turn-ended branch here, deliberately. ACP has no "turn over" update — the
        // mapper contains no `'idle'` — so the end of a turn arrives as `session/prompt`
        // resolving and is recorded by `endTurn`. A transition-based branch here would be
        // unreachable code that reads as the thing doing the work.
        void isWorking;

        // A new approval is a human being blocked, which is the measure that compares
        // honestly across engines.
        if (after.approvals.length > before.approvals.length) {
            this.ports.record({ ...base, kind: 'approval-asked', durationMs: null, costUsd: null, tokensIn: null, tokensOut: null });
        }
        if (before.approvals.length > after.approvals.length) {
            this.ports.record({ ...base, kind: 'approval-decided', durationMs: null, costUsd: null, tokensIn: null, tokensOut: null });
        }

        if (update.sessionUpdate === 'tool_call') {
            this.ports.record({ ...base, kind: 'tool-call', durationMs: null, costUsd: null, tokensIn: null, tokensOut: null });
        }
        if (update.sessionUpdate === 'compaction_update') {
            // A silent compaction is amnesia with no notice, and the top cause of "why did
            // it get stupid". Recorded so it is countable, not only visible.
            this.ports.record({ ...base, kind: 'compacted', durationMs: null, costUsd: null, tokensIn: null, tokensOut: null });
        }
    }
}

/**
 * How much this turn's cost grew between two reports.
 *
 * `usage_update` carries the turn's running total, so a day's spend is the sum of DELTAS. A
 * turn that reports 0.10, then 0.25, then 0.40 cost 0.40 — not 0.75.
 *
 * Returns null when either side is unknown: "cannot see" must not become a confident 0.
 */
export function deltaCost(before: AgentSession, after: AgentSession): number | null {
    const now = after.usage?.costUsd ?? null;
    if (now === null) return null;
    const was = before.usage?.costUsd ?? 0;
    const delta = now - was;
    // A total that went DOWN means a new turn's counter, not a refund.
    return delta >= 0 ? delta : now;
}
