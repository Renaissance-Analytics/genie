import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    addWorkspace,
    addRuntimeAndFront,
    createAgentRuntime,
    createWorkspaceAgent,
    deleteWorkspaceAgent,
    initDatabase,
    listAgentRuntimes,
    listWorkspaceAgents,
} from '../db';

/**
 * SWITCHING TO A TUI THE AGENT HAS NEVER RUN (genie#726).
 *
 * This is the step that makes a sidecar exist: an agent driven by `claude` is
 * asked for `codex`, so a second runtime is recorded and takes the chair while
 * the claude one stays behind as the hidden conversation to flip back to.
 *
 * It was IMPOSSIBLE through the MCP `runAgent switchTui` verb. That path
 * inserted the new runtime with `fronted: true` while the old one was still
 * fronted, which trips `idx_agent_runtimes_fronted` — `UNIQUE (agent_id) WHERE
 * fronted = 1` — and threw before reaching the `frontAgentRuntime` call on the
 * very next line that would have done the swap properly:
 *
 *     UNIQUE constraint failed: agent_runtimes.agent_id
 *
 * The renderer's own path (`agentRecordAddRuntime` in main/ipc.ts) had it right
 * all along: create UNFRONTED, then front. Two call sites for one invariant,
 * one of them wrong — so the fix is not to patch the flag at the bad site but
 * to give both the same step, which is what this exercises.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-switch-tui-'));
const dataDir = path.join(tmpRoot, 'userData');
fs.mkdirSync(dataDir, { recursive: true });
(app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;
initDatabase(dataDir);

const WS = 'ws-switch-tui';
addWorkspace({
    id: WS,
    backend: 'tynn',
    project_id: WS,
    project_name: 'Switch',
    tynn_project_id: WS,
    tynn_project_name: 'Switch',
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
    const id = `switch-agent-${++seq}`;
    createWorkspaceAgent({
        id,
        workspace_id: WS,
        tui: null,
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

beforeEach(() => {
    for (const a of listWorkspaceAgents(WS)) deleteWorkspaceAgent(a.id);
});

describe('switching an agent to a TUI it has never run', () => {
    it('adds the new TUI and fronts it while an existing one is fronted', () => {
        const id = agent('tynn');
        createAgentRuntime({ agentId: id, tui: 'claude', fronted: true });

        // THE BUG: this threw `UNIQUE constraint failed: agent_runtimes.agent_id`
        // because the incoming runtime was inserted already fronted, beside a
        // runtime that was still fronted.
        const created = addRuntimeAndFront(id, 'codex');

        expect(created.tui).toBe('codex');
        const runtimes = listAgentRuntimes(id);
        expect(runtimes.map((r) => r.tui).sort()).toEqual(['claude', 'codex']);
    });

    it('leaves EXACTLY ONE fronted runtime, and it is the one asked for', () => {
        const id = agent('tynn');
        createAgentRuntime({ agentId: id, tui: 'claude', fronted: true });

        addRuntimeAndFront(id, 'codex');

        const fronted = listAgentRuntimes(id).filter((r) => r.fronted === 1);
        expect(fronted).toHaveLength(1);
        expect(fronted[0].tui).toBe('codex');
    });

    it('keeps the TUI it left as a SIDECAR rather than dropping it', () => {
        const id = agent('tynn');
        const claude = createAgentRuntime({ agentId: id, tui: 'claude', fronted: true });

        addRuntimeAndFront(id, 'codex');

        // The whole point of the switch: the claude row survives, un-fronted,
        // with its identity intact, so its conversation can be flipped back to.
        const left = listAgentRuntimes(id).find((r) => r.id === claude.id);
        expect(left).toBeDefined();
        expect(left!.fronted).toBe(0);
    });

    it('is idempotent on the TUI already in the chair — no second row', () => {
        const id = agent('tynn');
        createAgentRuntime({ agentId: id, tui: 'claude', fronted: true });

        addRuntimeAndFront(id, 'claude');

        const runtimes = listAgentRuntimes(id);
        expect(runtimes).toHaveLength(1);
        expect(runtimes[0]).toMatchObject({ tui: 'claude', fronted: 1 });
    });

    it('re-fronts an EXISTING sidecar instead of creating a duplicate', () => {
        const id = agent('tynn');
        createAgentRuntime({ agentId: id, tui: 'claude', fronted: true });
        const codex = createAgentRuntime({ agentId: id, tui: 'codex' });

        const out = addRuntimeAndFront(id, 'codex');

        // Flipping BACK to a sidecar must reuse its row — a second row for the
        // same TUI would strand the conversation the sidecar exists to keep.
        expect(out.id).toBe(codex.id);
        expect(listAgentRuntimes(id)).toHaveLength(2);
        const fronted = listAgentRuntimes(id).filter((r) => r.fronted === 1);
        expect(fronted.map((r) => r.tui)).toEqual(['codex']);
    });

    it('works from a standing start, when the agent has no runtimes at all', () => {
        const id = agent('fresh');

        const created = addRuntimeAndFront(id, 'claude');

        expect(created.tui).toBe('claude');
        expect(listAgentRuntimes(id)).toHaveLength(1);
        expect(listAgentRuntimes(id)[0].fronted).toBe(1);
    });
});
