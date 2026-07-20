import os from 'node:os';
import path from 'node:path';
import {
    addWorkspace,
    getWorkspace,
    setWorkspaceAgentAccess,
    type WorkspaceRow,
} from '../db';

/**
 * Deterministic fixture for the AGENT ACCESS E2E spec (e2e/agent-access.spec.ts,
 * Tynn story #218).
 *
 * Unlike the GitHub/IssueWatch harnesses this does NOT mock any IPC — the point
 * of that spec is to exercise the REAL chain (v27 migration → db accessors → IPC
 * → preload → renderer → back). All it needs is state to act on: two workspaces,
 * so the `specific` multi-select has a peer to offer AND the persistence path
 * (`UPDATE workspaces SET agent_access = ? WHERE id = ?`) has a row to hit.
 *
 * IDEMPOTENT AND RESETTING, deliberately. `launchGenieE2E` reuses one throwaway
 * profile (`genie-e2e-profile` in tmpdir) across runs, so without an explicit
 * reset the spec's own mutations would leak into the next run and the
 * "defaults to 'all'" assertion would fail on the second execution — a
 * self-poisoning test that passes once and then lies. Re-seeding restores the
 * default rather than assuming a clean database.
 */

/** Fixed ids so re-runs update the same rows instead of piling up workspaces. */
const PRIMARY_ID = 'e2e-agent-access-primary';
const PEER_ID = 'e2e-agent-access-peer';
const PRIMARY_NAME = 'E2E Primary Workspace';
const PEER_NAME = 'E2E Peer Workspace';

export interface AgentAccessSeed {
    workspaceId: string;
    workspaceName: string;
    peerId: string;
    peerName: string;
}

function ensureWorkspace(id: string, name: string, order: number): void {
    if (getWorkspace(id)) return;
    addWorkspace({
        id,
        backend: 'aionima',
        project_id: id,
        project_name: name,
        tynn_project_id: id,
        tynn_project_name: name,
        shape: 'simple',
        // Never a real path on disk — nothing in this spec touches the filesystem.
        path: path.join(os.tmpdir(), 'genie-e2e-agent-access', id),
        editor: null,
        editor_cmd: null,
        start_cmd: null,
        env_file: null,
        last_opened_at: null,
        created_by_genie: 0,
        sort_order: order,
    });
}

/**
 * Seed the two fixture workspaces and RESET their agent-access to the shipped
 * default, then publish the ids so the spec can assert against real names.
 */
export function seedAgentAccessE2E(): AgentAccessSeed {
    ensureWorkspace(PRIMARY_ID, PRIMARY_NAME, 0);
    ensureWorkspace(PEER_ID, PEER_NAME, 1);
    // Reset BOTH tiers of leftover state from a previous run.
    setWorkspaceAgentAccess(PRIMARY_ID, 'all', []);
    setWorkspaceAgentAccess(PEER_ID, 'all', []);

    const seed: AgentAccessSeed = {
        workspaceId: PRIMARY_ID,
        workspaceName: PRIMARY_NAME,
        peerId: PEER_ID,
        peerName: PEER_NAME,
    };
    (globalThis as Record<string, unknown>).__GENIE_E2E_AGENT_ACCESS__ = seed;
    return seed;
}

/** The workspace the harness page mounts the panel for. */
export function agentAccessPrimaryId(): string {
    return PRIMARY_ID;
}

/** Exported for typing convenience in the harness page. */
export type { WorkspaceRow };
