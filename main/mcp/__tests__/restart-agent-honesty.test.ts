import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * genie#364, at the boundary the owner actually used.
 *
 * TWO defects, one click. The owner exited a TUI, pressed **Restart agent**, and
 * was told *"agent restarted"* while the relaunch died in the pty with
 * *"Error: Session ID bfffcfe8-… is already in use."*
 *
 *  1. THE WRONG VERB. `--session-id` is CREATE-a-session-with-this-id — it works
 *     exactly once. A relaunch has to render the provider's RESUME grammar
 *     (`TuiDef.resume`, genie#261/#363) from the captured id instead of replaying
 *     the create flag. Asserted here on the BYTES that reach the pty, because
 *     that is where the failure was visible, with the POSITIVE CONTROL that the
 *     FIRST launch still mints `--session-id` and that the relaunch carries the
 *     SAME id — "no create flag" would otherwise pass against a build that lost
 *     session handling entirely.
 *
 *  2. THE WRONG MOMENT. `restartAgentTerminal` returned `{ ok: true }` as soon
 *     as it had killed the old pty and queued the launch line. It had verified
 *     nothing about the agent — it cannot: the command has not even been typed
 *     yet when it returns (`AGENT_LAUNCH_SETTLE_MS` later), and a TUI dying
 *     inside a pty leaves the shell alive and looking identical. So the result
 *     must say what it MEANS — a relaunch in flight — and the checks that ARE
 *     decidable at that moment must be real refusals rather than decoration.
 *
 * REAL: the database and migrations, the spec store, the terminal manager and
 * its liveness, the session-capture decision, and `restartAgentTerminal` itself.
 * FAKED: the pty process and the approval modal — the two process boundaries.
 */

// --- FAKE 1: the pty process ------------------------------------------------
interface FakePty {
    pid: number;
    process: string;
    killed: boolean;
    /** Everything written into this pty — the launch line lands here. */
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
            pid: 3000 + spawnedPtys.length,
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
// bootstrap at MODULE LOAD. Cut the chain here (same reason as the cap suite).
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
    updateTerminalSpec,
} from '../../db';
import { restartAgentTerminal } from '../host-tools';
import { createAgentTerminal, AGENT_LAUNCH_SETTLE_MS } from '../../terminal/ipc';
import {
    recordProviderAvailability,
    resetProviderAvailabilityCache,
} from '../../agents/availability';
import { terminalManager } from '@particle-academy/fancy-term-host';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-restart-honesty-'));
const dataDir = path.join(tmpRoot, 'userData');
const wsDir = path.join(tmpRoot, 'workspace');
const homeDir = path.join(tmpRoot, 'home');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(wsDir, { recursive: true });
fs.mkdirSync(homeDir, { recursive: true });

// Claude's transcripts live under `~/.claude/projects/<encoded cwd>` and the
// exact-resume path is gated on one existing. Point HOME at the fixture so a
// transcript can be planted for real: nothing here writes into the developer's
// own `~/.claude`, and `os.homedir()` re-reads the environment on every call.
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

const WS_ID = 'ws-restart-honesty';

addWorkspace({
    id: WS_ID,
    backend: 'tynn',
    project_id: WS_ID,
    project_name: 'Restart Honesty',
    tynn_project_id: WS_ID,
    tynn_project_name: 'Restart Honesty',
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

/** Wait past the shell-settle delay, so the queued launch line has been typed. */
function afterLaunchSettles(): Promise<void> {
    return new Promise((r) => setTimeout(r, AGENT_LAUNCH_SETTLE_MS + 150));
}

/**
 * Launch a claude agent the way the desktop does, and hand back its spec id plus
 * the exact bytes the first launch typed.
 */
async function launchAgent(): Promise<{ id: string; firstCommand: string }> {
    const created = createAgentTerminal({
        workspaceId: WS_ID,
        cwd: wsDir,
        label: 'claude · restart-probe',
        agentMeta: { agent: 'claude', command: 'claude --dangerously-skip-permissions' },
        agentInbox: { purpose: 'restart-probe' },
    });
    await afterLaunchSettles();
    return { id: created.id, firstCommand: submitted(spawnedPtys.at(-1)) };
}

beforeEach(() => {
    terminalManager().killAll();
    for (const s of listTerminalSpecs()) deleteTerminalSpec(s.id);
    spawnedPtys.length = 0;
    resetProviderAvailabilityCache();
    setSettings({ max_agent_terminals: '', agent_flags_claude: '' });
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

describe('genie#364 — the restart types a RESUME, never a second create', () => {
    it('mints --session-id on the first launch and resumes THAT id on the restart', async () => {
        const { id, firstCommand } = await launchAgent();

        // POSITIVE CONTROL: session capture is intact — the first launch pins
        // the conversation by minting an id and passing it in.
        expect(firstCommand).toMatch(
            /^claude --dangerously-skip-permissions --session-id [0-9a-fA-F-]{8,}$/,
        );
        const sid = getTerminalSpec(id)?.meta?.chat_session_id;
        expect(sid).toBeTruthy();
        expect(firstCommand).toContain(sid!);
        plantTranscript(wsDir, sid!);

        const r = restartAgentTerminal(id);
        expect(r.ok).toBe(true);
        await afterLaunchSettles();

        // SAME conversation, RESUME verb — the create flag is gone, and the id
        // is not a new one (which would lose the chat while looking like a fix).
        const relaunch = submitted(spawnedPtys.at(-1));
        expect(relaunch).not.toContain('--session-id');
        expect(relaunch).toContain(sid!);
        expect(relaunch).toMatch(/--(resume|continue)\b/);
    });

    it('resumes a spec whose session id survives only in its stored command', async () => {
        // The state genie#364 describes: the id was recorded by the launch flag
        // and lives in `agent_command`, not in `meta.chat_session_id`. Replaying
        // that command is "Session ID … is already in use"; refusing it claims
        // there is no conversation when there plainly is one.
        const { id } = await launchAgent();
        const spec = getTerminalSpec(id)!;
        const sid = spec.meta!.chat_session_id as string;
        plantTranscript(wsDir, sid);
        createTerminalSpec({
            id: 'spec-embedded-id',
            workspace_id: WS_ID,
            label: 'claude · embedded',
            cwd: wsDir,
            type: 'terminal',
            meta: {
                agent: 'claude',
                agent_id: 'agent-embedded',
                agent_command: `claude --dangerously-skip-permissions --session-id ${sid}`,
            },
        });

        const r = restartAgentTerminal('spec-embedded-id');

        expect(r.ok).toBe(true);
        expect(r.ok && r.command).not.toContain('--session-id');
        expect(r.ok && r.command).toContain(sid);
    });

    it('rebuilds the base command when a migration swept the stored one', async () => {
        // v59 and v65 DELETE `meta.agent_command` when the flags frozen into it
        // go bad, "so resolution falls through to the builder". Nothing fell
        // through: the resume dropped to the registry's bare `defaultCommand`, so
        // a swept agent came back as a plain `claude --resume <id>` — no
        // always-on flags, no `--dangerously-skip-permissions`, no AgentInbox
        // channel — and looked like the sweep had broken it.
        setSettings({ agent_flags_claude: '--dangerously-skip-permissions' });
        const { id } = await launchAgent();
        const spec = getTerminalSpec(id)!;
        const sid = spec.meta!.chat_session_id as string;
        plantTranscript(wsDir, sid);
        const swept = { ...spec.meta };
        delete (swept as { agent_command?: string }).agent_command;
        updateTerminalSpec(id, { meta: swept });

        const r = restartAgentTerminal(id);

        expect(r.ok).toBe(true);
        expect(r.ok && r.command).toBe(`claude --dangerously-skip-permissions --resume ${sid}`);
        // And it is written back, so the reopen path — which has no access to
        // settings — resolves the same command rather than the bare binary.
        expect(getTerminalSpec(id)?.meta?.agent_command).toBe(
            'claude --dangerously-skip-permissions',
        );
    });
});

describe('genie#364 — a restart does not claim more than it checked', () => {
    it('reports a relaunch IN FLIGHT, not an agent it has never seen come up', async () => {
        const { id } = await launchAgent();

        const r = restartAgentTerminal(id);

        expect(r.ok).toBe(true);
        // `ok` means the old agent was stopped and the resume command was handed
        // to a fresh terminal. It does NOT mean the TUI came back: when this
        // returns the command has not even been typed yet, and a TUI that dies
        // inside its pty leaves a shell that looks exactly like a live agent.
        // The surfaces render this, so "restarted" can never be said on evidence
        // that only supports "restarting".
        expect(r.ok && r.state).toBe('relaunching');
        expect(r.ok && r.note).toBeTruthy();
        expect(r.ok && r.note).not.toMatch(/\brestarted\b/i);
    });

    it('REFUSES when the provider binary is known to be missing', async () => {
        const { id } = await launchAgent();
        // The boot-time detect pass (genie#313) has already established this
        // provider cannot launch. Reporting a successful restart here produces a
        // `command not found` under a success toast — the exact shape of the
        // complaint. The revive path deliberately does not refuse this on its
        // own, so the restart has to.
        recordProviderAvailability({
            id: 'claude',
            status: 'unavailable',
            reason: 'claude is not installed on this workstation.',
        });

        const r = restartAgentTerminal(id);

        expect(r.ok).toBe(false);
        expect(!r.ok && r.error).toMatch(/not installed/i);
        // And it refused BEFORE tearing anything down: the running agent is
        // still there. A refusal that killed the agent first would be worse than
        // the over-claim it replaces.
        expect(terminalManager().isLive(id)).toBe(true);
    });

    it('REFUSES when the relaunched terminal is not running', async () => {
        const { id } = await launchAgent();
        // A pty that cannot be brought back is decidable right there, and it is
        // the one thing a restart genuinely can falsify at return time.
        const spy = vi
            .spyOn(terminalManager(), 'isLive')
            .mockImplementation((termId: string) => termId !== id);

        try {
            const r = restartAgentTerminal(id);
            expect(r.ok).toBe(false);
            expect(!r.ok && r.error).toMatch(/terminal/i);
        } finally {
            spy.mockRestore();
        }
    });
});
