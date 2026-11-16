/**
 * AN AUTOMATED AGENT WITH AN OPEN PLAN DOES NOT JUST STOP (the owner, 2026-10-21: "when you have a plan open genie should
 * have a way to make sure you don't just stop if an agent is set to auto mode").
 *
 * A turn that ends with steps of its plan left (Genie's `plan` tool), from an agent set to `automated`, gets ONE nudge
 * after a short grace — one timer, never a poll. Never when the person stopped it, when it failed or is held, when it is
 * waiting on the person, or when something else reached it in the grace. And never forever: three nudges in a row that
 * move nothing stop the nudging, and that is said in its chat.
 *
 * TYNN #754 (the owner's logs, 2026-11-16). PROGRESS is a step completed, the plan's size changing, OR the step in progress
 * changing — a long plan worked on one step for an hour is worked, not abandoned. A PERSON'S TURN starts the count again,
 * so "send a message to go on" is true. A stop GENIE did itself (an interrupt it restarted the agent from) is not the
 * person's Stop and is nudged; only the person's own Stop is respected. And every turn end that is not nudged says why
 * (`skipped`), so an agent left alone is explained.
 */

export interface KeepGoingState {
    readonly mode: 'automated' | 'manual';
    readonly lastTurnEnd: 'replied' | 'stopped' | 'failed' | 'held' | 'signed-out' | null;
    /** The plan as the Active Plan column reads it: steps done, of how many, the one in progress. */
    readonly plan: { readonly step: number; readonly of: number; readonly doing: string } | null;
    /** It can take a turn now (`AgentSession.promptable`). */
    readonly promptable: boolean;
    /** Its own open ForceTheQuestion, or a parked approval: the next move is the person's. */
    readonly waitingOnPerson: boolean;
    /** Background shells and tasks of its own still running (core/background-count.ts): their end wakes it, so no nudge. */
    readonly background?: number | null | undefined;
    /** The turn ended on the PERSON's Stop (`AgentSession.stoppedByYou`). A stop Genie did itself (an interrupt it restarted) is nudgeable. */
    readonly stoppedByYou?: boolean | undefined;
}

/** Why a turn's end was NOT nudged, said in the host's log so the person can see why an agent was left. */
export type SkipReason =
    | 'manual' | 'no-turn' | 'stopped-by-you' | 'failed' | 'held' | 'signed-out' | 'no-plan' | 'plan-complete'
    | 'waiting-on-person' | 'background' | 'busy' | 'gone' | 'stalled';

/** What ended the turn: a reply, or a stop Genie did itself and restarted from (`restarted`: a new session, no turn of its own yet). */
export type TurnEndCause = 'replied' | 'interrupted' | 'restarted';

export interface PlanKeepalivePorts {
    readonly graceMs: number;
    /** The grace after Genie restarted the agent's session (it needs a moment to take a prompt); absent = `graceMs`. */
    readonly restartGraceMs?: number | undefined;
    readonly schedule: (ms: number, fn: () => void) => () => void;
    /** The agent as it stands now; `null` = gone. */
    readonly read: (agentId: string) => KeepGoingState | null;
    readonly prompt: (agentId: string, text: string) => void;
    /** Said in the agent's chat when the nudging stops. */
    readonly stalled: (agentId: string, text: string) => void;
    /** Every turn end that was not nudged, with why. */
    readonly skipped?: ((agentId: string, reason: SkipReason) => void) | undefined;
}

/** Nudges in a row that complete no step before the nudging stops. */
export const KEEPALIVE_STRIKES = 3;

/** The nudge: what is left, and what to do. */
export function keepGoingPrompt(plan: NonNullable<KeepGoingState['plan']>): string {
    const left = plan.of - plan.step;
    const now = plan.doing ? ` The step in progress: "${plan.doing}".` : '';
    return `Your plan has ${left} of ${plan.of} steps left, and you are in automated mode, so carry on with the next step.${now} If you are blocked on a decision only the person can make, ask it with ForceTheQuestion; if the plan changed, update it with the plan tool; if it is finished, mark its steps completed.`;
}

/** Why this turn end is not nudged now, or `null` when it is. */
function skipReason(s: KeepGoingState | null, cause: TurnEndCause): SkipReason | null {
    if (s === null) return 'gone';
    if (s.mode !== 'automated') return 'manual';
    switch (s.lastTurnEnd) {
        case 'replied': break;
        // The person's own Stop is theirs. A stop Genie did itself (an unconfirmed interrupt it restarted from) is not.
        case 'stopped': if (s.stoppedByYou === true) return 'stopped-by-you'; break;
        case 'failed': return 'failed';
        case 'held': return 'held';
        case 'signed-out': return 'signed-out';
        // A new session after Genie's restart has had no turn of its own yet; any other turn end with none ended is no end.
        case null: if (cause !== 'restarted') return 'no-turn'; break;
    }
    if (s.plan === null) return 'no-plan';
    if (s.plan.step >= s.plan.of) return 'plan-complete';
    if (s.waitingOnPerson) return 'waiting-on-person';
    if ((s.background ?? 0) !== 0) return 'background';
    return null;
}

export class PlanKeepalive {
    readonly #ports: PlanKeepalivePorts;
    readonly #pending = new Map<string, () => void>();
    /** Per agent: the plan as it stood when last nudged, and how many nudges in a row moved nothing. */
    readonly #last = new Map<string, { done: number; of: number; doing: string; strikes: number; stalled: boolean }>();

    constructor(ports: PlanKeepalivePorts) {
        this.#ports = ports;
    }

    /** A turn of this agent ended (`cause`: a reply, or a stop Genie did itself and, for `restarted`, a new session began from). */
    turnEnded(agentId: string, cause: TurnEndCause = 'replied'): void {
        if (this.#pending.has(agentId)) return;
        const why = skipReason(this.#ports.read(agentId), cause);
        if (why !== null) { this.#ports.skipped?.(agentId, why); return; }
        const cancel = this.#ports.schedule(cause === 'restarted' ? this.#ports.restartGraceMs ?? this.#ports.graceMs : this.#ports.graceMs, () => {
            this.#pending.delete(agentId);
            this.#fire(agentId, cause);
        });
        this.#pending.set(agentId, cancel);
    }

    /** The person began a turn of their own (a message they typed): the count of nudges that moved nothing starts again. */
    personTurnStarted(agentId: string): void {
        this.#last.delete(agentId);
    }

    /** Stop everything waiting (a quit). */
    stop(): void {
        for (const cancel of this.#pending.values()) cancel();
        this.#pending.clear();
    }

    #fire(agentId: string, cause: TurnEndCause): void {
        const s = this.#ports.read(agentId);
        const why = skipReason(s, cause);
        if (why !== null || s === null || s.plan === null) { this.#ports.skipped?.(agentId, why ?? 'gone'); return; }
        if (!s.promptable) { this.#ports.skipped?.(agentId, 'busy'); return; }
        const before = this.#last.get(agentId);
        const moved = before === undefined || s.plan.step > before.done || s.plan.of !== before.of || s.plan.doing !== before.doing;
        const strikes = moved ? 1 : before.strikes + 1;
        if (!moved && before.stalled) { this.#ports.skipped?.(agentId, 'stalled'); return; }
        if (strikes > KEEPALIVE_STRIKES) {
            this.#last.set(agentId, { done: s.plan.step, of: s.plan.of, doing: s.plan.doing, strikes, stalled: true });
            this.#ports.stalled(agentId, `Genie stopped nudging: ${KEEPALIVE_STRIKES} nudges in a row moved nothing in the plan (still ${s.plan.step} of ${s.plan.of}). Send a message, or update the plan, to go on.`);
            this.#ports.skipped?.(agentId, 'stalled');
            return;
        }
        this.#last.set(agentId, { done: s.plan.step, of: s.plan.of, doing: s.plan.doing, strikes, stalled: false });
        this.#ports.prompt(agentId, keepGoingPrompt(s.plan));
    }
}
