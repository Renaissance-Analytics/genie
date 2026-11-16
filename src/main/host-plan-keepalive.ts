import type { AgentId, AgentRecord } from '../core/identity.js';
import { PlanKeepalive, type KeepGoingState, type TurnEndCause } from '../core/plan-keepalive.js';
import type { LiveSession } from '../core/roster.js';
import { TurnStallWatchdog, stallMsFrom } from '../core/turn-stall.js';
import type { HostRegistry } from './host-registry.js';
import type { SessionHost } from './session-host.js';
import type { SettingsStore } from './settings-store.js';

/**
 * THE PLAN KEEPALIVE AND THE STALL WATCHDOG, IN GENIE-HOST (Tynn #754). They lived in the window (main.ts), so they ran
 * only while a window was attached and read every turn end through the engine link; the host owns the sessions, so the
 * host runs them — one keepalive, no window's to double it. See core/plan-keepalive.ts and core/turn-stall.ts for the
 * rules; this is the host's wiring, and what it says in its log when it leaves an agent alone.
 */

/** What the keepalive reads of the host: the session host's own answers. */
export interface KeepaliveHostView {
    probe(agentId: AgentId): LiveSession | null;
    lastTurnEnd(agentId: AgentId): KeepGoingState['lastTurnEnd'];
    promptable(agentId: AgentId): number | null;
    stoppedByYou(agentId: AgentId): boolean;
}

/** The agent as the keepalive reads it; `null` = gone (no record, or no session). */
export function keepGoingStateOf(
    host: KeepaliveHostView,
    find: (agentId: AgentId) => AgentRecord | undefined,
    asked: (agentId: AgentId) => boolean,
    agentId: AgentId,
): KeepGoingState | null {
    const record = find(agentId);
    const live = host.probe(agentId);
    if (!record || !live) return null;
    return {
        mode: record.mode,
        lastTurnEnd: host.lastTurnEnd(agentId),
        plan: live.plan ?? null,
        promptable: host.promptable(agentId) != null,
        waitingOnPerson: asked(agentId) || live.pendingApproval !== null,
        background: live.background ?? null,
        stoppedByYou: host.stoppedByYou(agentId),
    };
}

export interface HostPlanKeepalive {
    /** A turn ended: `replied`, or a stop Genie did itself. */
    turnEnded(agentId: AgentId, cause: TurnEndCause): void;
    /** The person wrote to an agent. */
    personTurn(agentId: AgentId): void;
    stop(): void;
}

export function wireHostPlanKeepalive(p: {
    readonly host: SessionHost;
    readonly registry: Pick<HostRegistry, 'find' | 'listAgents'>;
    /** The agent has its own open ForceTheQuestion. */
    readonly asked: (agentId: AgentId) => boolean;
    readonly settings: Pick<SettingsStore, 'snapshot'>;
    readonly log: (line: string) => void;
}): HostPlanKeepalive {
    const nameOf = (id: string): string => p.registry.find(id)?.name ?? id;
    const read = (id: string): KeepGoingState | null => keepGoingStateOf(p.host, (a) => p.registry.find(a) ?? undefined, p.asked, id as AgentId);
    const keepalive = new PlanKeepalive({
        graceMs: 5_000,
        // A restarted session needs a moment to be ready to take a prompt.
        restartGraceMs: 20_000,
        schedule: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
        read,
        prompt: (id, text) => { p.host.prompt(id as AgentId, text, 'genie'); },
        stalled: (id, text) => { p.host.notice(id as AgentId, text); p.log(`plan nudges for ${nameOf(id)} stopped: ${text}`); },
        // A manual agent is not nudged by design, on every turn it takes: not worth a line each.
        skipped: (id, reason) => { if (reason !== 'manual') p.log(`plan nudge skipped for ${nameOf(id)}: ${reason}`); },
    });

    // The stall watchdog: its own flag/prompt must not count as the agent's output.
    let own = false;
    const quietly = (fn: () => void): void => { own = true; try { fn(); } finally { own = false; } };
    const minutes = (ms: number): number => Math.round(ms / 60_000);
    const watchdog = new TurnStallWatchdog({
        now: Date.now,
        stallMs: () => stallMsFrom(p.settings.snapshot()),
        agents: () => p.registry.listAgents().map((a) => a.id),
        read: (id) => {
            const record = p.registry.find(id);
            const live = p.host.probe(id as AgentId);
            if (!record || !live || !live.running) return null;
            return { inTurn: p.host.inTurn(id as AgentId), mode: record.mode, waitingOnPerson: p.asked(id as AgentId) || live.pendingApproval !== null };
        },
        flag: (id, ms) => {
            p.log(`${nameOf(id)}: no output for ${minutes(ms)} minutes inside one turn`);
            quietly(() => { p.host.notice(id as AgentId, `This turn has produced no output for ${minutes(ms)} minutes. If the provider is hung, Stop the turn to send a new message.`); });
        },
        nudge: (id, ms) => {
            quietly(() => { p.host.prompt(id as AgentId, `Your turn has been silent for ${minutes(ms)} minutes. If you are waiting on something, say what; otherwise carry on with the plan.`, 'genie'); });
        },
    });
    const offActivity = p.host.subscribe((id) => { if (!own) watchdog.activity(id); });
    const timer = setInterval(() => { try { watchdog.check(); } catch (error) { p.log(`the stall check failed: ${error instanceof Error ? error.message : String(error)}`); } }, 60_000);
    timer.unref();

    return {
        turnEnded: (id, cause) => keepalive.turnEnded(id, cause),
        personTurn: (id) => { keepalive.personTurnStarted(id); watchdog.activity(id); },
        stop: () => { keepalive.stop(); offActivity(); clearInterval(timer); },
    };
}
