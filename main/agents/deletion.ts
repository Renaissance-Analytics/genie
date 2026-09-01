import fs from 'node:fs';
import path from 'node:path';
import { readTynnLink } from '../workspace/tynn-link';
import {
    deleteTerminalSpec,
    deleteWorkspaceAgent,
    getWorkspace,
    listAgentRuntimes,
    listWorkspaceAgents,
} from '../db';
import { killTerminalById } from '../terminal/ipc';
import { getWorkspaceAgentById } from './lookup';
import { sidecarNamesOf } from './sidecar';

/**
 * UNMOUNT or DELETE a registered agent — genie#311.
 *
 * The agent card menu had a "Remove leftover" for an ORPHAN (a spec nothing
 * owns) but no way to remove a real, registered agent at all. Adding one
 * plain "Delete" would have been a second, worse dead end: it hides two very
 * different outcomes, and the issue is explicit that guessing wrong between
 * them is not recoverable. So this is deliberately two things, not one:
 *
 *  - `resolveAgentDeletion` (below) is the PURE boundary check for what gets
 *    touched on disk — testable without fs or a database, the same split
 *    `registration.ts` uses for the write side of the same path.
 *  - `deleteRegisteredAgent` is the orchestration: shut down every TUI this
 *    agent may run under, kill its terminal, then apply the plan.
 *
 * Both modes tear down the SAME terminals. The only difference is DELETE
 * additionally removes `.agents/<name>/` from disk; UNMOUNT never does, so
 * the agent can be re-registered later with its persona, purpose and
 * instructions intact — the whole reason the issue asks for two options
 * instead of one destructive button.
 */

export type AgentDeleteMode = 'unmount' | 'delete';

/** The minimal agent shape the boundary check needs — not the full DB row, so
 *  it stays testable without a database. */
export interface AgentDeletionSubject {
    id: string;
    role: string;
    persona_path: string | null;
}

export interface AgentDeletionPlan {
    agentId: string;
    /** Whether `.agents/<name>/` should be removed from disk. */
    removeFiles: boolean;
    /** The directory to remove, already boundary-checked. Null when nothing
     *  on disk should be touched. */
    agentDir: string | null;
}

export type ResolvedAgentDeletion =
    | { ok: true; plan: AgentDeletionPlan }
    | { ok: false; error: string };

/** Mirrors `resolveAgentRegistration`'s guard in `registration.ts`: fail
 *  closed rather than trust a path that has drifted outside the folder it is
 *  supposed to live under. */
function contained(root: string, candidate: string): boolean {
    const rel = path.relative(root, candidate);
    return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Resolve what deleting/unmounting an agent should touch ON DISK.
 *
 * UNMOUNT never removes a file — keeping every `.agents/*` file is the entire
 * point. DELETE removes exactly the `.agents/<name>/` folder computed at
 * registration (`resolveAgentRegistration`'s `personaPath`), and ONLY when it
 * is still genuinely under the workspace's `.agents/` folder: a hand-edited
 * `persona_path` pointing elsewhere — or AT `.agents/` itself — must not turn
 * one agent's delete into wiping every agent's files.
 */
export function resolveAgentDeletion(
    workspaceRoot: string,
    agent: AgentDeletionSubject,
    mode: AgentDeleteMode,
): ResolvedAgentDeletion {
    if (agent.role === 'workspace') {
        return {
            ok: false,
            error: 'The workspace agent is not a specialized agent — it cannot be deleted.',
        };
    }
    if (mode === 'unmount' || !agent.persona_path) {
        return { ok: true, plan: { agentId: agent.id, removeFiles: false, agentDir: null } };
    }
    const agentsRoot = path.resolve(workspaceRoot, '.agents');
    const agentDir = path.resolve(path.dirname(agent.persona_path));
    if (agentDir === agentsRoot || !contained(agentsRoot, agentDir)) {
        return { ok: true, plan: { agentId: agent.id, removeFiles: false, agentDir: null } };
    }
    return { ok: true, plan: { agentId: agent.id, removeFiles: true, agentDir } };
}

/** The minimal shapes `terminalsToStopFor` needs, so it stays testable
 *  without a database — the same split `resolveAgentDeletion` uses above. */
export interface TerminalsToStopSubject {
    id: string;
    name: string;
    workspace_id: string;
    terminal_spec_id: string | null;
}

export interface TerminalsToStopDeps {
    runtimes: (agentId: string) => ReadonlyArray<{ terminal_spec_id: string | null }>;
    roster: (workspaceId: string) => ReadonlyArray<{ name: string; id: string; terminal_spec_id: string | null }>;
}

/**
 * Every terminal stopping this agent is about to kill.
 *
 * Its own legacy `terminal_spec_id` binding, every `agent_runtimes` row it
 * fronts, AND its SIDECARS — a sidecar is a separate `workspace_agents` row
 * named `<driver>-slave`, so killing only this agent’s own terminals left
 * `moic-slave` running against work whose driver no longer exists.
 *
 * De-duplicated, because `workspace_agents.terminal_spec_id` and an
 * `agent_runtimes` binding can be the SAME terminal.
 *
 * Exported because two callers must not answer this differently: the delete
 * KILLS these, and the handoff request ASKS these. Asking a terminal that is
 * not about to be killed wastes an agent’s turn; killing one that was never
 * asked loses the note the human ticked the box for.
 */
export function terminalsToStopFor(
    agent: TerminalsToStopSubject,
    deps: TerminalsToStopDeps = { runtimes: listAgentRuntimes, roster: listWorkspaceAgents },
): string[] {
    const terminalIds = new Set<string>();
    if (agent.terminal_spec_id) terminalIds.add(agent.terminal_spec_id);
    for (const runtime of deps.runtimes(agent.id)) {
        if (runtime.terminal_spec_id) terminalIds.add(runtime.terminal_spec_id);
    }
    for (const sidecar of sidecarNamesOf(agent.name, deps.roster(agent.workspace_id))) {
        if (sidecar.terminal_spec_id) terminalIds.add(sidecar.terminal_spec_id);
        for (const runtime of deps.runtimes(sidecar.id)) {
            if (runtime.terminal_spec_id) terminalIds.add(runtime.terminal_spec_id);
        }
    }
    return [...terminalIds];
}
export interface DeleteAgentResult {
    ok: boolean;
    error?: string;
    /** Whether `.agents/<name>/` was actually removed from disk. */
    filesRemoved: boolean;
    /** Whether this agent's WORKSPACE carries a live Tynn project link (via
     *  `project.json`'s `tynn` block). Informational only — there is no
     *  per-agent Tynn record, and nothing here acts on this. */
    workspaceTynnLinked: boolean;
}

/**
 * Tear down and remove a registered agent.
 *
 * Kills every terminal the agent could be running under — its own legacy
 * `terminal_spec_id` binding AND every `agent_runtimes` row's binding,
 * de-duplicated, since the two can point at the same terminal. Then applies
 * `resolveAgentDeletion`'s plan and drops the database row.
 *
 * Touches nothing in Tynn. An earlier version of this took a `removeFromTynn`
 * opt-in and returned a note explaining it did nothing — which still leaves a
 * control in the UI promising an action the code cannot perform, just with a
 * caveat attached instead of doing it silently. Per the workspace UX spec (a
 * surface must not depend on something it does not own), the honest fix is to
 * not offer it at all until a real per-agent Tynn link exists to act on.
 */
export function deleteRegisteredAgent(
    agentId: string,
    mode: AgentDeleteMode,
): DeleteAgentResult {
    const agent = getWorkspaceAgentById(agentId);
    if (!agent) {
        return {
            ok: false,
            error: 'That agent is no longer registered.',
            filesRemoved: false,
            workspaceTynnLinked: false,
        };
    }

    const ws = getWorkspace(agent.workspace_id);
    const workspaceTynnLinked = !!ws && !!readTynnLink(ws.path);

    const resolved = resolveAgentDeletion(ws?.path ?? '', agent, mode);
    if (!resolved.ok) {
        return { ok: false, error: resolved.error, filesRemoved: false, workspaceTynnLinked };
    }

    // Every terminal this stop kills — its own, its runtimes’, and its
    // SIDECARS’. Unmounting and deleting both STOP the sidecars; neither
    // deletes their records, because removing an agent the person did not name
    // is not something to infer from an instruction to remove this one.
    const terminalIds = terminalsToStopFor(agent);
    for (const id of terminalIds) {
        killTerminalById(id);
        deleteTerminalSpec(id);
    }

    let filesRemoved = false;
    if (resolved.plan.removeFiles && resolved.plan.agentDir) {
        try {
            fs.rmSync(resolved.plan.agentDir, { recursive: true, force: true });
            filesRemoved = true;
        } catch {
            // Best-effort: a locked/open file must not leave the agent stuck
            // registered because ONE file under it couldn't be removed.
        }
    }

    deleteWorkspaceAgent(agent.id);

    return { ok: true, filesRemoved, workspaceTynnLinked };
}
