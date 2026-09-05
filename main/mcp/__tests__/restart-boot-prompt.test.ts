import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * genie#434 — a restart brought the agent back COLD.
 *
 * The fresh path composes an opening prompt (`agentBootPrompt`) and hands it to
 * the TUI. Every RELAUNCH path composed nothing of its own. At best it replayed
 * the ORIGINAL launch instructions — a snapshot of a different moment, only ever
 * written by some of the create paths and only since #302 — and for everything
 * else it typed a bare resume line. So a restarted agent picked up the last
 * conversation with no instruction to re-establish the Genie channel (its old
 * MCP endpoint died with its old pty) and no signal anyone could check. "The
 * process relaunched" is not "the agent is working".
 *
 * Asserted on the BYTES that reach the pty, because that is the boundary the
 * owner is complaining about — and with the FIRST launch as the positive
 * control, so "the prompt is there" cannot pass on a prompt that is always
 * there.
 *
 * REAL: the database and migrations, the spec store, the terminal manager, the
 * session-capture decision, `createAgentTerminal` and `restartAgentTerminal`.
 * FAKED: the pty process — the one process boundary.
 */

interface FakePty {
    pid: number;
    process: string;
    killed: boolean;
    written: string[];
    onData(cb: (d: string) => void): void;
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
    write(d: string): void;
    resize(c: number, r: number): void;
    kill(): void;
}

const spawnedPtys: FakePty[] = [];

vi.mock('node-pty', () => ({
    spawn: (): FakePty => {
        let onExit: ((e: { exitCode: number; signal?: number }) => void) | null = null;
        const pty: FakePty = {
            pid: 4000 + spawnedPtys.length,
            process: 'fake-shell',
            killed: false,
            written: [],
            onData: () => {},
            onExit: (cb) => {
                onExit = cb;
            },
            write(d: string) {
                this.written.push(d);
            },
            resize: () => {},
            kill() {
                this.killed = true;
                onExit?.({ exitCode: 0 });
            },
        };
        spawnedPtys.push(pty);
        return pty;
    },
}));

// host-tools' import graph reaches main/tray.ts, which runs the Electron app
// bootstrap at MODULE LOAD.
vi.mock('../../tray', () => ({
    rebuildMenu: vi.fn(),
    createTray: vi.fn(),
    setInboxBadge: vi.fn(),
    setUpdateAvailable: vi.fn(),
}));

import { app } from 'electron';
import {
    addWorkspace,
    createTerminalSpec,
    deleteTerminalSpec,
    getTerminalSpec,
    initDatabase,
    listTerminalSpecs,
    setSettings,
} from '../../db';
import { restartAgentTerminal } from '../host-tools';
import { createAgentTerminal, AGENT_LAUNCH_SETTLE_MS } from '../../terminal/ipc';
import { GENIE_OS_TERMINAL_ID } from '../../agents/os-agent';
import { resetProviderAvailabilityCache } from '../../agents/availability';
import { terminalManager } from '@particle-academy/fancy-term-host';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-restart-prompt-'));
const dataDir = path.join(tmpRoot, 'userData');
const wsDir = path.join(tmpRoot, 'workspace');
const homeDir = path.join(tmpRoot, 'home');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(wsDir, { recursive: true });
fs.mkdirSync(homeDir, { recursive: true });

const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;

/** Plant the on-disk transcript that makes `--resume <id>` a live option. */
function plantTranscript(cwd: string, sessionId: string): void {
    const dir = path.join(homeDir, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{}\n');
}

(app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;

initDatabase(dataDir);

const WS_ID = 'ws-restart-prompt';

addWorkspace({
    id: WS_ID,
    backend: 'tynn',
    project_id: WS_ID,
    project_name: 'Restart Prompt',
    tynn_project_id: WS_ID,
    tynn_project_name: 'Restart Prompt',
    shape: 'simple',
    path: wsDir,
    editor: null,
    editor_cmd: null,
    start_cmd: null,
    env_file: null,
    last_opened_at: null,
    created_by_genie: 0,
});

/** The launch line typed into a pty, stripped of the submit keystrokes. */
function submitted(pty: FakePty | undefined): string {
    return (pty?.written ?? []).join('').replace(/[\r\n]+$/, '').trim();
}

function afterLaunchSettles(): Promise<void> {
    return new Promise((r) => setTimeout(r, AGENT_LAUNCH_SETTLE_MS + 150));
}

async function launchAgent(instructions?: string): Promise<{ id: string; firstCommand: string }> {
    const created = createAgentTerminal({
        workspaceId: WS_ID,
        cwd: wsDir,
        label: 'claude · restart-prompt',
        agentMeta: {
            agent: 'claude',
            command: 'claude --dangerously-skip-permissions',
            ...(instructions ? { instructions } : {}),
        },
        agentInbox: { purpose: 'restart-prompt' },
    });
    await afterLaunchSettles();
    return { id: created.id, firstCommand: submitted(spawnedPtys.at(-1)) };
}

beforeEach(() => {
    terminalManager().killAll();
    for (const s of listTerminalSpecs()) deleteTerminalSpec(s.id);
    spawnedPtys.length = 0;
    resetProviderAvailabilityCache();
    setSettings({ max_agent_terminals: '', agent_flags_claude: '', agent_default: 'claude' });
});

afterAll(() => {
    terminalManager().killAll();
    process.env.HOME = realHome.HOME;
    process.env.USERPROFILE = realHome.USERPROFILE;
    try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});

describe('genie#434 — a RESUMING restart is told to reconnect and confirm', () => {
    it('types connectToGenie + thumbsUp alongside the resume, and did not before', async () => {
        const { id, firstCommand } = await launchAgent();

        // POSITIVE CONTROL. This agent was created with no instructions, so its
        // FIRST launch carries none — which is what makes the assertion below a
        // fact about the RESTART rather than about a prompt that rides every
        // launch line regardless.
        expect(firstCommand).not.toContain('connectToGenie');

        const sid = getTerminalSpec(id)?.meta?.chat_session_id as string;
        plantTranscript(wsDir, sid);

        const r = restartAgentTerminal(id);
        expect(r.ok).toBe(true);
        await afterLaunchSettles();

        const relaunch = submitted(spawnedPtys.at(-1));
        // The conversation is still resumed — the prompt is carried BY the
        // resume, never instead of it.
        expect(relaunch).toContain(`--resume ${sid}`);
        expect(relaunch).toContain('connectToGenie');
        expect(relaunch).toContain('thumbsUp');
    });

    it('keeps the standing launch instructions AND adds the relaunch line', async () => {
        // A spec written since #302 persists what the agent was launched with.
        // Those are still true of the agent, so the relaunch carries them —
        // it just no longer relies on them to say anything about the restart.
        const { id } = await launchAgent('Adopt your specialized persona from /p/AGENT.md.');
        const sid = getTerminalSpec(id)?.meta?.chat_session_id as string;
        plantTranscript(wsDir, sid);

        restartAgentTerminal(id);
        await afterLaunchSettles();

        const relaunch = submitted(spawnedPtys.at(-1));
        expect(relaunch).toContain('Adopt your specialized persona from /p/AGENT.md.');
        expect(relaunch).toContain('connectToGenie');
    });
});

describe('genie#434 — the workstation operator restarts warm, not blank', () => {
    /**
     * The OSA branch is a deliberate teardown-and-relaunch rather than a
     * resume, and it was the worst off of the two: it DELETED the spec (taking
     * `agent_instructions` with it) and re-created a brand-new one carrying no
     * instructions at all. So the machine's operator came back with no role
     * brief, no boot script, and no idea it had been restarted — on the surface
     * that exists precisely for recovery.
     */
    const ROLE_BRIEF = 'You are the WORKSTATION OPERATOR. THIS BOOT is a workstation RECOVERY boot.';

    function seedOperator(): void {
        createTerminalSpec({
            id: GENIE_OS_TERMINAL_ID,
            workspace_id: WS_ID,
            label: 'Genie',
            cwd: wsDir,
            type: 'terminal',
            meta: {
                agent: 'claude',
                agent_command: 'claude --dangerously-skip-permissions',
                agent_id: 'genie:workstation',
                agent_instructions: ROLE_BRIEF,
                whisper_purpose: 'genie',
                whisper_scope: 'all',
            },
        });
    }

    it('relaunches with its role brief AND the reconnect-and-confirm line', async () => {
        seedOperator();

        const r = restartAgentTerminal(GENIE_OS_TERMINAL_ID);
        expect(r.ok).toBe(true);
        await afterLaunchSettles();

        const relaunch = submitted(spawnedPtys.at(-1));
        expect(relaunch).toContain('WORKSTATION OPERATOR');
        expect(relaunch).toContain('connectToGenie');
        expect(relaunch).toContain('thumbsUp');
    });

    it('restarts into the SAME terminal id, so its thumbsUp can still be routed', async () => {
        // `onThumbsUp` (host-core/server-deps.ts) recognises the operator by
        // `terminalId === GENIE_OS_TERMINAL_ID`, and `~/.gosa`'s MCP config
        // names the endpoint registered for that id. Minting a fresh id — which
        // is what deleting the spec and creating one with no `id` did — leaves
        // an operator that cannot answer the very thumbsUp this restart now
        // asks it for, and an orphan spec the next boot garbage-collects.
        seedOperator();

        const r = restartAgentTerminal(GENIE_OS_TERMINAL_ID);

        expect(r.ok && r.newId).toBe(GENIE_OS_TERMINAL_ID);
        expect(getTerminalSpec(GENIE_OS_TERMINAL_ID)?.meta?.agent_id).toBe('genie:workstation');
        expect(
            listTerminalSpecs().filter((s) => s.meta?.agent_id === 'genie:workstation'),
        ).toHaveLength(1);
    });

    it('does NOT persist the relaunch line as the operator standing instructions', async () => {
        // The relaunch line is true of THIS launch, not of the agent. Persisting
        // it would compound on the next restart and would outlive the restart it
        // describes.
        seedOperator();

        restartAgentTerminal(GENIE_OS_TERMINAL_ID);
        await afterLaunchSettles();

        expect(getTerminalSpec(GENIE_OS_TERMINAL_ID)?.meta?.agent_instructions).toBe(ROLE_BRIEF);
    });
});
