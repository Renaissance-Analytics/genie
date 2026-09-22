import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addWorkspace, deleteTerminalSpec, removeWorkspace, getTerminalSpec } from '../db';
import { createAgentTerminal, isTerminalLive, killTerminalById, terminalHasWindow } from '../terminal/ipc';

const workspaceId = 'e2e-agent-revival';
const terminalId = 'e2e-agent-revival-terminal';
const root = path.join(os.tmpdir(), 'genie-e2e-agent-revival');

/** Test-only observation/fixture seam. Never mounts an agent panel or calls revival. */
export function registerAgentRevivalE2E(): void {
    (globalThis as Record<string, unknown>).__GENIE_E2E_AGENT_REVIVAL__ = {
        start() {
            fs.mkdirSync(root, { recursive: true });
            const heartbeat = path.join(root, 'heartbeat.json');
            if (fs.existsSync(heartbeat)) fs.unlinkSync(heartbeat);
            const script = path.join(root, 'agent.cjs');
            fs.writeFileSync(script, `const fs = require('node:fs');
const beat = () => fs.writeFileSync(${JSON.stringify(heartbeat)}, JSON.stringify({ pid: process.pid, at: Date.now() }));
beat(); setInterval(beat, 100);
`);
            addWorkspace({ id: workspaceId, backend: 'none', project_id: workspaceId,
                project_name: 'Agent revival without a panel', tynn_project_id: workspaceId, tynn_project_name: 'Agent revival',
                shape: 'simple', path: root, editor: null, editor_cmd: null, start_cmd: null,
                env_file: null, last_opened_at: null, created_by_genie: 0 });
            return createAgentTerminal({ id: terminalId, workspaceId, cwd: root, label: 'revival-probe',
                agentMeta: { agent: 'custom', command: `node "${script}"` } });
        },
        state() {
            const heartbeat = path.join(root, 'heartbeat.json');
            let beat: { pid: number; at: number } | null = null;
            try { beat = JSON.parse(fs.readFileSync(heartbeat, 'utf8')); } catch { /* not written yet */ }
            return { live: isTerminalLive(terminalId), attached: terminalHasWindow(terminalId),
                wasRunning: getTerminalSpec(terminalId)?.meta?.was_running, beat };
        },
        cleanup() {
            killTerminalById(terminalId);
            deleteTerminalSpec(terminalId);
            removeWorkspace(workspaceId);
        },
    };
}
