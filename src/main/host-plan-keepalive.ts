import type { AgentId, AgentRecord } from '../core/identity.js';
import { PlanKeepalive, type KeepGoingState, type TurnEndCause } from '../core/plan-keepalive.js';
import type { LiveSession } from '../core/roster.js';
import { TurnStallWatchdog, stallMsFrom } from '../core/turn-stall.js';
import { runningCallWords, stallNoticeText, stalledAutoRestartFrom, toolTimeoutMsFrom, type StalledTurnBook } from '../core/hung-call.js';
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
    /** The Deck's stalled turns (Tynn #855): one item per agent whose turn Genie ended as stalled. Absent = not on the Deck. */
    readonly stalledTurns?: StalledTurnBook;
    /** Restart an agent on its conversation (the one Restart, genie#1238): `stalled_auto_restart`. Absent = never on its own. */
    readonly restart?: (agentId: AgentId) => Promise<unknown>;
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
            return { inTurn: p.host.inTurn(id as AgentId), mode: record.mode, waitingOnPerson: p.asked(id as AgentId) || live.pendingApproval !== null, call: live.call ?? null };
        },
        // THE CALL, NAMED (Tynn #855): the notice says which call the turn is in, and since when.
        flag: (id, ms, call) => {
            p.log(`${nameOf(id)}: no output for ${minutes(ms)} minutes inside one turn${call ? ` (in ${runningCallWords(call, Date.now())})` : ', no call running'}`);
            quietly(() => { p.host.notice(id as AgentId, stallNoticeText(ms, call, Date.now())); });
        },
        // A HUNG CALL ENDED (Tynn #855): the no-output timeout; the agent is told by the session, the host's log says so.
        toolTimeoutMs: () => toolTimeoutMsFrom(p.settings.snapshot()),
        endCall: (id, toolCallId, ms) => {
            void p.host.stopToolCall(id as AgentId, toolCallId, 'timeout').then(
                (r) => p.log(r.ok ? `${nameOf(id)}: ended a tool call with no output for ${minutes(ms)} minutes (${r.ended} processes)` : `${nameOf(id)}: could not end a tool call with no output for ${minutes(ms)} minutes: ${r.reason}`),
                (error: unknown) => p.log(`${nameOf(id)}: ending a hung tool call failed: ${error instanceof Error ? error.message : String(error)}`));
        },
        // IS THE PROVIDER THERE (Tynn #855): the process, then a ping when the driver has one (prism G-314).
        checkAlive: (id) => p.host.checkAlive(id as AgentId, 10_000),
        stall: (id, ms, reason) => {
            if (!p.host.endStalled(id as AgentId, reason, ms)) return;
            p.log(`${nameOf(id)}: turn ended as stalled after ${minutes(ms)} minutes with no events (${reason === 'dead' ? 'its provider process is gone' : 'its provider did not answer'})`);
            const record = p.registry.find(id);
            p.stalledTurns?.record({ agentId: id, agentName: nameOf(id), workspaceId: record?.workspaceId ?? null, reason, silentMs: ms, at: Date.now() });
            if (p.restart && stalledAutoRestartFrom(p.settings.snapshot())) {
                p.log(`${nameOf(id)}: restarting it on its conversation (Restart a stalled agent is on)`);
                void p.restart(id as AgentId).then(() => { p.stalledTurns?.clear(id); }, (error: unknown) => p.log(`${nameOf(id)}: the restart after a stalled turn failed: ${error instanceof Error ? error.message : String(error)}`));
            }
        },
        nudge: (id, ms) => {
            quietly(() => { p.host.prompt(id as AgentId, `Your turn has been silent for ${minutes(ms)} minutes. If you are waiting on something, say what; otherwise carry on with the plan.`, 'genie'); });
        },
    });
    const offActivity = p.host.subscribe((id) => {
        if (!own) watchdog.activity(id);
        // Its Deck item goes once a turn has started again (the stalled mark clears with it).
        if (p.stalledTurns?.has(id) && p.host.probe(id)?.stalled == null) p.stalledTurns.clear(id);
    });
    const timer = setInterval(() => { try { void watchdog.check(); } catch (error) { p.log(`the stall check failed: ${error instanceof Error ? error.message : String(error)}`); } }, 60_000);
    timer.unref();

    return {
        turnEnded: (id, cause) => keepalive.turnEnded(id, cause),
        personTurn: (id) => { keepalive.personTurnStarted(id); watchdog.activity(id); },
        stop: () => { keepalive.stop(); offActivity(); clearInterval(timer); },
    };
}
