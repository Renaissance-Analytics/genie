/**
 * AN AUTOMATED AGENT WITH AN OPEN PLAN DOES NOT JUST STOP (the owner, 2026-10-21: "when you have a plan open genie should
 * have a way to make sure you don't just stop if an agent is set to auto mode").
 *
 * A turn that ends with steps of its plan left (Genie's `plan` tool), from an agent set to `automated`, gets ONE nudge
 * after a short grace — one timer, never a poll. Never when the person stopped it, when it failed or is held, when it is
 * waiting on the person, or when something else reached it in the grace. And never forever: three nudges in a row that
 * complete no step stop the nudging, and that is said in its chat.
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
}

export interface PlanKeepalivePorts {
    readonly graceMs: number;
    readonly schedule: (ms: number, fn: () => void) => () => void;
    /** The agent as it stands now; `null` = gone. */
    readonly read: (agentId: string) => KeepGoingState | null;
    readonly prompt: (agentId: string, text: string) => void;
    /** Said in the agent's chat when the nudging stops. */
    readonly stalled: (agentId: string, text: string) => void;
}

/** Nudges in a row that complete no step before the nudging stops. */
export const KEEPALIVE_STRIKES = 3;

/** The nudge: what is left, and what to do. */
export function keepGoingPrompt(plan: NonNullable<KeepGoingState['plan']>): string {
    const left = plan.of - plan.step;
    const now = plan.doing ? ` The step in progress: "${plan.doing}".` : '';
    return `Your plan has ${left} of ${plan.of} steps left, and you are in automated mode, so carry on with the next step.${now} If you are blocked on a decision only the person can make, ask it with ForceTheQuestion; if the plan changed, update it with the plan tool; if it is finished, mark its steps completed.`;
}

function shouldNudge(s: KeepGoingState | null): s is KeepGoingState & { plan: NonNullable<KeepGoingState['plan']> } {
    return s !== null && s.mode === 'automated' && s.lastTurnEnd === 'replied' && s.plan !== null && s.plan.step < s.plan.of && !s.waitingOnPerson && (s.background ?? 0) === 0;
}

export class PlanKeepalive {
    readonly #ports: PlanKeepalivePorts;
    readonly #pending = new Map<string, () => void>();
    /** Per agent: the steps done when it was last nudged, and how many nudges in a row moved nothing. */
    readonly #last = new Map<string, { done: number; of: number; strikes: number; stalled: boolean }>();

    constructor(ports: PlanKeepalivePorts) {
        this.#ports = ports;
    }

    /** A turn of this agent ended. */
    turnEnded(agentId: string): void {
        if (this.#pending.has(agentId)) return;
        if (!shouldNudge(this.#ports.read(agentId))) return;
        const cancel = this.#ports.schedule(this.#ports.graceMs, () => {
            this.#pending.delete(agentId);
            this.#fire(agentId);
        });
        this.#pending.set(agentId, cancel);
    }

    /** Stop everything waiting (a quit). */
    stop(): void {
        for (const cancel of this.#pending.values()) cancel();
        this.#pending.clear();
    }

    #fire(agentId: string): void {
        const s = this.#ports.read(agentId);
        if (!shouldNudge(s) || !s.promptable) return;
        const before = this.#last.get(agentId);
        const moved = before === undefined || s.plan.step > before.done || s.plan.of !== before.of;
        const strikes = moved ? 1 : before.strikes + 1;
        if (!moved && before.stalled) return;
        if (strikes > KEEPALIVE_STRIKES) {
            this.#last.set(agentId, { done: s.plan.step, of: s.plan.of, strikes, stalled: true });
            this.#ports.stalled(agentId, `Genie stopped nudging: ${KEEPALIVE_STRIKES} nudges in a row completed no step of the plan (still ${s.plan.step} of ${s.plan.of}). Send a message, or update the plan, to go on.`);
            return;
        }
        this.#last.set(agentId, { done: s.plan.step, of: s.plan.of, strikes, stalled: false });
        this.#ports.prompt(agentId, keepGoingPrompt(s.plan));
    }
}
