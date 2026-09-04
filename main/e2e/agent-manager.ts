import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    addWorkspace,
    createWorkspaceAgent,
    deleteWorkspaceAgent,
    getWorkspace,
    listWorkspaceAgents,
} from '../db';

/**
 * Deterministic fixture for the AGENT MANAGER E2E spec (e2e/agent-manager.spec.ts,
 * Tynn #709 / story #263).
 *
 * NOTHING here is mocked, deliberately. The unit suite already pins the pure
 * decisions — `applyPersonaEdit`, `agentMcpServers`, `sidecarsOf`. What it
 * cannot reach is the chain that actually delivers them to a person: real
 * `AGENT.md` on disk → `parseAgentFile` → IPC → preload → renderer → edit →
 * IPC → `renderAgentFile` → real file → read back. A green vitest run says
 * nothing about whether a save lands, and a save that silently drops a header
 * key would look identical on screen to one that did not.
 *
 * So this seeds REAL FILES in a temp workspace: an `AGENT.md` carrying a header
 * key Genie has no field for, and a `.mcp.json` with a `genie` server and two
 * ordinary ones. The spec then asserts the round-trip against the bytes.
 *
 * IDEMPOTENT AND RESETTING for the same reason `agent-access.ts` is:
 * `launchGenieE2E` reuses one throwaway profile across runs, so without an
 * explicit reset the spec's own edits would leak into the next run and its
 * assertions would pass once and then lie.
 */

const WORKSPACE_ID = 'e2e-agent-manager-ws';
const WORKSPACE_NAME = 'E2E Agent Manager Workspace';
const AGENT_ID = 'e2e-agent-manager-agent';
const SIDECAR_ID = 'e2e-agent-manager-sidecar';
const AGENT_NAME = 'moic';
const SIDECAR_NAME = 'moic-slave';

/** A header key Genie has no field for. The whole point of the round-trip
 *  assertion: a save must carry it through untouched. */
export const UNRENDERED_KEY = 'model';
export const UNRENDERED_VALUE = 'opus';

const AGENT_MD = [
    '---',
    `name: ${AGENT_NAME}`,
    'purpose: agent management',
    'tuis: [claude, codex]',
    `${UNRENDERED_KEY}: ${UNRENDERED_VALUE}`,
    '---',
    '',
    'You are moic. Original prompt.',
    '',
].join('\n');

/** A `genie` server the surface must refuse to remove, plus two it may. */
const MCP_JSON = {
    mcpServers: {
        genie: { type: 'http', url: 'http://127.0.0.1:8317/mcp/e2e' },
        playwright: { command: 'npx', args: ['@playwright/mcp'] },
        fetch: { type: 'http', url: 'https://example.invalid/mcp' },
    },
};

export interface AgentManagerSeed {
    workspaceId: string;
    workspacePath: string;
    agentId: string;
    agentName: string;
    personaPath: string;
    mcpPath: string;
    sidecarName: string;
    unrenderedLine: string;
}

function workspaceRoot(): string {
    return path.join(os.tmpdir(), 'genie-e2e-agent-manager');
}

/**
 * Seed the workspace, its files and its two agent rows, resetting anything a
 * previous run changed.
 */
export function seedAgentManagerE2E(): AgentManagerSeed {
    const root = workspaceRoot();
    const personaPath = path.join(root, '.agents', AGENT_NAME, 'AGENT.md');
    const mcpPath = path.join(root, '.mcp.json');

    // Files first: the harness page reads them through main the moment it mounts.
    fs.mkdirSync(path.dirname(personaPath), { recursive: true });
    fs.writeFileSync(personaPath, AGENT_MD);
    fs.writeFileSync(mcpPath, JSON.stringify(MCP_JSON, null, 2) + '\n');

    if (!getWorkspace(WORKSPACE_ID)) {
        addWorkspace({
            id: WORKSPACE_ID,
            backend: 'aionima',
            project_id: WORKSPACE_ID,
            project_name: WORKSPACE_NAME,
            tynn_project_id: WORKSPACE_ID,
            tynn_project_name: WORKSPACE_NAME,
            shape: 'simple',
            path: root,
            editor: null,
            editor_cmd: null,
            start_cmd: null,
            env_file: null,
            last_opened_at: null,
            created_by_genie: 0,
            sort_order: 0,
        });
    }

    // Rebuild the rows rather than trusting whatever the last run left: the
    // spec's own saves mutate `purpose`, and a stale row would make the
    // "purpose round-trips" assertion pass against a value it did not write.
    for (const existing of listWorkspaceAgents(WORKSPACE_ID)) {
        deleteWorkspaceAgent(existing.id);
    }
    createWorkspaceAgent({
        id: AGENT_ID,
        workspace_id: WORKSPACE_ID,
        tui: 'claude',
        name: AGENT_NAME,
        purpose: 'agent management',
        avatar: null,
        boot_cwd: root,
        persona_path: personaPath,
        role: 'specialized',
        parent_agent_id: null,
        reachability: 'workspace',
        wake_on_dm: 1,
    });
    // A sidecar, so the sidecar tab has something real to resolve. Registered
    // with a parent link AND the name convention, which is what the resolver
    // reads (see main/agents/sidecar-control.ts).
    createWorkspaceAgent({
        id: SIDECAR_ID,
        workspace_id: WORKSPACE_ID,
        tui: 'codex',
        name: SIDECAR_NAME,
        purpose: 'agent management',
        avatar: null,
        boot_cwd: root,
        persona_path: path.join(root, '.agents', SIDECAR_NAME, 'AGENT.md'),
        role: 'specialized',
        parent_agent_id: AGENT_ID,
        reachability: 'workspace',
        wake_on_dm: 1,
    });

    const seed: AgentManagerSeed = {
        workspaceId: WORKSPACE_ID,
        workspacePath: root,
        agentId: AGENT_ID,
        agentName: AGENT_NAME,
        personaPath,
        mcpPath,
        sidecarName: SIDECAR_NAME,
        unrenderedLine: `${UNRENDERED_KEY}: ${UNRENDERED_VALUE}`,
    };
    (globalThis as Record<string, unknown>).__GENIE_E2E_AGENT_MANAGER__ = seed;
    // The spec's file reader. Exposed the way the terminal-recovery harness
    // exposes its emitters: `app.evaluate` runs in MAIN, and reaching a module
    // by relative import from there is a path that breaks the moment the build
    // layout moves.
    (globalThis as Record<string, unknown>).__GENIE_E2E_AGENT_MANAGER_READ__ =
        readAgentManagerPersonaFile;
    return seed;
}

/**
 * Read `AGENT.md` back off disk.
 *
 * The assertion the DOM cannot make. A renderer that kept the edit in state and
 * never wrote it looks exactly like one that saved — only the bytes tell them
 * apart, and only the bytes show whether the untouched header key survived.
 */
export function readAgentManagerPersonaFile(): string {
    try {
        return fs.readFileSync(
            path.join(workspaceRoot(), '.agents', AGENT_NAME, 'AGENT.md'),
            'utf8',
        );
    } catch {
        return '';
    }
}
