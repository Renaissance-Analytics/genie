import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    addWorkspace,
    createAgentRuntime,
    createWorkspaceAgent,
    frontAgentRuntime,
    initDatabase,
    listAgentRuntimes,
    listWorkspaceAgents,
    deleteWorkspaceAgent,
} from '../db';

/**
 * The accessors the rest of the redesign is built on.
 *
 * An agent's TUIs are rows now, and every surface above this — the grid that
 * draws a square per agent, the switcher that flips between drivers, the
 * sidecars that keep their conversation warm — reads them through here. So the
 * invariants the schema enforces are also asserted through the API that will
 * actually be used, not only against raw SQL: a constraint nothing calls is a
 * constraint nobody has tested.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-runtimes-'));
const dataDir = path.join(tmpRoot, 'userData');
fs.mkdirSync(dataDir, { recursive: true });
(app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;
initDatabase(dataDir);

const WS = 'ws-runtimes';
addWorkspace({
    id: WS,
    backend: 'tynn',
    project_id: WS,
    project_name: 'Runtimes',
    tynn_project_id: WS,
    tynn_project_name: 'Runtimes',
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
    const id = `agent-${++seq}`;
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

beforeEach(() => {
    for (const a of listWorkspaceAgents(WS)) {
        if (a.role !== 'workspace') deleteWorkspaceAgent(a.id);
    }
});

describe('agent runtimes', () => {
    it('records a TUI an agent may run under', () => {
        const id = agent('tynn');
        createAgentRuntime({ agentId: id, provider: 'claude', fronted: true });

        const runtimes = listAgentRuntimes(id);
        expect(runtimes).toHaveLength(1);
        expect(runtimes[0]).toMatchObject({ provider: 'claude', fronted: 1 });
    });

    it('holds several TUIs for ONE agent — the whole point of the split', () => {
        const id = agent('tynn');
        createAgentRuntime({ agentId: id, provider: 'claude', fronted: true });
        createAgentRuntime({ agentId: id, provider: 'codex' });

        expect(listAgentRuntimes(id).map((r) => r.provider).sort()).toEqual([
            'claude',
            'codex',
        ]);
    });

    it('keeps each agent’s runtimes to itself', () => {
        const a = agent('one');
        const b = agent('two');
        createAgentRuntime({ agentId: a, provider: 'claude' });
        createAgentRuntime({ agentId: b, provider: 'claude' });

        expect(listAgentRuntimes(a)).toHaveLength(1);
        expect(listAgentRuntimes(b)).toHaveLength(1);
    });

    it('fronting one runtime un-fronts the other, in one step', () => {
        // The flip has to be a SWAP. Doing it as "front the new one" alone trips
        // the one-fronted index; doing it as two writes leaves a window where an
        // agent has no visible TUI at all, and the UI reads that as stopped.
        const id = agent('tynn');
        const claude = createAgentRuntime({ agentId: id, provider: 'claude', fronted: true });
        const codex = createAgentRuntime({ agentId: id, provider: 'codex' });

        frontAgentRuntime(id, codex.id);

        const byId = Object.fromEntries(listAgentRuntimes(id).map((r) => [r.id, r.fronted]));
        expect(byId[codex.id]).toBe(1);
        expect(byId[claude.id]).toBe(0);
    });

    it('fronting the already-fronted runtime is a no-op, not a crash', () => {
        const id = agent('tynn');
        const claude = createAgentRuntime({ agentId: id, provider: 'claude', fronted: true });

        expect(() => frontAgentRuntime(id, claude.id)).not.toThrow();
        expect(listAgentRuntimes(id)[0]!.fronted).toBe(1);
    });

    it('refuses to front a runtime belonging to a DIFFERENT agent', () => {
        // Otherwise one agent could steal another's visible TUI, and the
        // one-fronted index would then be satisfied by the wrong pair.
        const a = agent('one');
        const b = agent('two');
        createAgentRuntime({ agentId: a, provider: 'claude', fronted: true });
        const stranger = createAgentRuntime({ agentId: b, provider: 'claude', fronted: true });

        expect(frontAgentRuntime(a, stranger.id)).toBe(false);
        // POSITIVE CONTROL: b kept its own, so the refusal did not damage either.
        expect(listAgentRuntimes(b)[0]!.fronted).toBe(1);
    });

    it('reports no runtimes for an agent that has never been started', () => {
        // A registered agent with no TUI yet is a real, renderable state — it is
        // the dormant agent the grid has never been able to show.
        expect(listAgentRuntimes(agent('dormant'))).toEqual([]);
    });
});
