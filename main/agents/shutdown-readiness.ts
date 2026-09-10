import { agentInboxBroker } from '../agentinbox/broker';
import type { AgentAsk } from '../agentinbox/urgency';
import { DEFAULT_AGENT_MODE, genieAskMode, type AgentMode } from './agent-mode';
import { agentModeFor } from './agent-mode-source';

export interface ShutdownAgentTarget {
    agentId: string;
    inboxAgentId: string;
    terminalId: string;
}

export interface ShutdownReadinessResult {
    ready: string[];
    timedOut: string[];
}

/**
 * THE QUIT-TIME ASK (genie#606) — the drain's twin, still saying what the
 * drain's used to.
 *
 * genie#602 fixed the upgrade drain's notice: an agent told to *"Stop work now"*
 * was announced to as *"It is not urgent — check it when you are not busy"*, and
 * a Manual agent asked to answer was told in the same breath *"do not act on it
 * unless a person asks you to"*. This barrier — the thirty seconds a real full
 * shutdown gives every agent — carried both halves of that, unchanged.
 *
 * ## Why the rung is `urgent` and NOT `showstopper`
 *
 * `showstopper` asserts *"Genie is holding until your answer arrives"*. On a
 * clock that is FALSE. Genie quits either way; an agent that does not answer
 * loses its chance to checkpoint and nothing else. Overstating is the same
 * defect as understating, pointed the other way, and it would spend the meaning
 * genie#602 bought — so the ask declares its DEADLINE and the rung derives from
 * it (`askUrgency`), never chosen.
 *
 * ## Why a Manual agent is asked to act
 *
 * For the reason the drain's is, and with the same guard. What this asks is
 * entirely self-scoped — checkpoint your own work, then say when it is safe to
 * stop you — and the mis-inference to rule out is genie#407's: an agent reading
 * "prepare for shutdown" as licence to go and restart or migrate things.
 * {@link genieAskMode}'s *"nothing else about how you work changes"* is what
 * carries that, which is why one clause serves both surfaces.
 */
export interface ShutdownNotice {
    text: string;
    ask: AgentAsk;
}

/**
 * What the barrier asks for, and the terms it asks on — one value.
 *
 * The property genie#602 established, kept: the body and its terms ship
 * together or not at all. `deadlineSeconds` reaches the agent twice — once in
 * the envelope's headline, once here — and both times from this one number, so
 * they cannot come to say different things. The mode clause deliberately does
 * NOT repeat it; it carries the framing that number implies.
 */
export function shutdownAsk(mode: AgentMode, deadlineSeconds: number): ShutdownNotice {
    return {
        text: [
            'Genie is shutting down, and this terminal will be closed with it.',
            '',
            `Genie goes ahead in about ${deadlineSeconds} seconds whether or not you answer.`,
            'Finish or checkpoint current work now — do not start anything new.',
            'Then call `thumbsUp` with reason "shutdown" to say it is safe to stop this agent.',
            '',
            genieAskMode(mode, { deadlineSeconds }),
        ].join('\n'),
        ask: { deadlineSeconds },
    };
}

/**
 * PURE. The barrier's half of its own wiring (genie#606).
 *
 * The same shape as `drainNudgeSender`, and for the same reason: the line that
 * carried the bug was the wiring, and the singleton at the bottom of this file
 * reaches for the real broker, so no test can construct it. The notice is
 * SPREAD, never rebuilt — {@link ShutdownNotice} is exactly the two fields the
 * broker's send wants, so forwarding the body without its terms means taking
 * the value apart on purpose.
 */
export function shutdownAskSender(
    send: (input: {
        system: true;
        toAgentId: string;
        text: string;
        ask: AgentAsk;
    }) => { ok: boolean },
): (inboxAgentId: string, notice: ShutdownNotice) => boolean {
    return (inboxAgentId, notice) => send({ system: true, toAgentId: inboxAgentId, ...notice }).ok;
}

export interface ShutdownReadinessDeps {
    /** Put the ask in the agent's inbox. Takes the whole notice, so a wiring
     *  cannot announce it on terms it was never given. */
    send: (inboxAgentId: string, notice: ShutdownNotice) => boolean | void;
    /**
     * THIS agent's mode, so the ask is worded for the agent it goes to.
     *
     * Optional and defensive for the reason the drain's is: resolving a mode
     * reads the database and a file on disk, and neither may be able to cost an
     * agent the ask itself. A throw degrades to {@link DEFAULT_AGENT_MODE}.
     */
    modeOf?: (target: ShutdownAgentTarget) => AgentMode;
}

/** Bounded, one-flight readiness barrier for a real full shutdown. */
export class AgentShutdownReadiness {
    private pending = new Set<string>();
    private ready = new Set<string>();
    private finish: (() => void) | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly deps: ShutdownReadinessDeps) {}

    begin(targets: ShutdownAgentTarget[], timeoutMs: number): Promise<ShutdownReadinessResult> {
        if (this.finish) throw new Error('An agent shutdown readiness check is already running.');
        this.pending = new Set(targets.map((target) => target.agentId));
        this.ready.clear();
        // The deadline the AGENT is told comes from the same argument the timer
        // below is armed with, so the ask cannot promise thirty seconds while
        // the barrier keeps five.
        const deadlineSeconds = Math.max(1, Math.round(Math.max(0, timeoutMs) / 1000));
        for (const target of targets) this.ask(target, deadlineSeconds);
        if (this.pending.size === 0) return Promise.resolve({ ready: [], timedOut: [] });

        return new Promise((resolve) => {
            const settle = () => {
                if (this.timer) clearTimeout(this.timer);
                this.timer = null;
                this.finish = null;
                resolve({
                    ready: [...this.ready].sort(),
                    timedOut: [...this.pending].sort(),
                });
            };
            this.finish = settle;
            this.timer = setTimeout(settle, Math.max(0, timeoutMs));
        });
    }

    acknowledge(agentId: string, reason: 'boot' | 'ack' | 'shutdown'): void {
        if (reason !== 'shutdown' || !this.pending.delete(agentId)) return;
        this.ready.add(agentId);
        if (this.pending.size === 0) this.finish?.();
    }

    pendingAgentIds(): string[] {
        return [...this.pending].sort();
    }

    private ask(target: ShutdownAgentTarget, deadlineSeconds: number): void {
        let mode: AgentMode = DEFAULT_AGENT_MODE;
        try {
            mode = this.deps.modeOf?.(target) ?? DEFAULT_AGENT_MODE;
        } catch {
            // An unreadable mode is an UNDECLARED mode, and undeclared is
            // Manual. Losing the whole ask over it would trade a wording
            // difference for an agent never told it was about to be stopped.
            mode = DEFAULT_AGENT_MODE;
        }
        try {
            this.deps.send(target.inboxAgentId, shutdownAsk(mode, deadlineSeconds));
        } catch {
            /* one unreachable agent must not cost the rest of them the ask */
        }
    }
}

export const agentShutdownReadiness = new AgentShutdownReadiness({
    // The terms come from the notice, not from here — see `shutdownAskSender`
    // and genie#606. This is the binding; the decision is tested next door.
    send: shutdownAskSender((input) => agentInboxBroker.send(input)),
    modeOf: (target) => agentModeFor({ agentId: target.agentId, terminalId: target.terminalId }),
});
