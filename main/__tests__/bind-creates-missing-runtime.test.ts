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
 * Binding must CREATE the fronted runtime when the agent has none.
 *
 * An agent registered through the New Agent form has no `agent_runtimes` row —
 * that is the documented dormant state, "a registered agent with no TUI yet".
 * The #310 fix taught `bindWorkspaceAgentTerminalInDb` to write the runtime as
 * well as its cached mirror, but it did so with an UPDATE:
 *
 *     UPDATE agent_runtimes SET terminal_spec_id = ? WHERE agent_id = ? AND fronted = 1
 *
 * An UPDATE against a table with no matching row touches NOTHING. So for every
 * freshly-registered agent the terminal was created and the mirror written while
 * the authority stayed empty — and since #310 made the runtime the thing
 * `frontedAgentRuntime` reads, every surface then reported a running agent as
 * not running. Observed live: agent `916104a0` held terminal `7d3102c7`, that
 * terminal was online, and `agent_runtimes` for it was empty.
 *
 * That is a regression #310 introduced: before it, only the mirror was written
 * and only the mirror was read, so a missing runtime cost nothing.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-bindnew-'));
const dataDir = path.join(tmpRoot, 'userData');
fs.mkdirSync(dataDir, { recursive: true });
(app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;
initDatabase(dataDir);

const WS = 'ws-bindnew';
addWorkspace({
    id: WS,
    backend: 'tynn',
    project_id: WS,
    project_name: 'BindNew',
    tynn_project_id: WS,
    tynn_project_name: 'BindNew',
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
/** A freshly REGISTERED agent: tui chosen, no runtime — what the New
 *  Agent form produces. */
function registeredAgent(name: string, tui = 'claude'): string {
    const id = `bindnew-${++seq}`;
    createWorkspaceAgent({
        id,
        workspace_id: WS,
        tui,
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

describe('binding an agent that has never run', () => {
    it('CREATES the fronted runtime — an UPDATE would touch nothing', () => {
        const id = registeredAgent('fresh');
        // POSITIVE CONTROL: this is genuinely the no-runtime state the New Agent
        // form leaves behind, not an agent we quietly gave a runtime to.
        expect(listAgentRuntimes(id)).toEqual([]);
        const term = terminal('term-new-1');

        bindWorkspaceAgentTerminal(id, term);

        expect(frontedAgentRuntime(id)?.terminal_spec_id).toBe(term);
    });

    it('records the agent’s tui on the runtime it creates', () => {
        const id = registeredAgent('fresh-codex', 'codex');
        bindWorkspaceAgentTerminal(id, terminal('term-new-2'));

        expect(frontedAgentRuntime(id)?.tui).toBe('codex');
    });

    it('creates exactly ONE runtime, and re-binding does not add another', () => {
        const id = registeredAgent('fresh-once');
        bindWorkspaceAgentTerminal(id, terminal('term-new-3'));
        bindWorkspaceAgentTerminal(id, terminal('term-new-4'));

        expect(listAgentRuntimes(id)).toHaveLength(1);
        expect(frontedAgentRuntime(id)?.terminal_spec_id).toBe('term-new-4');
    });

    it('still UPDATES rather than duplicating when a runtime already exists', () => {
        // POSITIVE CONTROL for the create path: the existing-runtime case that
        // #310 fixed must keep working, not gain a second row.
        const id = registeredAgent('already-running');
        const existing = createAgentRuntime({ agentId: id, tui: 'claude', fronted: true });
        const term = terminal('term-new-5');

        bindWorkspaceAgentTerminal(id, term);

        expect(listAgentRuntimes(id)).toHaveLength(1);
        expect(frontedAgentRuntime(id)?.id).toBe(existing.id);
        expect(frontedAgentRuntime(id)?.terminal_spec_id).toBe(term);
    });

    it('does not create a runtime when unbinding an agent that has none', () => {
        // Clearing a terminal on a dormant agent must stay a no-op — otherwise
        // every unbind invents a runtime for an agent that never ran.
        const id = registeredAgent('never-run');

        bindWorkspaceAgentTerminal(id, null);

        expect(listAgentRuntimes(id)).toEqual([]);
    });
});
