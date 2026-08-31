import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `runAgent start` on a SAVED agent REATTACHES — it does not mint a second one
 * (Tynn #254).
 *
 * This is the acceptance test for the whole story, and it is written at the tool
 * boundary on purpose. The complaint was never "the resolver returns the wrong
 * enum"; it was that calling the tool twice left the workspace holding two
 * strangers. So what is asserted is the WORLD after the second call — one spec,
 * one AgentInbox identity, one live pty — rather than the return value that
 * describes it.
 *
 * Every "there is no second agent" assertion carries a POSITIVE CONTROL: the
 * agent that survived is asserted LIVE. Absence passes trivially against a start
 * that failed outright, and a reattach that quietly attached to nothing would be
 * a worse bug than the duplicate it replaced.
 *
 * REAL: the SQLite database (real migrations, real workspace + terminal_spec
 * rows), the real spec store, the real saved-agent resolution, the real MCP tool
 * handler, and the real terminal manager's liveness.
 *
 * FAKED: the pty spawn (`node-pty`) and the approval modal — the two process
 * boundaries. Nothing that decides is mocked.
 */

// --- FAKE 1: the pty process ------------------------------------------------
interface FakePty {
    pid: number;
    process: string;
    killed: boolean;
    /** Everything written into this pty — the launch command lands here. */
    written: string[];
    exit(): void;
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
            pid: 2000 + spawnedPtys.length,
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
            exit() {
                this.killed = true;
                onExit?.({ exitCode: 0 });
            },
        };
        spawnedPtys.push(pty);
        return pty;
    },
}));

// --- FAKE 2: the approval modal ---------------------------------------------
const modalsRaised: string[] = [];

vi.mock('../../ask/force-question', () => ({
    forceQuestion: async (questions: Array<{ question: string }>) => {
        modalsRaised.push(questions[0]?.question ?? '');
        return { cancelled: false, answers: [{ selected: ['Approve'] }] };
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
    deleteWorkspaceAgent,
    getTerminalSpec,
    initDatabase,
    listTerminalSpecs,
    listWorkspaceAgents,
    setSettings,
    setWorkspaceAgentCap,
    updateTerminalSpec,
} from '../../db';
import { registerAgentForMcp, runAgentForMcp } from '../host-tools';
import { registerAgentInboxSession } from '../../agentinbox/session-registration';
import { terminalManager } from '@particle-academy/fancy-term-host';
import type { RunAgentRequest, RunAgentResult } from '../protocol';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-saved-agents-'));
const dataDir = path.join(tmpRoot, 'userData');
const wsDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(wsDir, { recursive: true });

(app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;

initDatabase(dataDir);

const WS_ID = 'ws-saved';
const CALLER_ID = 'term-caller';

addWorkspace({
    id: WS_ID,
    backend: 'tynn',
    project_id: WS_ID,
    project_name: 'Saved Agents',
    tynn_project_id: WS_ID,
    tynn_project_name: 'Saved Agents',
    shape: 'simple',
    path: wsDir,
    editor: null,
    editor_cmd: null,
    start_cmd: null,
    env_file: null,
    last_opened_at: null,
    created_by_genie: 0,
});

/** Every AGENT spec in the workspace — the roster the complaint is about. */
function agentSpecs() {
    return listTerminalSpecs().filter((s) => s.workspace_id === WS_ID && s.meta?.agent);
}

/** The durable AgentInbox identities in the workspace. A second agent shows up
 *  here even if the caller reported the same terminal id. */
function agentIds(): string[] {
    return agentSpecs()
        .map((s) => s.meta?.agent_id as string | undefined)
        .filter((v): v is string => !!v);
}

function start(req: Partial<RunAgentRequest> = {}): Promise<RunAgentResult> {
    return runAgentForMcp(CALLER_ID, {
        action: 'start',
        // An explicit command so nothing depends on a `claude` binary existing.
        command: 'echo agent',
        ...req,
    } as RunAgentRequest);
}

async function registerAndStart(req: Partial<RunAgentRequest> = {}): Promise<RunAgentResult> {
    const name = req.name ?? 'general';
    const provider = req.agent ?? 'claude';
    const registered = await registerAgentForMcp(CALLER_ID, {
        name,
        purpose: `Test agent ${name}`,
        agent: provider,
    });
    if (!registered.ok) return registered as RunAgentResult;
    return start({ ...req, create: undefined });
}

beforeEach(() => {
    terminalManager().killAll();
    for (const s of listTerminalSpecs()) deleteTerminalSpec(s.id);
    for (const agent of listWorkspaceAgents(WS_ID)) {
        if (agent.role !== 'workspace') deleteWorkspaceAgent(agent.id);
    }
    spawnedPtys.length = 0;
    modalsRaised.length = 0;
    setSettings({ max_agent_terminals: '' });
    setWorkspaceAgentCap(WS_ID, 'unlimited');

    createTerminalSpec({
        id: CALLER_ID,
        workspace_id: WS_ID,
        label: 'caller',
        cwd: wsDir,
        type: 'terminal',
        meta: {},
    });
});

afterAll(() => {
    terminalManager().killAll();
    try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});

describe('registering an agent before start', () => {
    it('needs `registerAgent` — a bare start refuses instead of minting a stranger', async () => {
        const r = await start({ name: 'tynn' });

        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/registerAgent/i);
        // Nothing came into being, and the user was never asked to approve
        // something that was already refused.
        expect(agentSpecs()).toHaveLength(0);
        expect(spawnedPtys).toHaveLength(0);
        expect(modalsRaised).toEqual([]);
    });

    it('starts one registered agent, with its provider and name on the terminal', async () => {
        const r = await registerAndStart({ name: 'tynn', agent: 'claude' });

        expect(r.ok).toBe(true);
        expect(r.id).toBeTruthy();
        expect(r.reattached).toBe(false);
        // The canonical machine-facing identity, provider first.
        expect(r.ref).toMatch(/^tynn:/);

        const spec = getTerminalSpec(r.id!);
        expect(spec?.meta?.agent).toBe('claude');
        expect(spec?.meta?.whisper_purpose).toBe('tynn');
        expect(spec?.meta?.agent_id).toBeTruthy();
        expect(terminalManager().isLive(r.id!)).toBe(true);
    });

    it('refuses a second agent under a name the workspace already has', async () => {
        const first = await registerAndStart({ name: 'tynn', agent: 'claude' });
        expect(first.ok).toBe(true);

        const second = await registerAndStart({ name: 'tynn', agent: 'claude' });

        expect(second.ok).toBe(false);
        // The NAME, not `claude:tynn`: since v55 the TUI is not part of the
        // identity, so naming it in the refusal would describe a key that no
        // longer exists and imply a `codex:tynn` were still available.
        expect(second.error).toContain('tynn');
        expect(second.error).not.toContain('claude:tynn');
        expect(agentSpecs()).toHaveLength(1);
        // POSITIVE CONTROL — the one that exists is genuinely running.
        expect(terminalManager().isLive(first.id!)).toBe(true);
    });
});

describe('runAgent start on a SAVED agent', () => {
    it('binds a Codex SessionStart id onto the just-created saved agent without duplicating it', async () => {
        const created = await registerAndStart({ name: 'tynn', agent: 'codex' });
        expect(created.ok).toBe(true);
        expect(created.ref).toBe('tynn');
        expect(created.sessionBinding).toBe('pending');

        const registered = registerAgentInboxSession(created.id!, 'codex-session-1', {
            getTerminalSpec,
            updateTerminalSpec,
            setChatSession: () => {},
        });
        expect(registered.ok).toBe(true);

        const attached = await start({ name: 'tynn', agent: 'codex' });
        expect(attached.ok).toBe(true);
        expect(attached.id).toBe(created.id);
        expect(attached.ref).toBe('tynn:codex-session-1');
        expect(attached.sessionBinding).toBe('bound');
        expect(agentSpecs()).toHaveLength(1);
        expect(agentIds()).toHaveLength(1);
    });

    it('REATTACHES to the live agent instead of creating a second one', async () => {
        const created = await registerAndStart({ name: 'tynn', agent: 'claude' });
        expect(created.ok).toBe(true);
        const ptysAfterCreate = spawnedPtys.length;

        const again = await start({ name: 'tynn' });

        expect(again.ok).toBe(true);
        expect(again.reattached).toBe(true);
        // The SAME agent, by every identity that matters.
        expect(again.id).toBe(created.id);
        expect(again.ref).toBe(created.ref);
        expect(agentSpecs()).toHaveLength(1);
        expect(agentIds()).toHaveLength(1);
        // No second pty, and — the positive control — the first is still alive.
        expect(spawnedPtys).toHaveLength(ptysAfterCreate);
        expect(terminalManager().isLive(created.id!)).toBe(true);
    });

    it('does not re-launch the TUI into a terminal that is already running one', async () => {
        // The launch is submitted on a settle timer, so the writes are only
        // observable once the timers run.
        vi.useFakeTimers();
        try {
            const created = await registerAndStart({ name: 'tynn', agent: 'claude' });
            vi.runAllTimers();
            const pty = spawnedPtys[spawnedPtys.length - 1]!;
            const writesAfterLaunch = pty.written.length;
            expect(writesAfterLaunch).toBeGreaterThan(0); // POSITIVE CONTROL: it did launch

            await start({ name: 'tynn' });
            vi.runAllTimers();

            // Not vacuous: "the first pty got no new writes" is also true of a
            // start that spawned a SECOND pty and typed into that one instead,
            // which is the bug this story exists to remove. So the reattach is
            // pinned first, and the quiet pty second.
            expect(spawnedPtys).toHaveLength(1);
            expect(agentSpecs()).toHaveLength(1);
            // Typing the launch command into a live TUI's prompt is the visible
            // form of this bug — it appears as text in the running agent's input.
            expect(pty.written).toHaveLength(writesAfterLaunch);
            expect(terminalManager().isLive(created.id!)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('REVIVES a saved agent whose pty exited — same record, no second agent', async () => {
        const created = await registerAndStart({ name: 'tynn', agent: 'claude' });
        const agentIdBefore = getTerminalSpec(created.id!)?.meta?.agent_id;
        expect(agentIdBefore).toBeTruthy();

        // The agent finishes and its shell exits. The spec is retained.
        spawnedPtys[spawnedPtys.length - 1]!.exit();
        expect(terminalManager().isLive(created.id!)).toBe(false);

        const revived = await start({ name: 'tynn' });

        expect(revived.ok).toBe(true);
        expect(revived.reattached).toBe(true);
        expect(revived.id).toBe(created.id);
        // One record, one durable identity — a revive is not a new agent, which
        // is what keeps its inbox, channels and DM history attached.
        expect(agentSpecs()).toHaveLength(1);
        expect(getTerminalSpec(created.id!)?.meta?.agent_id).toBe(agentIdBefore);
        // POSITIVE CONTROL: it is actually running again, not merely "not duplicated".
        expect(terminalManager().isLive(created.id!)).toBe(true);
    });

    it('refuses a second agent under a name the workspace already has, whatever TUI it names', async () => {
        // The contract this asserted is deliberately reversed by v55. It used to
        // require that `claude:tynn` and `codex:tynn` be two DISTINCT agents,
        // because the TUI was part of the identity key -- which is the model the
        // owner removed: an agent is bigger than the TUI driving it, and a name
        // it answers to must mean one agent.
        //
        // A second TUI for the same agent is now a RUNTIME, not a second agent,
        // so the way to get one is to add a runtime rather than to register
        // again under a different provider.
        const claude = await registerAndStart({ name: 'tynn', agent: 'claude' });
        expect(claude.ok).toBe(true);

        const second = await registerAgentForMcp(CALLER_ID, {
            name: 'tynn',
            purpose: 'the same name, a different driver',
            agent: 'codex',
        });

        expect(second.ok).toBe(false);
        // POSITIVE CONTROL: the refusal left the original alone and running,
        // rather than being a failure that happened to leave one agent behind.
        expect(agentSpecs()).toHaveLength(1);
        expect(terminalManager().isLive(claude.id!)).toBe(true);
        // And a bare name is no longer ambiguous, because it cannot be.
        expect((await start({ name: 'tynn' })).id).toBe(claude.id);
    });
});

describe('listing the workspace roster', () => {
    it('reports every saved agent by its canonical ref, and never invents one', async () => {
        await registerAndStart({ name: 'tynn', agent: 'claude' });
        await registerAndStart({ name: 'tynn-slave', agent: 'codex' });

        const listed = await runAgentForMcp(CALLER_ID, { action: 'list' });

        expect(listed.ok).toBe(true);
        expect(listed.agents?.map((a) => `${a.provider}:${a.name}`).sort()).toEqual([
            'claude:tynn',
            'codex:tynn-slave',
        ]);
        // A read-only action creates nothing and asks nobody.
        expect(agentSpecs()).toHaveLength(2);
        expect(modalsRaised.filter((m) => m.includes('LAUNCH'))).toHaveLength(2);
    });
});

/**
 * `runAgent restart` must not leave a second agent behind — the reported bug.
 *
 * The Tynn workspace held ONE registered `claude:tynn` and THREE terminal specs
 * rendering "tynn", two of them bound to nothing and created within the same
 * minute. `restartAgentTerminal` is how they got there: it killed the pty and
 * then called `createAgentTerminal` with NO `id`, so
 *
 *  - a new spec id meant `reviving` was false, minting a fresh `meta.agent_id` —
 *    a NEW AgentInbox identity, stranding the old one's queued mail and history;
 *  - `killTerminalById` does not delete the spec, so the dead one kept its
 *    `meta.agent` and `whisper_purpose` and the AMS grid kept drawing it;
 *  - nothing rebound `workspace_agents.terminal_spec_id`, so the registry still
 *    pointed at the corpse and the next start reattached to it.
 *
 * The correct shape already existed next door: the Genie OSA branch deletes the
 * old spec and carries `agent_id` across by hand. A project agent should not need
 * either — reusing its own spec is what `reattachSavedAgent`'s revive already
 * does, and it makes all three failures impossible rather than repaired.
 *
 * Every "no second agent" assertion below carries a POSITIVE CONTROL that the
 * survivor is LIVE: absence passes trivially against a restart that simply
 * failed, which would be a worse bug than the duplicate.
 */
describe('runAgent restart', () => {
    const restart = (id: string) =>
        runAgentForMcp(CALLER_ID, { action: 'restart', id } as RunAgentRequest);

    it('leaves ONE agent, not two', async () => {
        const created = await registerAndStart({ name: 'tynn', agent: 'claude' });
        expect(created.ok).toBe(true);
        expect(agentSpecs()).toHaveLength(1);

        const again = await restart(created.id!);

        expect(again.ok).toBe(true);
        expect(agentSpecs()).toHaveLength(1);
        // POSITIVE CONTROL: the survivor is actually running.
        expect(terminalManager().isLive(agentSpecs()[0]!.id)).toBe(true);
    });

    it('keeps the durable AgentInbox identity across the restart', async () => {
        const created = await registerAndStart({ name: 'tynn', agent: 'claude' });
        const identityBefore = getTerminalSpec(created.id!)?.meta?.agent_id;
        expect(identityBefore).toBeTruthy();

        await restart(created.id!);

        // A new agent_id is a NEW AGENT wearing the old one's name: its inbox
        // cursors, queued mail, channel membership and DM history all hang off
        // this value, and a restart must not strand them.
        expect(agentIds()).toEqual([identityBefore]);
    });

    it('leaves the registry pointing at a spec that still exists', async () => {
        const created = await registerAndStart({ name: 'tynn', agent: 'claude' });

        await restart(created.id!);

        const registered = listWorkspaceAgents(WS_ID).find((a) => a.name === 'tynn');
        expect(registered?.terminal_spec_id).toBeTruthy();
        // Pointing at a deleted or dead spec is how the next `start` reattached
        // to a corpse instead of the agent that is actually running.
        expect(getTerminalSpec(registered!.terminal_spec_id!)).toBeTruthy();
        expect(terminalManager().isLive(registered!.terminal_spec_id!)).toBe(true);
    });

    it('a restarted agent is still the one a later start reattaches to', async () => {
        const created = await registerAndStart({ name: 'tynn', agent: 'claude' });
        await restart(created.id!);

        const again = await start({ name: 'tynn' });

        expect(again.ok).toBe(true);
        expect(again.reattached).toBe(true);
        expect(agentSpecs()).toHaveLength(1);
        expect(agentIds()).toHaveLength(1);
    });
});

/**
 * `start` must not mint a second terminal for an agent that already has one,
 * even when the spec's meta no longer agrees with the registry.
 *
 * Adoption keys on `meta.whisper_purpose` (agents/saved.ts), and the callers that
 * write it disagree: `runAgent start` stamps `config.name`, the human
 * Add-Terminal path stamps the purpose the user typed, and a GApp stamps
 * `panel.agent.name`. Rename an agent, or launch it by a path that stamps
 * something else, and the string no longer matches the registry row — so a
 * `start` that should reattach falls all the way through to a fresh spawn under
 * the same registered agent. That is the second way one agent came to own
 * several squares.
 *
 * The registry binding is the fact; the meta string is a copy of it that can
 * rot. A start must consult the fact.
 */
describe('runAgent start with drifted spec meta', () => {
    it('reattaches via the registry binding even when whisper_purpose no longer matches', async () => {
        const created = await registerAndStart({ name: 'tynn', agent: 'claude' });
        expect(created.ok).toBe(true);
        const identityBefore = getTerminalSpec(created.id!)?.meta?.agent_id;

        // The drift: the spec now says something else. The registry row still
        // points at this very spec, which is what makes the reattach knowable.
        const spec = getTerminalSpec(created.id!)!;
        updateTerminalSpec(created.id!, {
            meta: { ...spec.meta, whisper_purpose: 'something-else' },
        });

        const again = await start({ name: 'tynn' });

        expect(again.ok).toBe(true);
        expect(agentSpecs()).toHaveLength(1);
        expect(agentIds()).toEqual([identityBefore]);
        // POSITIVE CONTROL: it is the live agent that survived, not a husk.
        expect(terminalManager().isLive(created.id!)).toBe(true);
    });
});
