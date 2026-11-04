import type { AgentId } from '../core/identity.js';

/**
 * A WORKSPACE'S VERDICT CHANGES WHILE ITS AGENT RUNS. What a session loaded was fixed at launch, so a running agent can
 * disagree with the verdict, and each change of the host or the verdict compares the two:
 *
 * - Launched untrusted, trusted now: one message, held for the next real work, so it reads what it could not. It starts
 *   no turn of its own: trusting a workspace spends nothing. Withdrawn if the verdict moves back first. Once per run.
 * - Launched trusted, untrusted now: no work reaches this session any more (the session host's `mayTakeWork`). It restarts
 *   once that would cut nothing (`AgentSession.quiet`): in a turn, when the turn has ended; idle, not until work arrives,
 *   so a workspace that changes costs an idle agent nothing until someone needs it. A line in the chat says which.
 *   Trusted again before that: no restart, the chat is told, and what waited goes to this session.
 *
 * Compared rather than triggered, so a change that lands while a launch is being prepared is still seen when it comes up.
 */

export const NOW_TRUSTED = 'This workspace is trusted now. Read its instructions and your persona before you carry on.';
export const UNTRUSTED_AT_TURN_END = 'This workspace is no longer trusted. This agent restarts when its turn ends and keeps its conversation.';
export const UNTRUSTED_AT_NEXT_WORK = 'This workspace is no longer trusted. This agent restarts before its next work and keeps its conversation.';
export const TRUSTED_AGAIN = 'This workspace is trusted again. No restart.';

export interface TrustVerdictPorts {
    agentsOf(workspaceId: string): readonly AgentId[];
    /** The verdict as last read. */
    untrustedNow(agentId: AgentId): boolean;
    /** What the running session was launched under; `null` = no session, or its launch has not read it yet. */
    launchedUntrusted(agentId: AgentId): boolean | null;
    quiet(agentId: AgentId): boolean;
    inTurn(agentId: AgentId): boolean;
    /** Work the session is holding because this run may not take it. */
    workWaiting(agentId: AgentId): boolean;
    /** This run may take work again: what it held goes now. */
    releaseWork(agentId: AgentId): void;
    runOf(agentId: AgentId): number | null;
    /** Put ahead of the next work this run gets. False = no session took it. */
    hold(agentId: AgentId, text: string): boolean;
    /** True = it was still held, and now it is not. */
    withdraw(agentId: AgentId): boolean;
    notice(agentId: AgentId, text: string): void;
    restart(agentId: AgentId): Promise<{ ok: true } | { ok: false; reason: string | null }>;
}

interface ThisRun { run: number; told: boolean; announced: boolean; sawTurn: boolean; restarting: boolean; refused: boolean }

export class TrustVerdicts {
    readonly #ports: TrustVerdictPorts;
    readonly #runs = new Map<AgentId, ThisRun>();

    constructor(ports: TrustVerdictPorts) {
        this.#ports = ports;
    }

    /** The verdict moved: every agent of that workspace. */
    changed(workspaceId: string): void {
        for (const id of this.#ports.agentsOf(workspaceId)) this.check(id);
    }

    /** Called from inside a session's own state change, so what it decides happens after that has finished. */
    check(agentId: AgentId): void {
        const launched = this.#ports.launchedUntrusted(agentId);
        if (launched === null) return;
        const run = this.#runs.get(agentId);
        if (launched === this.#ports.untrustedNow(agentId) && !run?.announced && !run?.told) return;
        queueMicrotask(() => this.#reconcile(agentId));
    }

    #thisRun(agentId: AgentId, run: number): ThisRun {
        const known = this.#runs.get(agentId);
        if (known?.run === run) return known;
        const fresh: ThisRun = { run, told: false, announced: false, sawTurn: false, restarting: false, refused: false };
        this.#runs.set(agentId, fresh);
        return fresh;
    }

    #reconcile(agentId: AgentId): void {
        const ports = this.#ports;
        const run = ports.runOf(agentId);
        const launched = ports.launchedUntrusted(agentId);
        if (run === null || launched === null) return;
        const state = this.#thisRun(agentId, run);
        const untrusted = ports.untrustedNow(agentId);

        if (launched) {
            if (!untrusted && !state.told) state.told = ports.hold(agentId, NOW_TRUSTED);
            else if (untrusted && state.told && ports.withdraw(agentId)) state.told = false;
            return;
        }
        if (!untrusted) {
            if (state.announced && !state.restarting) {
                state.announced = false;
                state.sawTurn = false;
                ports.notice(agentId, TRUSTED_AGAIN);
                ports.releaseWork(agentId);
            }
            return;
        }
        if (state.restarting || state.refused) return;
        const inTurn = ports.inTurn(agentId);
        if (!state.announced) {
            state.announced = true;
            ports.notice(agentId, inTurn ? UNTRUSTED_AT_TURN_END : UNTRUSTED_AT_NEXT_WORK);
        }
        if (inTurn) state.sawTurn = true;
        // Idle: nothing yet needs another run, and a restart would spend something for nobody.
        if (!ports.quiet(agentId) || (!state.sawTurn && !ports.workWaiting(agentId))) return;
        state.restarting = true;
        void ports.restart(agentId).then(
            (result) => { if (!result.ok) this.#refused(agentId, state, result.reason ?? 'no reason was given'); },
            (error: unknown) => { this.#refused(agentId, state, error instanceof Error ? error.message : String(error)); },
        ).finally(() => { state.restarting = false; });
    }

    /** Said once and not tried again in this run: its shell calls still ask, and the next launch reads the verdict. */
    #refused(agentId: AgentId, state: ThisRun, reason: string): void {
        state.refused = true;
        this.#ports.notice(agentId, `Could not restart this agent: ${reason}`);
    }
}
