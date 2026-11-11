import { chatCommsOf } from '../core/chat-view.js';
import type { AgentId, AgentRecord } from '../core/identity.js';
import type { InboxMessage } from './inbox-store.js';
import { issueWatchPrefsFor } from '../core/issue-watch.js';
import type { TakeOverProbe } from '../core/observed.js';
import { sessionCostOf } from '../core/stream-view.js';
import { lastNumberedTurn } from '../core/turn-numbers.js';
import type { AgentDetail } from '../renderer/bridge.js';
import type { AgentEngine } from './agent-engine.js';
import { raisesApprovals } from './session-host.js';

/**
 * AN AGENT'S DETAIL, AS EVERY SURFACE READS IT (Tynn #551, host split P5d.2): the Agent view's header, its stream, its
 * cost and its mail. One builder for the window (main.ts) and for genie-host, which answers a phone with every window
 * closed — so a phone sees the same agent whichever of them answered.
 */
export interface AgentDetailPorts {
    readonly registry: {
        find(id: AgentId): AgentRecord | null;
        listAgents(): readonly AgentRecord[];
        defaultAgentOf(workspaceId: string): string | null;
    };
    /** The session host: genie-host's own, or a window's link to it. */
    readonly engine: Pick<AgentEngine, 'probe' | 'ledgerFor' | 'turnsFor' | 'recentStderrFor' | 'rowsFor' | 'refusals'> | null;
    readonly cwdFor: (record: AgentRecord) => string;
    /** A live Take Over window on it (the window's only); absent = none. */
    readonly takeOver?: (id: AgentId) => TakeOverProbe | null;
    /** Its AgentInbox mail; absent = none known here. */
    readonly mail?: (id: AgentId, limit: number) => readonly InboxMessage[];
}

export function agentDetailFor(ports: AgentDetailPorts, agentId: AgentId): AgentDetail | null {
    const record = ports.registry.find(agentId);
    const host = ports.engine;
    if (!record || !host) return null;
    // A live Take Over window makes this agent OBSERVED here too — the same probe the Dashboard row reads, so the
    // Agent view and the board cannot disagree about what Genie can see of it (§4.2: tabs by fidelity).
    const takeOver = ports.takeOver?.(record.id) ?? null;
    return {
        agent: {
            id: record.id,
            workspaceId: record.workspaceId,
            name: record.name,
            provider: record.provider,
            // Every registered agent speaks ACP; `observed` while its Take Over window is open; `remote` belongs to
            // another workstation.
            fidelity: takeOver ? 'observed' : 'declared',
            cwd: ports.cwdFor(record),
            dailyBudgetUsd: record.dailyBudgetUsd ?? null,
            mode: record.mode,
            accessScope: record.accessScope,
            // Chosen agents (Tynn #526): only when the choice is on.
            ...(Array.isArray(record.accessAgents) ? { accessAgents: record.accessAgents } : {}),
            autoApprove: record.autoApprove === true,
            manageTabs: record.manageTabs === true,
            drivePages: record.drivePages === true,
            // Its MCP servers (Tynn #628): the ones switched off, and every one a session reported.
            ...(record.mcpOff && record.mcpOff.length > 0 ? { mcpOff: record.mcpOff } : {}),
            ...(record.mcpSeen && record.mcpSeen.length > 0 ? { mcpSeen: record.mcpSeen } : {}),
            // What it hears from IssueWatch now: its own setting, or the default its place in the workspace gives it (Tynn #806).
            issueWatch: issueWatchPrefsFor(record, ports.registry.listAgents(), ports.registry.defaultAgentOf(record.workspaceId)),
            permissions: record.permissions ?? 'all',
            // The model CHOSEN (null = the provider's default); the one IN USE is the session's, as reported.
            model: record.model ?? null,
            instructions: record.instructions ?? null,
            // Whether this agent can ask for approval at all (the driver's own claim, or a Claude agent set to ask before
            // shell commands); a Take Over window says nothing.
            raisesApprovals: takeOver ? null : raisesApprovals(record.provider, record.permissions),
        },
        session: host.probe(record.id),
        // The agent's recorded history, then this run (Claude does not replay a resumed conversation).
        rows: host.ledgerFor(record.id),
        // The number the Turns column shows for the latest turn, so the pill (`Turn 12 · running`) agrees with it.
        turns: lastNumberedTurn(host.ledgerFor(record.id)) || host.turnsFor(record.id),
        // The engine's own recent words, for the process-ended block (the board's error state).
        log: host.recentStderrFor(record.id),
        // The session's running total, from the latest usage report (claude reports it; codex does not). `null` means
        // there is no Cost row — never a `$0.00`, which would claim the work was free.
        cost: sessionCostOf(host.rowsFor(record.id)),
        refusal: host.refusals.get(record.id) ?? null,
        takeOver,
        // Its AgentInbox mail — with other agents AND the person (an FTQ answer is the person's) — for the mail rows in its
        // chat (core/chat-view.ts `chatCommsOf`).
        comms: ports.mail ? chatCommsOf(ports.mail(record.id, 50)) : null,
    };
}
