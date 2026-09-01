import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    addWorkspace,
    bindWorkspaceAgentTerminal,
    createAgentRuntime,
    createTerminalSpec,
    createWorkspaceAgent,
    deleteWorkspaceAgent,
    frontedAgentRuntime,
    initDatabase,
    listAgentRuntimes,
    listWorkspaceAgents,
} from '../db';

/**
 * Binding a terminal must reach the SOURCE OF TRUTH, not only its cache.
 *
 * v55 split the record: `agent_runtimes` holds each TUI an agent may run under,
 * at most one of them fronted, and `workspace_agents.terminal_spec_id` stays as
 * a CACHED MIRROR of the fronted runtime (see `agent-runtimes.test.ts`).
 *
 * `bindWorkspaceAgentTerminalInDb` wrote the mirror and nothing else. So an
 * agent that was demonstrably running in a terminal still reported
 * `terminal_spec_id: null` on its fronted runtime, and every surface that asks
 * "is this agent running, and in which TUI" through `frontedAgentRuntime` read
 * that null as STOPPED — which is why clicking a saved agent's icon spawned a
 * second agent instead of attaching to the one already there (#310).
 *
 * The same write clears `transport_verified_at` / `transport_error` on the agent
 * row only, so a runtime kept a stale "transport verified" from a previous
 * session after this session's channel had failed (#314).
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-bind-'));
const dataDir = path.join(tmpRoot, 'userData');
fs.mkdirSync(dataDir, { recursive: true });
(app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;
initDatabase(dataDir);

const WS = 'ws-bind';
addWorkspace({
    id: WS,
    backend: 'tynn',
    project_id: WS,
    project_name: 'Bind',
    tynn_project_id: WS,
    tynn_project_name: 'Bind',
    shape: 'simple',
    path: tmpRoot,
    editor: null,
    editor_cmd: null,
    start_cmd: null,
    env_file: null,
    last_opened_at: null,
    created_by_genie: 0,
});

let seq = 0;
function agent(name: string): string {
    const id = `bind-agent-${++seq}`;
    createWorkspaceAgent({
        id,
        workspace_id: WS,
        provider: null,
        name,
        purpose: '',
        avatar: null,
        boot_cwd: null,
        persona_path: null,
        role: 'specialized',
        parent_agent_id: null,
        terminal_spec_id: null,
        reachability: 'workspace',
        wake_on_dm: 1,
    });
    return id;
}

function terminal(id: string): string {
    createTerminalSpec({
        id,
        workspace_id: WS,
        label: id,
        cwd: tmpRoot,
        type: 'terminal',
        meta: { agent: 'claude' },
    });
    return id;
}

beforeEach(() => {
    for (const a of listWorkspaceAgents(WS)) {
        deleteWorkspaceAgent(a.id);
    }
});

describe('binding a terminal to an agent (#310)', () => {
    it('writes the terminal onto the FRONTED RUNTIME, not just the mirror', () => {
        const id = agent('tynn');
        createAgentRuntime({ agentId: id, provider: 'claude', fronted: true });
        const term = terminal('term-bind-1');

        bindWorkspaceAgentTerminal(id, term);

        // The authority, not the cache. This is what `frontedAgentRuntime`
        // reports and what every "is it running" surface reads.
        expect(frontedAgentRuntime(id)?.terminal_spec_id).toBe(term);
    });

    it('keeps the cached mirror in step with the runtime', () => {
        // POSITIVE CONTROL: the mirror must not regress while we fix the
        // authority — a great deal of code still reads it.
        const id = agent('tynn');
        createAgentRuntime({ agentId: id, provider: 'claude', fronted: true });
        const term = terminal('term-bind-2');

        bindWorkspaceAgentTerminal(id, term);

        const row = listWorkspaceAgents(WS).find((a) => a.id === id);
        expect(row?.terminal_spec_id).toBe(term);
        expect(frontedAgentRuntime(id)?.terminal_spec_id).toBe(row?.terminal_spec_id);
    });

    it('unbinding clears the runtime too, so the agent reads as stopped', () => {
        const id = agent('tynn');
        createAgentRuntime({ agentId: id, provider: 'claude', fronted: true });
        const term = terminal('term-bind-3');
        bindWorkspaceAgentTerminal(id, term);
        // POSITIVE CONTROL: assert it was actually bound first. Without this the
        // unbind assertion passes on a corpse — `terminal_spec_id` starts null,
        // so "it is null afterwards" proves nothing on its own.
        expect(frontedAgentRuntime(id)?.terminal_spec_id).toBe(term);

        bindWorkspaceAgentTerminal(id, null);

        expect(frontedAgentRuntime(id)?.terminal_spec_id).toBeNull();
    });

    it('binds the FRONTED runtime, leaving a sidecar runtime alone', () => {
        // An agent may hold several TUIs. Only the visible one is backed by this
        // terminal; a sidecar keeping its conversation warm must not be
        // repointed at a terminal that is not its own.
        const id = agent('tynn');
        createAgentRuntime({ agentId: id, provider: 'claude', fronted: true });
        const sidecar = createAgentRuntime({ agentId: id, provider: 'codex' });
        const term = terminal('term-bind-4');

        bindWorkspaceAgentTerminal(id, term);

        expect(frontedAgentRuntime(id)?.terminal_spec_id).toBe(term);
        const still = listAgentRuntimes(id).find((r) => r.id === sidecar.id);
        expect(still?.terminal_spec_id).toBeNull();
    });
});
