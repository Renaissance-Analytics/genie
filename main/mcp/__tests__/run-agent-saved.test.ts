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
                // ASYNCHRONOUS, because node-pty is. The OS reports a process's
                // exit on a later turn of the loop — it cannot be delivered
                // inside the kill() call that requested it. A fake that fires
                // onExit synchronously is not a simplification, it is a
                // different machine: it makes kill-then-recreate-under-the-
                // same-id look atomic, and that is precisely the window the
                // restart bug lives in.
                setTimeout(() => onExit?.({ exitCode: 0 }), 0);
            },
            exit() {
                this.killed = true;
                setTimeout(() => onExit?.({ exitCode: 0 }), 0);
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

import { app, ipcMain } from 'electron';
import { stopRegisteredAgent } from '../../agents/agent-manager';
import { recordProviderAvailability, resetProviderAvailabilityCache } from '../../agents/availability';
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
    bindWorkspaceAgentTerminal,
} from '../../db';
import { registerAgentForMcp, runAgentForMcp } from '../host-tools';
import { registerAgentInboxSession } from '../../agentinbox/session-registration';
import { terminalManager } from '@particle-academy/fancy-term-host';
import type { RunAgentRequest, RunAgentResult } from '../protocol';
import { useTempClaudeHome, writeTranscript } from '../../__tests__/support/claude-transcripts';
import * as terminalIpc from '../../terminal/ipc';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-saved-agents-'));
const dataDir = path.join(tmpRoot, 'userData');
const wsDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(wsDir, { recursive: true });

(app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;

useTempClaudeHome();

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
    // Not `general`: that is a RESERVED name now (Tynn story #262) and
    // registration refuses it, so a caller relying on this default would get a
    // refusal that has nothing to do with what it was testing.
    const name = req.name ?? 'tynn-builder';
    const provider = req.agent ?? 'claude';
    const registered = await registerAgentForMcp(CALLER_ID, {
        name,
        purpose: `Test agent ${name}`,
        agent: provider,
    });
    if (!registered.ok) return registered as RunAgentResult;
    return start({ ...req, create: undefined });
}

async function registerCaller(name = 'tynn-builder'): Promise<void> {
    const registered = await registerAgentForMcp(CALLER_ID, {
        name,
        purpose: 'Drive the test workspace',
        agent: 'claude',
    });
    expect(registered.ok).toBe(true);
    bindWorkspaceAgentTerminal(registered.agent!.id, CALLER_ID);
}

beforeEach(() => {
    resetProviderAvailabilityCache();
    terminalManager().killAll();
    for (const s of listTerminalSpecs()) deleteTerminalSpec(s.id);
    for (const agent of listWorkspaceAgents(WS_ID)) {
        deleteWorkspaceAgent(agent.id);
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

describe('host-side saved-agent revival', () => {
    function rendererCreate() {
        let create: any;
        const spy = vi.spyOn(ipcMain, 'handle').mockImplementation((channel: string, handler: any) => {
            if (channel === 'terminal:create') create = handler;
        });
        terminalIpc.registerTerminalIpc();
        spy.mockRestore();
        return (id: string) => create({ sender: { once() {}, off() {}, isDestroyed: () => false } }, { id, cwd: wsDir });
    }
    function saved(id: string, meta = {}) {
        return createTerminalSpec({ id, workspace_id: WS_ID, cwd: wsDir, label: id,
            type: 'terminal', meta: { agent: 'claude', agent_id: id, agent_command: 'echo revived-agent', was_running: true, ...meta } });
    }
    const revive = (schedule: (run: () => void, delay: number) => void = run => run()) =>
        terminalIpc.reviveRunningAgents(schedule);

    it('boots without a renderer and a subsequent attach launches no second copy', async () => {
        saved('headless');
        revive();
        expect(terminalManager().isLive('headless')).toBe(true);
        expect(terminalIpc.terminalHasWindow('headless')).toBe(false);
        const attached = terminalIpc.createAgentTerminal({ id: 'headless', workspaceId: WS_ID, cwd: wsDir,
            label: 'headless', agentMeta: { agent: 'claude', command: 'echo revived-agent' } });
        expect(attached.existing).toBe(true);
        expect(spawnedPtys).toHaveLength(1);
        await vi.waitFor(() => expect(spawnedPtys[0].written.join('')).toContain('echo revived-agent'));
        expect(spawnedPtys[0].written.filter(s => s.includes('echo revived-agent'))).toHaveLength(1);
    });

    it('honours the workspace cap and deliberate stop with a live positive control', () => {
        setWorkspaceAgentCap(WS_ID, 1);
        saved('stopped', { user_stopped: true });
        saved('first');
        saved('over-cap');
        revive();
        expect(terminalManager().isLive('first')).toBe(true);
        expect(terminalManager().isLive('stopped')).toBe(false);
        expect(terminalManager().isLive('over-cap')).toBe(false);
    });

    it('staggered work rechecks stop intent before spawning', () => {
        saved('first');
        saved('second');
        const jobs: Array<{ run: () => void; delay: number }> = [];
        revive((run, delay) => jobs.push({ run, delay }));
        expect(jobs).toHaveLength(2);
        expect(jobs[1].delay).toBeGreaterThan(jobs[0].delay);
        updateTerminalSpec('second', { meta: { ...getTerminalSpec('second')!.meta, user_stopped: true } });
        jobs.forEach(job => job.run());
        expect(terminalManager().isLive('first')).toBe(true);
        expect(terminalManager().isLive('second')).toBe(false);
    });

    it('records explicit start and stop, retaining stop intent until a new explicit start', async () => {
        saved('lifecycle', { was_running: false, user_stopped: true });
        const launch = () => terminalIpc.createAgentTerminal({ id: 'lifecycle', workspaceId: WS_ID, cwd: wsDir,
            label: 'lifecycle', agentMeta: { agent: 'claude', command: 'echo revived-agent' } });
        launch();
        expect(getTerminalSpec('lifecycle')?.meta).toMatchObject({ was_running: true, user_stopped: false });
        terminalIpc.killTerminalById('lifecycle');
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(getTerminalSpec('lifecycle')?.meta).toMatchObject({ was_running: false, user_stopped: true });
        revive();
        expect(terminalManager().isLive('lifecycle')).toBe(false);
        launch();
        expect(terminalManager().isLive('lifecycle')).toBe(true);
        expect(getTerminalSpec('lifecycle')?.meta).toMatchObject({ was_running: true, user_stopped: false });
    });

    it('records terminal failure but preserves running intent when Genie shuts down', async () => {
        terminalIpc.subscribeHeadlessBackendEvents();
        saved('failed'); saved('quit');
        revive();
        spawnedPtys[0].exit();
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(getTerminalSpec('failed')?.meta?.was_running).toBe(false);
        expect(terminalManager().isLive('quit')).toBe(true);
        terminalIpc.stopAllTerminals();
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(getTerminalSpec('quit')?.meta?.was_running).toBe(true);
    });

    it('panel mount waits for queued revival and cannot bypass deliberate stop', async () => {
        const attach = rendererCreate();
        saved('queued'); saved('stopped', { user_stopped: true });
        const jobs: Array<() => void> = [];
        revive(run => jobs.push(run));
        const pending = attach('queued');
        expect(await Promise.race([Promise.resolve(pending).then(() => 'attached'),
            new Promise(resolve => setTimeout(() => resolve('pending'), 10))])).toBe('pending');
        expect(() => attach('stopped')).toThrow(/stopped/i);
        jobs.forEach(run => run());
        expect((await pending).existing).toBe(true);
        expect((await attach('queued')).existing).toBe(true);
        expect(terminalManager().isLive('queued')).toBe(true);
        expect(spawnedPtys).toHaveLength(1);
    });

    it('does not revive a provider known to be unavailable, with a live control', () => {
        recordProviderAvailability({ id: 'genie', status: 'unavailable', reason: 'missing binary' });
        saved('missing', { agent: 'genie' }); saved('available');
        revive();
        expect(terminalManager().isLive('available')).toBe(true);
        expect(terminalManager().isLive('missing')).toBe(false);
    });

    it('explicit stop cancels a queued registered agent even with no live pty yet', async () => {
        const started = await registerAndStart({ name: 'tynn-builder', agent: 'claude' });
        expect(started.ok, JSON.stringify(started)).toBe(true);
        terminalIpc.stopAllTerminals();
        await new Promise(resolve => setTimeout(resolve, 10));
        const jobs: Array<() => void> = [];
        revive(run => jobs.push(run));
        expect(jobs.length).toBeGreaterThan(0);
        const registered = listWorkspaceAgents(WS_ID)[0];
        expect(stopRegisteredAgent(registered.id).ok).toBe(true);
        jobs.forEach(run => run());
        expect(terminalManager().isLive(started.id!)).toBe(false);
        expect(getTerminalSpec(started.id!)?.meta?.user_stopped).toBe(true);
    });

    it('hibernation preserves running intent instead of recording an explicit agent stop', async () => {
        saved('hibernated');
        revive();
        expect(terminalManager().isLive('hibernated')).toBe(true);
        terminalIpc.stopWorkspaceTerminalsForHibernation(WS_ID);
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(terminalManager().isLive('hibernated')).toBe(false);
        expect(getTerminalSpec('hibernated')?.meta).toMatchObject({ was_running: true });
        expect(getTerminalSpec('hibernated')?.meta?.user_stopped).not.toBe(true);
    });

    it('quitting cancels queued launches while retaining their running intent for next boot', () => {
        saved('queued-at-quit');
        const jobs: Array<() => void> = [];
        revive(run => jobs.push(run));
        expect(jobs).toHaveLength(1);
        terminalIpc.stopAllTerminals();
        jobs.forEach(run => run());
        expect(terminalManager().isLive('queued-at-quit')).toBe(false);
        expect(getTerminalSpec('queued-at-quit')?.meta?.was_running).toBe(true);
    });

    it('adopts observed live agents from a surviving host without inferring liveness for dormant legacy specs', () => {
        saved('survivor', { was_running: undefined });
        saved('legacy-dormant', { was_running: undefined });
        terminalManager().create({ id: 'survivor', cwd: wsDir });
        revive();
        expect(getTerminalSpec('survivor')?.meta?.was_running).toBe(true);
        expect(terminalManager().isLive('survivor')).toBe(true);
        expect(terminalManager().isLive('legacy-dormant')).toBe(false);
        expect(spawnedPtys).toHaveLength(1);
        expect(spawnedPtys[0].written).toHaveLength(0);
    });
});

/**
 * NOTE ON THE FIXTURE NAME (Tynn story #262). These tests used to register an
 * agent literally named `tynn`. That is now a RESERVED name — refused in every
 * workspace except the one Tynn grants it to (`agents/reserved-names.ts`) — so
 * the fixture is `tynn-builder`, which is deliberately not reserved and is
 * asserted as such next to the block list itself.
 *
 * The name is incidental to everything below: these cover registration,
 * reattachment, revival and restart, none of which depend on the string. The
 * reserved-name contract has its own tests at the same tool boundary
 * (`reserved-agent-names.test.ts`).
 */
describe('registering an agent before start', () => {
    it('needs `registerAgent` — a bare start refuses instead of minting a stranger', async () => {
        const r = await start({ name: 'tynn-builder' });

        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/registerAgent/i);
        // Nothing came into being, and the user was never asked to approve
        // something that was already refused.
        expect(agentSpecs()).toHaveLength(0);
        expect(spawnedPtys).toHaveLength(0);
        expect(modalsRaised).toEqual([]);
    });

    it('starts one registered agent, with its provider and name on the terminal', async () => {
        const r = await registerAndStart({ name: 'tynn-builder', agent: 'claude' });

        expect(r.ok).toBe(true);
        expect(r.id).toBeTruthy();
        expect(r.reattached).toBe(false);
        // The canonical machine-facing identity, TUI first — which is what this
        // comment always said, and what the assertion stopped checking when
        // `ddece5f7` dropped the tui from the ref. genie#388 put it back.
        expect(r.ref).toMatch(/^claude:tynn-builder:/);

        const spec = getTerminalSpec(r.id!);
        expect(spec?.meta?.agent).toBe('claude');
        expect(spec?.meta?.whisper_purpose).toBe('tynn-builder');
        expect(spec?.meta?.agent_id).toBeTruthy();
        expect(terminalManager().isLive(r.id!)).toBe(true);
    });

    it('refuses a second agent under a name the workspace already has', async () => {
        const first = await registerAndStart({ name: 'tynn-builder', agent: 'claude' });
        expect(first.ok).toBe(true);

        const second = await registerAndStart({ name: 'tynn-builder', agent: 'claude' });

        expect(second.ok).toBe(false);
        // The NAME, not `claude:tynn`: since v55 the TUI is not part of the
        // identity, so naming it in the refusal would describe a key that no
        // longer exists and imply a `codex:tynn` were still available.
        expect(second.error).toContain('tynn-builder');
        expect(second.error).not.toContain('claude:tynn-builder');
        expect(agentSpecs()).toHaveLength(1);
        // POSITIVE CONTROL — the one that exists is genuinely running.
        expect(terminalManager().isLive(first.id!)).toBe(true);
    });
});

describe('runAgent start on a SAVED agent', () => {
    it('binds a Codex SessionStart id onto the just-created saved agent without duplicating it', async () => {
        const created = await registerAndStart({ name: 'tynn-builder', agent: 'codex' });
        expect(created.ok).toBe(true);
        // `{tui}:{name}`, with no chat id yet — Codex cannot know its session id
        // until it is running, and this is the state it starts in (genie#388).
        expect(created.ref).toBe('codex:tynn-builder');
        expect(created.sessionBinding).toBe('pending');

        const registered = registerAgentInboxSession(created.id!, 'codex-session-1', {
            getTerminalSpec,
            updateTerminalSpec,
            setChatSession: () => {},
        });
        expect(registered.ok).toBe(true);

        const attached = await start({ name: 'tynn-builder', agent: 'codex' });
        expect(attached.ok).toBe(true);
        expect(attached.id).toBe(created.id);
        expect(attached.ref).toBe('codex:tynn-builder:codex-session-1');
        expect(attached.sessionBinding).toBe('bound');
        expect(agentSpecs()).toHaveLength(1);
        expect(agentIds()).toHaveLength(1);
    });

    it('REATTACHES to the live agent instead of creating a second one', async () => {
        const created = await registerAndStart({ name: 'tynn-builder', agent: 'claude' });
        expect(created.ok).toBe(true);
        const ptysAfterCreate = spawnedPtys.length;

        const again = await start({ name: 'tynn-builder' });

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
            const created = await registerAndStart({ name: 'tynn-builder', agent: 'claude' });
            vi.runAllTimers();
            const pty = spawnedPtys[spawnedPtys.length - 1]!;
            const writesAfterLaunch = pty.written.length;
            expect(writesAfterLaunch).toBeGreaterThan(0); // POSITIVE CONTROL: it did launch

            await start({ name: 'tynn-builder' });
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
        const created = await registerAndStart({ name: 'tynn-builder', agent: 'claude' });
        const agentIdBefore = getTerminalSpec(created.id!)?.meta?.agent_id;
        expect(agentIdBefore).toBeTruthy();

        // The agent finishes and its shell exits. The spec is retained.
        spawnedPtys[spawnedPtys.length - 1]!.exit();
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(terminalManager().isLive(created.id!)).toBe(false);

        const revived = await start({ name: 'tynn-builder' });

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
        const claude = await registerAndStart({ name: 'tynn-builder', agent: 'claude' });
        expect(claude.ok).toBe(true);

        const second = await registerAgentForMcp(CALLER_ID, {
            name: 'tynn-builder',
            purpose: 'the same name, a different driver',
            agent: 'codex',
        });

        expect(second.ok).toBe(false);
        // POSITIVE CONTROL: the refusal left the original alone and running,
        // rather than being a failure that happened to leave one agent behind.
        expect(agentSpecs()).toHaveLength(1);
        expect(terminalManager().isLive(claude.id!)).toBe(true);
        // And a bare name is no longer ambiguous, because it cannot be.
        expect((await start({ name: 'tynn-builder' })).id).toBe(claude.id);
    });
});

describe('runAgent sidecar', () => {
    it('registers and starts the caller\'s named child under the requested TUI', async () => {
        await registerCaller();

        const result = await runAgentForMcp(CALLER_ID, {
            action: 'sidecar',
            agent: 'codex',
            instructions: 'Review independently.',
        });

        expect(result).toMatchObject({
            ok: true,
            agent: 'codex',
            name: 'tynn-builder-slave',
            reattached: false,
        });
        const roster = listWorkspaceAgents(WS_ID);
        const driver = roster.find((agent) => agent.name === 'tynn-builder')!;
        const sidecar = roster.find((agent) => agent.name === 'tynn-builder-slave')!;
        expect(sidecar.parent_agent_id).toBe(driver.id);
        expect(sidecar.tui).toBe('codex');
        expect(result.id).toBeTruthy();
        expect(terminalManager().isLive(result.id!)).toBe(true);
    });

    it('reattaches the one existing sidecar instead of registering or spawning another', async () => {
        await registerCaller();
        const first = await runAgentForMcp(CALLER_ID, { action: 'sidecar', agent: 'codex' });
        expect(first.ok).toBe(true);

        const second = await runAgentForMcp(CALLER_ID, { action: 'sidecar', agent: 'codex' });

        expect(second).toMatchObject({
            ok: true,
            id: first.id,
            name: 'tynn-builder-slave',
            reattached: true,
        });
        expect(listWorkspaceAgents(WS_ID).map((agent) => agent.name).sort()).toEqual([
            'tynn-builder',
            'tynn-builder-slave',
        ]);
        expect(spawnedPtys).toHaveLength(1);
        expect(terminalManager().isLive(first.id!)).toBe(true);
    });

    it('refuses callers that are not registered agents and sidecars of sidecars', async () => {
        const unregistered = await runAgentForMcp(CALLER_ID, {
            action: 'sidecar',
            agent: 'codex',
        });
        expect(unregistered.ok).toBe(false);
        expect(unregistered.error).toMatch(/registered agent/i);

        await registerCaller('tynn-builder-slave');
        const nested = await runAgentForMcp(CALLER_ID, {
            action: 'sidecar',
            agent: 'codex',
        });
        expect(nested.ok).toBe(false);
        expect(nested.error).toMatch(/sidecar.*sidecar/i);
        expect(spawnedPtys).toHaveLength(0);
    });

    it('requires an explicit, different TUI', async () => {
        await registerCaller();

        const missing = await runAgentForMcp(CALLER_ID, { action: 'sidecar' });
        expect(missing.ok).toBe(false);
        expect(missing.error).toMatch(/different TUI/i);

        const same = await runAgentForMcp(CALLER_ID, {
            action: 'sidecar',
            agent: 'claude',
        });
        expect(same.ok).toBe(false);
        expect(same.error).toMatch(/different TUI/i);
        expect(listWorkspaceAgents(WS_ID)).toHaveLength(1);
        expect(spawnedPtys).toHaveLength(0);
    });
});

describe('listing the workspace roster', () => {
    it('reports every saved agent by its canonical ref, and never invents one', async () => {
        await registerAndStart({ name: 'tynn-builder', agent: 'claude' });
        await registerAndStart({ name: 'tynn-slave', agent: 'codex' });

        const listed = await runAgentForMcp(CALLER_ID, { action: 'list' });

        expect(listed.ok).toBe(true);
        expect(listed.agents?.map((a) => `${a.tui}:${a.name}`).sort()).toEqual([
            'claude:tynn-builder',
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
    /**
     * The agent HAS SPOKEN — write the transcript Claude writes the moment a
     * session begins, for the id Genie minted at launch.
     *
     * A resume is resolved against what is on disk, not against the spec's word
     * for it, so an agent with a minted id and no transcript has nothing to
     * resume and the restart correctly refuses. Every test below is about what a
     * SUCCESSFUL restart leaves behind, so each one needs a conversation that is
     * really there — otherwise "no second agent" passes because no restart
     * happened at all, which is the vacuous pass the positive controls exist to
     * catch.
     */
    const haveSpoken = (specId: string): void => {
        const spec = getTerminalSpec(specId);
        const sid = spec?.meta?.chat_session_id;
        if (spec && sid) writeTranscript(spec.cwd, sid);
    };

    const restart = (id: string) =>
        runAgentForMcp(CALLER_ID, { action: 'restart', id } as RunAgentRequest);
    const restartFresh = (id: string) =>
        runAgentForMcp(CALLER_ID, { action: 'restart', id, fresh: true } as RunAgentRequest);

    it('REFUSES a resume it cannot do, and performs the FRESH restart it can', async () => {
        // genie#443 over MCP. A `genie` agent has no resume grammar, so a plain
        // restart refuses — correctly, since inventing one would silently open a
        // NEW conversation while claiming to resume (genie#440). Before `fresh`
        // existed that refusal was the end of the road, and an agent asked to
        // repair a wedged peer had no verb that worked.
        const created = await registerAndStart({ name: 'genie-builder', agent: 'genie' });
        expect(created.ok).toBe(true);

        const refused = await restart(created.id!);
        expect(refused.ok).toBe(false);
        expect(refused.error).toMatch(/fresh/i);
        // The refusal tore NOTHING down — the agent it declined to restart is
        // still running, which is the half of the old behaviour that was right.
        expect(terminalManager().isLive(created.id!)).toBe(true);

        const fresh = await restartFresh(created.id!);

        expect(fresh.ok).toBe(true);
        // POSITIVE CONTROL: one agent, and it is actually running — "no second
        // agent" passes trivially against a restart that simply failed.
        expect(agentSpecs()).toHaveLength(1);
        expect(terminalManager().isLive(agentSpecs()[0]!.id)).toBe(true);
    });

    it('leaves ONE agent, not two', async () => {
        const created = await registerAndStart({ name: 'tynn-builder', agent: 'claude' });
        expect(created.ok).toBe(true);
        expect(agentSpecs()).toHaveLength(1);
        haveSpoken(created.id!);

        const again = await restart(created.id!);

        expect(again.ok).toBe(true);
        expect(agentSpecs()).toHaveLength(1);
        // POSITIVE CONTROL: the survivor is actually running.
        expect(terminalManager().isLive(agentSpecs()[0]!.id)).toBe(true);
    });

    it('SURVIVES the old pty exiting after the replacement took its id', async () => {
        // THE FREEZE the owner reported: "the terminal dies but the UI never
        // changes, it just freezes until you close the panel and open it again".
        //
        // A restart reuses `spec.id` deliberately — that is what preserves the
        // AgentInbox identity (see this block's docblock). But each pty's exit
        // handler in fancy-term-host is a closure over that id and deletes
        // WHOEVER HOLDS IT, not itself. node-pty delivers an exit on a LATER
        // tick, so the order is: kill → replacement takes the id → the dead
        // pty's exit arrives and evicts the replacement. The new pty keeps
        // running, the manager has forgotten it, ownership is dropped, and the
        // renderer is told `[process exited]` about a terminal that is alive.
        //
        // Every other assertion in this block checks liveness in the instant
        // BEFORE that exit lands, which is why they all passed through it.
        const created = await registerAndStart({ name: 'tynn-builder', agent: 'claude' });
        haveSpoken(created.id!);

        const again = await restart(created.id!);
        expect(again.ok).toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(agentSpecs()).toHaveLength(1);
        expect(terminalManager().isLive(agentSpecs()[0]!.id)).toBe(true);
    });

    it('keeps the durable AgentInbox identity across the restart', async () => {
        const created = await registerAndStart({ name: 'tynn-builder', agent: 'claude' });
        const identityBefore = getTerminalSpec(created.id!)?.meta?.agent_id;
        expect(identityBefore).toBeTruthy();
        haveSpoken(created.id!);

        await restart(created.id!);

        // A new agent_id is a NEW AGENT wearing the old one's name: its inbox
        // cursors, queued mail, channel membership and DM history all hang off
        // this value, and a restart must not strand them.
        expect(agentIds()).toEqual([identityBefore]);
    });

    it('leaves the registry pointing at a spec that still exists', async () => {
        const created = await registerAndStart({ name: 'tynn-builder', agent: 'claude' });
        haveSpoken(created.id!);

        await restart(created.id!);

        const registered = listWorkspaceAgents(WS_ID).find((a) => a.name === 'tynn-builder');
        expect(registered?.terminal_spec_id).toBeTruthy();
        // Pointing at a deleted or dead spec is how the next `start` reattached
        // to a corpse instead of the agent that is actually running.
        expect(getTerminalSpec(registered!.terminal_spec_id!)).toBeTruthy();
        expect(terminalManager().isLive(registered!.terminal_spec_id!)).toBe(true);
    });

    it('a restarted agent is still the one a later start reattaches to', async () => {
        const created = await registerAndStart({ name: 'tynn-builder', agent: 'claude' });
        await restart(created.id!);

        const again = await start({ name: 'tynn-builder' });

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
        const created = await registerAndStart({ name: 'tynn-builder', agent: 'claude' });
        expect(created.ok).toBe(true);
        const identityBefore = getTerminalSpec(created.id!)?.meta?.agent_id;

        // The drift: the spec now says something else. The registry row still
        // points at this very spec, which is what makes the reattach knowable.
        const spec = getTerminalSpec(created.id!)!;
        updateTerminalSpec(created.id!, {
            meta: { ...spec.meta, whisper_purpose: 'something-else' },
        });

        const again = await start({ name: 'tynn-builder' });

        expect(again.ok).toBe(true);
        expect(agentSpecs()).toHaveLength(1);
        expect(agentIds()).toEqual([identityBefore]);
        // POSITIVE CONTROL: it is the live agent that survived, not a husk.
        expect(terminalManager().isLive(created.id!)).toBe(true);
    });
});
