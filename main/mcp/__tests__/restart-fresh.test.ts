import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * genie#443 — a terminal that cannot RESUME could not be restarted AT ALL.
 *
 * Genie had ONE operation where it needs two. "Resume" (continue the
 * conversation — needs a resume grammar AND a captured session id) and "Restart"
 * (kill it and start fresh — needs neither) shared a single code path, so the
 * absence of the first removed the second. `resolveRestartCommand` returned its
 * refusal BEFORE any teardown, which is why the reported terminal — a `genie`
 * TUI that had died on `bash: genie: command not found`, with no conversation to
 * protect — stayed exactly as it was, and the owner had no way out from the UI.
 *
 * Asserted on THE PTY: the old one killed, a new one spawned and live. A menu
 * item's existence proves nothing here — a button that does nothing is this
 * bug's whole shape — and neither does a resolved command string, which is what
 * the old path produced right up to the moment it refused.
 *
 * The RESUME case is the positive control. Without it "restart works" passes
 * against a build that only ever restarts fresh and has quietly stopped
 * resuming anything, which is the exact failure genie#440 and the registry's
 * `resume: null` rows exist to prevent.
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
            pid: 5000 + spawnedPtys.length,
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
import { agentInboxBroker } from '../../agentinbox/broker';
import { resetProviderAvailabilityCache } from '../../agents/availability';
import { terminalManager } from '@particle-academy/fancy-term-host';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-restart-fresh-'));
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

const WS_ID = 'ws-restart-fresh';

addWorkspace({
    id: WS_ID,
    backend: 'tynn',
    project_id: WS_ID,
    project_name: 'Restart Fresh',
    tynn_project_id: WS_ID,
    tynn_project_name: 'Restart Fresh',
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

/**
 * The reported terminal: a `genie` TUI agent. Its provider has `resume: null`
 * and its launch profile captures nothing at launch (`strategy: 'hook'`), so
 * there is no conversation Genie could preserve — which is precisely the state
 * the old code read as "a restart would lose the conversation".
 */
async function launchUnresumableAgent(): Promise<string> {
    const created = createAgentTerminal({
        workspaceId: WS_ID,
        cwd: wsDir,
        label: 'genie · restart-fresh',
        agentMeta: { agent: 'genie', command: 'genie' },
        agentInbox: { purpose: 'restart-fresh' },
    });
    await afterLaunchSettles();
    return created.id;
}

/** A claude agent, which CAN resume — the positive control. */
async function launchResumableAgent(): Promise<string> {
    const created = createAgentTerminal({
        workspaceId: WS_ID,
        cwd: wsDir,
        label: 'claude · restart-fresh',
        agentMeta: { agent: 'claude', command: 'claude --dangerously-skip-permissions' },
        agentInbox: { purpose: 'restart-fresh' },
    });
    await afterLaunchSettles();
    return created.id;
}

beforeEach(() => {
    terminalManager().killAll();
    for (const s of listTerminalSpecs()) deleteTerminalSpec(s.id);
    spawnedPtys.length = 0;
    resetProviderAvailabilityCache();
    setSettings({
        max_agent_terminals: '',
        agent_flags_claude: '',
        agent_flags_genie: '',
        agent_command_genie: '',
        agent_default: 'claude',
    });
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

describe('genie#443 — RESTART (fresh) reaches a terminal RESUME cannot', () => {
    it('kills the old pty and runs a new one for a provider with no resume grammar', async () => {
        const id = await launchUnresumableAgent();
        const original = spawnedPtys.at(-1)!;

        // THE BUG, stated as the owner meets it. The graceful restart refuses —
        // correctly, it has no conversation to carry — and refuses BEFORE any
        // teardown, so the wedged terminal is still sitting there afterwards.
        const refused = restartAgentTerminal(id);
        expect(refused.ok).toBe(false);
        expect(original.killed).toBe(false);
        expect(terminalManager().isLive(id)).toBe(true);

        // THE SECOND OPERATION. No resume grammar and no captured id are needed
        // to kill a process and start it again.
        const r = restartAgentTerminal(id, 'fresh');
        expect(r.ok).toBe(true);
        await afterLaunchSettles();

        // THE TERMINAL IS GONE AND A NEW ONE IS RUNNING — asserted on the ptys,
        // not on the result object, which the refusing path also filled in.
        expect(original.killed).toBe(true);
        expect(spawnedPtys.length).toBe(2);
        expect(spawnedPtys.at(-1)!.killed).toBe(false);
        expect(terminalManager().isLive(id)).toBe(true);

        // And it started FRESH: no resume grammar was invented for a provider
        // that has none (genie#440 — a wrong `--resume` does not error, it
        // silently opens a new conversation while claiming to resume).
        const relaunch = submitted(spawnedPtys.at(-1));
        expect(relaunch).toContain('genie');
        expect(relaunch).not.toMatch(/--(resume|continue)\b/);
        expect(relaunch).not.toContain('--session-id');
    });

    it('keeps the agent’s identity, so its AgentInbox mail is not stranded', async () => {
        const id = await launchUnresumableAgent();
        const agentId = getTerminalSpec(id)?.meta?.agent_id;
        expect(agentId).toBeTruthy();

        const r = restartAgentTerminal(id, 'fresh');

        // The SAME spec, and the same AgentInbox identity. A fresh CONVERSATION
        // is not a fresh AGENT: minting a new `agent_id` strands its queued mail,
        // cursors, channel membership and DM history, and leaves the AMS grid
        // drawing one registered agent as two squares.
        expect(r.ok && r.newId).toBe(id);
        expect(getTerminalSpec(id)?.meta?.agent_id).toBe(agentId);
        expect(listTerminalSpecs().filter((s) => s.meta?.agent === 'genie')).toHaveLength(1);
    });

    it('POSITIVE CONTROL: a resumable agent with a captured id still RESUMES', async () => {
        // Without this, "restart works" passes against a build that only ever
        // restarts fresh and has quietly stopped resuming anything.
        const id = await launchResumableAgent();
        const sid = getTerminalSpec(id)?.meta?.chat_session_id as string;
        expect(sid).toBeTruthy();
        plantTranscript(wsDir, sid);

        const r = restartAgentTerminal(id);
        expect(r.ok).toBe(true);
        await afterLaunchSettles();

        const relaunch = submitted(spawnedPtys.at(-1));
        expect(relaunch).toContain(`--resume ${sid}`);
    });

    it('a FRESH restart of a resumable agent leaves the old conversation behind', async () => {
        const id = await launchResumableAgent();
        const sid = getTerminalSpec(id)?.meta?.chat_session_id as string;
        plantTranscript(wsDir, sid);

        const r = restartAgentTerminal(id, 'fresh');
        expect(r.ok).toBe(true);
        await afterLaunchSettles();

        // Fresh MEANS fresh: the captured id is not resumed, and the spec stops
        // pointing at it. Leaving it in place would have the next relaunch —
        // and the AgentInbox — claim a conversation this process is not in.
        const relaunch = submitted(spawnedPtys.at(-1));
        expect(relaunch).not.toContain(`--resume ${sid}`);
        expect(relaunch).not.toContain(`--continue`);
        const after = getTerminalSpec(id)?.meta?.chat_session_id;
        expect(after).not.toBe(sid);
    });

    it('forgets a session id that survives only inside the stored launch command', async () => {
        // genie#364: `--session-id <uuid>` can be the ONLY record of a session.
        // `capturedSessionId` reads it back out of the command, so clearing the
        // field alone would leave a "fresh" restart resuming the old chat.
        const sid = '11111111-2222-3333-4444-555555555555';
        createTerminalSpec({
            id: 'spec-embedded-fresh',
            workspace_id: WS_ID,
            label: 'claude · embedded',
            cwd: wsDir,
            type: 'terminal',
            meta: {
                agent: 'claude',
                agent_id: 'agent-embedded-fresh',
                agent_command: `claude --dangerously-skip-permissions --session-id ${sid}`,
            },
        });
        plantTranscript(wsDir, sid);

        const r = restartAgentTerminal('spec-embedded-fresh', 'fresh');
        expect(r.ok).toBe(true);
        await afterLaunchSettles();

        const relaunch = submitted(spawnedPtys.at(-1));
        expect(relaunch).not.toContain(sid);
        expect(getTerminalSpec('spec-embedded-fresh')?.meta?.agent_command).not.toContain(sid);
    });
});

describe('genie#443 / genie#438 — the workstation operator uses the SAME fresh path', () => {
    const ROLE_BRIEF = 'You are the WORKSTATION OPERATOR.';

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

    it('joins the AgentInbox under its OWN id, not a minted one', () => {
        // genie#438. The OSA branch DELETED the spec and re-created it, so
        // `createAgentTerminal` minted a random `agent_id`, joined the broker
        // under it, and only then was the spec re-stamped `genie:workstation` —
        // a fix that cannot reach the join that already happened. Reusing the
        // ordinary fresh path makes the mismatch unrepresentable: the spec is
        // kept, so the identity is inherited rather than re-minted.
        seedOperator();

        const r = restartAgentTerminal(GENIE_OS_TERMINAL_ID);

        expect(r.ok).toBe(true);
        expect(getTerminalSpec(GENIE_OS_TERMINAL_ID)?.meta?.agent_id).toBe('genie:workstation');
        expect(agentInboxBroker.getInfo('genie:workstation')).toBeTruthy();
    });
});
