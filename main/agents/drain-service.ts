import { broadcastLocal } from '../remote';
import { agentInboxBroker } from '../agentinbox/broker';
import {
    clearDrainRoster,
    getDb,
    getTerminalSpec,
    getWorkspace,
    isSiteStoppedByUser,
    listTerminalSpecs,
    listWorkspaceAgents,
    listWorkspaces,
    readDrainRoster,
    recordDrainRoster,
} from '../db';
import { isTerminalLive } from '../terminal/ipc';
import { devSiteManager } from '../dev-server/site-manager';
import { getProcessStatuses, startProcess } from '../terminal/process-supervisor';
import { startRegisteredAgent } from '../mcp/host-tools';
import { agentModeFor } from './agent-mode-source';
import { AgentDrain, drainableAgents, type DrainSnapshot, type DrainTarget } from './drain';
import {
    drainRosterFrom,
    runDrainRestore,
    type DrainRestoreEntry,
    type DrainRestoreOutcome,
} from './drain-restore';

/**
 * THE DRAIN, WIRED (genie#389).
 *
 * `drain.ts` and `drain-restore.ts` are the decisions; this is the wiring that
 * gives them the real broker, the real database and the real managers. It is
 * deliberately thin — every judgement it makes lives in one of those two
 * modules, where it is tested without an app around it.
 */

/** The channel the roster flyout listens on. Pushed, never polled. */
export const DRAIN_CHANGED = 'drain:changed';

export const agentUpgradeDrain = new AgentDrain({
    send: (inboxAgentId, text) =>
        agentInboxBroker.send({ system: true, toAgentId: inboxAgentId, text }).ok,
    modeOf: (agentId) =>
        agentModeFor({
            agentId,
            terminalId: agentInboxBroker.getInfo(agentId)?.terminalId ?? null,
        }),
    onChange: (snapshot) => broadcastLocal(DRAIN_CHANGED, snapshot),
});

/**
 * Every agent with a LIVE terminal, as drain rows.
 *
 * The same join `teardownTerminals` makes for the shutdown-readiness barrier:
 * a workspace agent is drainable only when it is bound to a terminal that is
 * actually up and that terminal carries an AgentInbox id to address. An agent
 * with no inbox id cannot be nudged, so it is not a row — it would be one that
 * could never go green on its own.
 */
export function collectDrainTargets(): DrainTarget[] {
    const targets: DrainTarget[] = [];
    for (const workspace of listWorkspaces()) {
        for (const agent of listWorkspaceAgents(workspace.id)) {
            if (!agent.terminal_spec_id || !isTerminalLive(agent.terminal_spec_id)) continue;
            const inboxAgentId = getTerminalSpec(agent.terminal_spec_id)?.meta?.agent_id;
            if (typeof inboxAgentId !== 'string' || !inboxAgentId) continue;
            targets.push({
                agentId: agent.id,
                inboxAgentId,
                terminalId: agent.terminal_spec_id,
                name: agent.name,
                workspaceId: workspace.id,
            });
        }
    }
    return drainableAgents(targets);
}

/** The running sites, as the restore list wants them. */
function runningSites(): { siteId: string; label: string; workspaceId: string; running: boolean }[] {
    try {
        return (devSiteManager()?.list() ?? []).map((row) => ({
            siteId: row.siteId,
            label: row.name ?? row.siteId,
            workspaceId: row.workspaceId,
            running: row.state === 'running',
        }));
    } catch {
        // A manager that cannot be asked contributes nothing rather than taking
        // the whole roster down with it — the agents are the part a person is
        // waiting on, and they must not be lost to a misbehaving Docker.
        return [];
    }
}

/** The running background processes, as the restore list wants them. */
function runningProcesses(): {
    specId: string;
    label: string;
    workspaceId: string;
    running: boolean;
}[] {
    try {
        const statuses = getProcessStatuses();
        return listTerminalSpecs()
            .filter((spec) => spec.type === 'process')
            .map((spec) => ({
                specId: spec.id,
                label: spec.label,
                workspaceId: spec.workspace_id ?? '',
                running: statuses[spec.id] === 'running',
            }));
    } catch {
        return [];
    }
}

/**
 * Start the drain: record what is running, then nudge every agent.
 *
 * The roster is written BEFORE the first nudge, deliberately. Everything after
 * this point can be interrupted — by a crash, by the user quitting, by the
 * upgrade itself — and a restore list that was never written is the failure the
 * whole restore half exists to prevent. Writing it first costs one row set that
 * a cancelled drain then clears.
 */
export function beginUpgradeDrain(opts: { stuckAfterMs?: number } = {}): Promise<DrainSnapshot> {
    const targets = collectDrainTargets();
    recordDrainRoster(
        getDb(),
        drainRosterFrom({
            agents: targets,
            sites: runningSites(),
            processes: runningProcesses(),
        }),
    );
    return agentUpgradeDrain.begin(targets, opts);
}

/** Abandon the drain, and the restore list with it — nothing was stopped. */
export function cancelUpgradeDrain(): void {
    agentUpgradeDrain.cancel();
    try {
        clearDrainRoster(getDb());
    } catch {
        /* a roster that cannot be cleared is consumed on the next boot instead */
    }
}

/**
 * Did a drain run to completion in THIS process?
 *
 * Deliberately per-process rather than persisted: it means *"the agents in this
 * session were asked, and they answered"*, and the only things it may unlock
 * are the restart that immediately follows and the quit-time readiness barrier
 * that would ask them the same question again. A restart in a later session
 * drains afresh — by then they are different agents, mid-different work.
 */
let drainCleared = false;

export function upgradeDrainCleared(): boolean {
    return drainCleared;
}

export function markUpgradeDrainCleared(): void {
    drainCleared = true;
}

export function drainSnapshot(): DrainSnapshot {
    return agentUpgradeDrain.snapshot();
}

/** The manual satisfy — a person pressed the thumb for a wedged agent. */
export function satisfyDrainRow(agentId: string): DrainSnapshot {
    agentUpgradeDrain.satisfy(agentId);
    return agentUpgradeDrain.snapshot();
}

// --- the restore, on the other side of the upgrade ---------------------------

/** Is a drain's restore list waiting to be consumed by this launch? */
export function pendingDrainRestore(): boolean {
    try {
        return readDrainRoster(getDb()).length > 0;
    } catch {
        return false;
    }
}

/**
 * Start one restored thing, by kind.
 *
 * Deps are injected so the DISPATCH — which start belongs to which kind — is
 * assertable without standing up a site manager, a supervisor and a workspace
 * table. Getting it wrong is silent: a site id handed to `startProcess` starts
 * nothing and throws nothing.
 */
export interface DrainRestoreStarters {
    startAgent: (workspaceId: string, name: string) => Promise<void> | void;
    startSite: (workspaceId: string, siteId: string) => Promise<void> | void;
    startProcess: (specId: string) => void;
}

export async function startDrainEntry(
    entry: DrainRestoreEntry,
    starters: DrainRestoreStarters,
): Promise<void> {
    if (entry.kind === 'agent') {
        await starters.startAgent(entry.workspaceId, entry.label);
        return;
    }
    if (entry.kind === 'site') {
        await starters.startSite(entry.workspaceId, entry.ref);
        return;
    }
    starters.startProcess(entry.ref);
}

const realStarters: DrainRestoreStarters = {
    startAgent: async (workspaceId, name) => {
        const ws = getWorkspace(workspaceId);
        if (!ws) throw new Error(`workspace ${workspaceId} no longer exists`);
        const result = await startRegisteredAgent(
            ws,
            { action: 'start', name },
            { humanInitiated: false },
        );
        // `startRegisteredAgent` REPORTS a refusal rather than throwing, and a
        // refusal that was swallowed here would be reported on the roster as a
        // start that worked.
        if (!result.ok) throw new Error(result.error ?? 'the agent could not be started');
    },
    startSite: async (workspaceId, siteId) => {
        const manager = devSiteManager();
        if (!manager) throw new Error('the dev-site manager is not running');
        const status = await manager.start(workspaceId, siteId);
        if (status.state === 'failed') throw new Error(status.error ?? 'the site failed to start');
    },
    startProcess: (specId) => startProcess(specId),
};

/**
 * Consume the roster: restart what the drain stopped, staggered, then clear it.
 *
 * Cleared in a `finally`. A roster left behind would be replayed by the NEXT
 * ordinary launch, restarting a set from an upgrade that is long over — and by
 * then the user may have stopped half of it deliberately.
 */
export async function runPendingDrainRestore(
    opts: {
        starters?: DrainRestoreStarters;
        gapMs?: number;
        onOutcome?: (outcome: DrainRestoreOutcome) => void;
    } = {},
): Promise<DrainRestoreOutcome[]> {
    let roster: DrainRestoreEntry[] = [];
    try {
        roster = readDrainRoster(getDb()) as DrainRestoreEntry[];
    } catch {
        return [];
    }
    if (roster.length === 0) return [];
    const starters = opts.starters ?? realStarters;
    try {
        return await runDrainRestore({
            roster,
            desired: {
                siteStoppedByUser: (siteId) => {
                    try {
                        return isSiteStoppedByUser(siteId);
                    } catch {
                        // Unreadable desired state is not permission to restart.
                        // The safe direction is the one that cannot undo a stop.
                        return true;
                    }
                },
                processStoppedByUser: (specId) => {
                    try {
                        return getTerminalSpec(specId)?.meta?.user_stopped === true;
                    } catch {
                        return true;
                    }
                },
                // Already up? The roster is written BEFORE the upgrade, so a
                // launch can find one for things that were never stopped — a
                // crash in between, or a restart the user backed out of. Only
                // sites and processes can be in that state and be RESTARTED by
                // a redundant start; `startRegisteredAgent` reattaches to a
                // live agent rather than minting a second one, so an agent
                // needs no equivalent check.
                alreadyRunning: (entry) => {
                    try {
                        if (entry.kind === 'process') {
                            return getProcessStatuses()[entry.ref] === 'running';
                        }
                        if (entry.kind === 'site') {
                            return (
                                devSiteManager()
                                    ?.list()
                                    .find((row) => row.siteId === entry.ref)?.state === 'running'
                            );
                        }
                    } catch {
                        // Unknown is NOT running: the cost of being wrong here
                        // is one redundant restart, and the cost of the other
                        // default is a restore that silently does nothing.
                    }
                    return false;
                },
            },
            ...(opts.gapMs !== undefined ? { gapMs: opts.gapMs } : {}),
            start: (entry) => startDrainEntry(entry, starters),
            ...(opts.onOutcome ? { onOutcome: opts.onOutcome } : {}),
        });
    } finally {
        try {
            clearDrainRoster(getDb());
        } catch {
            /* best-effort — a roster that survives is re-read, not re-run twice */
        }
    }
}
