import fs from 'node:fs';
import path from 'node:path';
import { readTynnLink } from '../workspace/tynn-link';
import {
    deleteTerminalSpec,
    deleteWorkspaceAgent,
    getWorkspace,
    listAgentRuntimes,
} from '../db';
import { killTerminalById } from '../terminal/ipc';
import { getWorkspaceAgentById } from './lookup';

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

export interface DeleteAgentOptions {
    /** Explicit opt-in from the confirm prompt — never inferred, never a
     *  silent side effect of choosing DELETE. */
    removeFromTynn?: boolean;
}

export interface DeleteAgentResult {
    ok: boolean;
    error?: string;
    /** Whether `.agents/<name>/` was actually removed from disk. */
    filesRemoved: boolean;
    /** Whether this agent's WORKSPACE carries a live Tynn project link —
     *  the closest real signal to "this agent is synced with Tynn" that
     *  exists today (there is no per-agent link; only a workspace can be
     *  Tynn-linked, via `project.json`'s `tynn` block). */
    workspaceTynnLinked: boolean;
    /** Set only when `removeFromTynn` was asked for. Genie has no per-agent
     *  Tynn record to remove yet, so this says so plainly rather than the
     *  checkbox silently doing nothing — see the module comment. */
    tynnNote?: string;
}

/**
 * Tear down and remove a registered agent.
 *
 * Kills every terminal the agent could be running under — its own legacy
 * `terminal_spec_id` binding AND every `agent_runtimes` row's binding,
 * de-duplicated, since the two can point at the same terminal. Then applies
 * `resolveAgentDeletion`'s plan and drops the database row.
 *
 * `removeFromTynn` is accepted but not acted on: there is no per-agent Tynn
 * record to remove today, only a workspace-level link. Rather than silently
 * doing nothing when it is checked — which is exactly the "silent side
 * effect" the issue warns against, just inverted — the result carries a plain
 * `tynnNote` the caller can surface, so the human is never left assuming Tynn
 * was touched when it wasn't.
 */
export function deleteRegisteredAgent(
    agentId: string,
    mode: AgentDeleteMode,
    opts: DeleteAgentOptions = {},
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

    // Every TUI this agent may run under, plus its own legacy binding —
    // de-duplicated, because `workspace_agents.terminal_spec_id` and an
    // `agent_runtimes` row's binding can be the SAME terminal.
    const terminalIds = new Set<string>();
    if (agent.terminal_spec_id) terminalIds.add(agent.terminal_spec_id);
    for (const runtime of listAgentRuntimes(agent.id)) {
        if (runtime.terminal_spec_id) terminalIds.add(runtime.terminal_spec_id);
    }
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

    const tynnNote = opts.removeFromTynn
        ? workspaceTynnLinked
            ? "Genie doesn't yet support removing an individual agent from Tynn — nothing changed there."
            : "This workspace isn't linked to Tynn, so there was nothing to remove there."
        : undefined;

    return {
        ok: true,
        filesRemoved,
        workspaceTynnLinked,
        ...(tynnNote ? { tynnNote } : {}),
    };
}
