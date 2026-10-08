import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * PINNED TO THE PTY, 2026-10-07.
 *
 * ACP is no longer optional, so a claude agent is a structured session with no pty — and
 * these cases are about PTY MECHANICS, which remain real for every pty provider and most of
 * the twenty-one are. `engineOverride: 'pty'` keeps the behaviour under test on the engine
 * that has it, rather than deleting coverage or asserting it of a transport that has no pty.
 *
 * `engineOverride` is a supported configuration, not a test affordance: it is the only way
 * to hold an agent on the pty now that ACP is the default, and it was unreachable until the
 * same change — `engineFor` honoured it and nothing could set it.
 */
/**
 * A GApp's DECLARED agents actually launching (genie#245).
 *
 * The defect this pins: a GApp could declare agents in its manifest, ship the
 * personas under `.agents/`, pass `validateAppFolder`, be named on the consent
 * screen — and nothing ever started one. `ensureAppAgentPanels` called
 * `createTerminalSpec` with no agent binding at all, so a developer who followed
 * the SDK README ("`.agents/` says who those agents ARE") installed their app and
 * got N empty terminals with no error.
 *
 * So the assertion that matters is NOT "a terminal exists" — that passed on the
 * broken behaviour. It is that the terminal is BOUND: to the declared agent, to
 * its persona file, and to a TUI that was actually launched into the pty.
 *
 * REAL: the SQLite database (real migrations, real workspace / app-grant /
 * terminal_spec rows), the real settings reader, the real provider resolution, the
 * real cap counting, the real `createAgentTerminal` launch path, and the real pty
 * manager.
 *
 * FAKED: the pty PROCESS (node-pty), so no shell is really started — but the
 * manager still registers it and every `write` is captured, which is how "the TUI
 * was launched" is observable at all.
 */

/** Every write a pty received, in order — this is what "the agent launched" means. */
const writes: string[] = [];

vi.mock('node-pty', () => ({
    spawn: () => {
        let onExit: ((e: { exitCode: number }) => void) | null = null;
        return {
            pid: 1000 + writes.length,
            process: 'fake-shell',
            killed: false,
            onData: () => {},
            onExit: (cb: (e: { exitCode: number }) => void) => {
                onExit = cb;
            },
            write: (data: string) => {
                writes.push(data);
            },
            resize: () => {},
            kill() {
                this.killed = true;
                onExit?.({ exitCode: 0 });
            },
        };
    },
}));

// apps/ipc.ts reaches main/tray.ts through host-tools, and tray imports
// background.ts, which runs the Electron app bootstrap at MODULE LOAD. Cutting
// the chain here keeps the test about the seeder (same reason as
// mcp/__tests__/agent-cap-enforcement.test.ts).
vi.mock('../../tray', () => ({
    rebuildMenu: vi.fn(),
    createTray: vi.fn(),
    setInboxBadge: vi.fn(),
    setUpdateAvailable: vi.fn(),
}));

vi.mock('../../ask/force-question', () => ({ forceQuestion: vi.fn() }));

/**
 * The ACP START, recorded rather than performed.
 *
 * Mocked for two measured reasons. Unmocked, this file SPAWNED A REAL `claude`: the run
 * logged `ACP request initialize timed out after 60000ms`, a timeout `vi.runAllTimers()` had
 * fast-forwarded, so the suite was starting provider processes on whatever machine ran it.
 * And it is the only way to observe what the GApp path HANDS to a structured session — the
 * pty recorder cannot, because an ACP agent has no launch line.
 */
const acpStarts: Array<{
    specId: string;
    provider: string;
    cwd: string;
    instructions?: string;
    resumeSessionId?: string | null;
}> = [];
vi.mock('../../acp/start', () => ({
    startAcpForSpec: (input: {
        specId: string;
        provider: string;
        cwd: string;
        instructions?: string;
        resumeSessionId?: string | null;
    }) => {
        acpStarts.push(input);
        return { driver: {}, pid: 4242 };
    },
}));

import { app, dialog } from 'electron';
import {
    addWorkspace,
    createTerminalSpec,
    getTerminalSpec,
    initDatabase,
    listTerminalSpecs,
    setSettings,
    upsertAppGrant,
    type TerminalSpecRow,
} from '../../db';
import { ensureAppAgentPanels } from '../ipc';
import { createAgentTerminal } from '../../terminal/ipc';
import { savedAgentsOf } from '../../agents/saved';
import { savedAgentKey } from '../../agents/identity';
import { terminalManager } from '@particle-academy/fancy-term-host';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-gapp-agents-'));
const dataDir = path.join(tmpRoot, 'userData');
fs.mkdirSync(dataDir, { recursive: true });

vi.spyOn(app, 'getPath').mockReturnValue(dataDir);

/**
 * A refusal is reported to the user through an OS message box. Recorded rather
 * than shown so the "it failed VISIBLY" half is assertable — a refusal nobody is
 * told about is the silent shortfall this issue is about, wearing a new hat.
 */
const boxes: Array<{ message?: string; detail?: string }> = [];
vi.spyOn(dialog, 'showMessageBox').mockImplementation((async (opts: unknown) => {
    boxes.push(opts as { message?: string; detail?: string });
    return { response: 0 };
}) as never);

initDatabase(dataDir);

const STRATEGIST = { name: 'Strategist', persona: 'strategist.md' };
const REVIEWER = { name: 'Reviewer', persona: 'reviewer/persona.md' };

let seq = 0;

interface Installed {
    appId: string;
    workspaceId: string;
    folder: string;
}

/**
 * A real installed GApp: its own workspace row, its own grant, and a `.agents/`
 * folder on disk with both personas in it.
 *
 * A FRESH one per test rather than a database reset — `initDatabase` hands back
 * the open handle rather than reopening, and the seeder converges on what the
 * workspace already holds, so a leaked panel would make the next test seed nothing
 * and pass for the wrong reason.
 */
function installApp(): Installed {
    seq += 1;
    const appId = `com.example.trader${seq}`;
    const workspaceId = `ws-trader-${seq}`;
    const folder = path.join(tmpRoot, `trader${seq}.gapp`);
    fs.mkdirSync(path.join(folder, '.agents', 'reviewer'), { recursive: true });
    fs.writeFileSync(path.join(folder, '.agents', 'strategist.md'), '# Strategist\n');
    fs.writeFileSync(path.join(folder, '.agents', 'reviewer', 'persona.md'), '# Reviewer\n');

    addWorkspace({
        id: workspaceId,
        backend: 'none',
        project_id: appId,
        project_name: 'Trader',
        tynn_project_id: appId,
        tynn_project_name: 'Trader',
        shape: 'simple',
        path: folder,
        editor: null,
        editor_cmd: null,
        start_cmd: null,
        env_file: null,
        last_opened_at: null,
        created_by_genie: 1,
    });
    upsertAppGrant({
        appId,
        workspaceId,
        name: 'Trader',
        version: '1.0.0',
        slug: `trader${seq}`,
        scope: 'self',
        workspaces: [],
        capabilities: [],
        manifestJson: '{}',
        installPath: folder,
        source: null,
        revoked: false,
        devMode: false,
    });
    return { appId, workspaceId, folder };
}

/** The workspace's panels, as the Agent tab would list them. */
function panelSpecs(workspaceId: string): TerminalSpecRow[] {
    return listTerminalSpecs().filter(
        (s) => s.workspace_id === workspaceId && s.type !== 'process',
    );
}

/** Everything every pty was sent, concatenated. */
function delivered(): string {
    return writes.join('');
}

beforeEach(() => {
    // Kills the ptys, which is what frees cap slots between tests. The specs stay,
    // which is why each test gets its own workspace.
    terminalManager().killAll();
    writes.length = 0;
    boxes.length = 0;
    acpStarts.length = 0;
    setSettings({
        gapp_ai_provider: '',
        agent_default: '',
        agent_command_custom: '',
        max_agent_terminals: '8',
    });
});

afterAll(() => {
    terminalManager().killAll();
    try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
        /* best-effort — Windows may still hold the db file */
    }
});

describe('a GApp that declares an agent', () => {
    it('gets a terminal BOUND to that agent and its persona — not a bare shell', () => {
        const { appId, workspaceId, folder } = installApp();
        vi.useFakeTimers();
        try {
            ensureAppAgentPanels(appId, { agents: 1 }, [STRATEGIST]);

            const panels = panelSpecs(workspaceId);
            expect(panels).toHaveLength(1);
            const spec = panels[0]!;

            // The binding. Without it the terminal is indistinguishable from the
            // empty one today's code produces, which is exactly why "a terminal
            // exists" is not the assertion.
            expect(spec.meta.gapp_id).toBe(appId);
            expect(spec.meta.gapp_agent).toBe('Strategist');
            expect(spec.meta.gapp_persona).toBe(path.join(folder, '.agents', 'strategist.md'));
            expect(fs.existsSync(String(spec.meta.gapp_persona))).toBe(true);
            expect(spec.label).toBe('Strategist');

            // It is a REAL agent terminal — an AgentInbox identity and a TUI, the
            // same shape a specialized terminal has.
            expect(spec.meta.agent).toBe('claude');
            expect(typeof spec.meta.agent_id).toBe('string');
            expect(spec.meta.agent_command).toContain('claude');
            // THE PERSONA IS PERSISTED AS INSTRUCTIONS, not folded into the command.
            //
            // It used to be asserted of `agent_command`, and that was how a double briefing was
            // found: the GApp composed the launch line itself while `createAgentTerminal` folds
            // `instructions` in too, so the line carried the sentence twice. One record now, and
            // it is the field a revive re-applies (`maybeRelaunchAgent`) — so this is also the
            // assertion that a restarted GApp agent still knows who it is.
            expect(spec.meta.agent_instructions).toContain('Strategist');
            expect(spec.meta.agent_instructions).toContain('strategist.md');

            // ...and the agent was actually STARTED. A spec that merely CLAIMS an agent is
            // the same lie one panel further down.
            //
            // On ACP, which is where a claude agent runs now that ACP is not optional. This
            // used to assert the launch line typed into the pty, and that was right for the
            // engine it was written against. Rewritten rather than loosened: the property is
            // that the persona REACHES the agent, and an ACP session has no command line to
            // fold it into, so it travels as the session's instructions. Weakened to "a
            // terminal is live" instead, every GApp agent could have come up with no persona
            // at all and this would still have passed.
            expect(terminalManager().isLive(spec.id)).toBe(true);
            vi.runAllTimers();
            expect(acpStarts).toHaveLength(1);
            expect(acpStarts[0]!.specId).toBe(spec.id);
            expect(acpStarts[0]!.provider).toBe('claude');
            expect(acpStarts[0]!.instructions).toContain('Strategist');
            expect(acpStarts[0]!.instructions).toContain(
                path.join(folder, '.agents', 'strategist.md'),
            );
            // A FRESH conversation. Nothing has been captured yet, so there is nothing to
            // continue, and resuming an id this agent has never had would be a guess.
            expect(acpStarts[0]!.resumeSessionId ?? null).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('launches under the WORKSTATION provider, never the app’s choice', () => {
        setSettings({ gapp_ai_provider: 'codex' });
        const { appId, workspaceId } = installApp();

        ensureAppAgentPanels(appId, { agents: 1 }, [STRATEGIST]);

        const spec = panelSpecs(workspaceId)[0]!;
        expect(spec.meta.agent).toBe('codex');
        expect(String(spec.meta.agent_command).startsWith('codex')).toBe(true);
    });

    it('inherits the agent the user already chose in workstation setup', () => {
        setSettings({ agent_default: 'codex' });
        const { appId, workspaceId } = installApp();

        ensureAppAgentPanels(appId, { agents: 1 }, [STRATEGIST]);

        expect(panelSpecs(workspaceId)[0]!.meta.agent).toBe('codex');
    });

    it('binds every declared agent to its own panel', () => {
        const { appId, workspaceId, folder } = installApp();

        ensureAppAgentPanels(appId, { agents: 2 }, [STRATEGIST, REVIEWER]);

        expect(
            panelSpecs(workspaceId).map((s) => [s.meta.gapp_agent, s.meta.gapp_persona]),
        ).toEqual([
            ['Strategist', path.join(folder, '.agents', 'strategist.md')],
            ['Reviewer', path.join(folder, '.agents', 'reviewer', 'persona.md')],
        ]);
    });

    it('creates nothing the second time — reopening must not start the roster again', () => {
        const { appId, workspaceId } = installApp();
        ensureAppAgentPanels(appId, { agents: 2 }, [STRATEGIST, REVIEWER]);
        const ids = panelSpecs(workspaceId).map((s) => s.id);

        ensureAppAgentPanels(appId, { agents: 2 }, [STRATEGIST, REVIEWER]);

        expect(panelSpecs(workspaceId).map((s) => s.id)).toEqual(ids);
    });

    it('is the SAME roster ordinary saved agents use — one model, not two (Tynn #254)', () => {
        // The story's "not just GApps, and one implementation" clause, asserted
        // where it can actually be violated. A GApp agent is a terminal spec with
        // `meta.agent` + a name, which is exactly what a saved agent IS — so the
        // general reader finds the app's declared roster with no GApp knowledge
        // at all. If the GApp path ever grew its own record type, this is what
        // would catch it: `savedAgentsOf` would come back empty while the panels
        // still looked right.
        const { appId, workspaceId } = installApp();
        ensureAppAgentPanels(appId, { agents: 2 }, [STRATEGIST, REVIEWER]);

        const saved = savedAgentsOf(listTerminalSpecs(), workspaceId, (id) =>
            terminalManager().isLive(id),
        );

        // The key is the NAME now (v55 identity). The provider is asserted
        // separately below, because it is still true and still matters -- it is
        // just no longer part of who the agent IS.
        expect(saved.map((a) => savedAgentKey(a.name)).sort()).toEqual([
            'reviewer',
            'strategist',
        ]);
        expect(saved.every((a) => a.tui === 'claude')).toBe(true);
        // POSITIVE CONTROL — these are live agents with durable identities, not
        // rows that merely parse. "Two names came back" would also be true of two
        // empty shells, which is the bug this whole area keeps producing.
        expect(saved.every((a) => a.agentId && a.live)).toBe(true);
        // …and they are addressable BEFORE any chat-id exists, which is what a
        // Codex agent depends on.
        expect(saved.map((a) => savedAgentKey(a.name)).every((k) => !k.includes('::')))
            .toBe(true);
    });

    it('leaves an app with no declared agents with plain panels', () => {
        // Most GApps ship no agent. They must still get their panels, those panels
        // must still be plain shells, and nobody's subscription is spent on them.
        const { appId, workspaceId } = installApp();

        ensureAppAgentPanels(appId, { agents: 2 });

        const panels = panelSpecs(workspaceId);
        expect(panels).toHaveLength(2);
        for (const spec of panels) {
            expect(spec.meta.agent).toBeUndefined();
            expect(spec.meta.agent_id).toBeUndefined();
            expect(spec.meta.gapp_agent).toBeUndefined();
        }
        expect(delivered()).toBe('');
    });

    it('is a real terminal spec the workspace can revive, attributed to the app', () => {
        const { appId, workspaceId, folder } = installApp();

        ensureAppAgentPanels(appId, { agents: 1 }, [STRATEGIST]);
        const spec = getTerminalSpec(panelSpecs(workspaceId)[0]!.id);

        expect(spec?.type).toBe('terminal');
        expect(spec?.cwd).toBe(folder);
        // Stamped as the APP's ask, not the person's — a GApp spends someone else's
        // compute, so its terminals are attributed to the thing that asked for them.
        expect(spec?.meta.created_by).toBe('agent');
    });
});

describe('a GApp meeting the agent-terminal cap', () => {
    it('starts NOTHING and tells the user, rather than quietly running fewer agents', () => {
        setSettings({ max_agent_terminals: '1' });
        const { appId, workspaceId, folder } = installApp();
        // One slot, already taken by an agent the user is actually running. The app
        // declares two. The consent screen named two, so one is not an acceptable
        // answer — and a partial seed would leave the skipped slots permanently
        // unreachable, because the next open counts what is there and slices past.
        createAgentTerminal({
            workspaceId,
            cwd: folder,
            label: 'the user’s own agent',
            agentMeta: { agent: 'claude', command: 'claude' , engineOverride: 'pty' },
        });
        const before = panelSpecs(workspaceId).map((s) => s.id);

        const seeded = ensureAppAgentPanels(appId, { agents: 2 }, [STRATEGIST, REVIEWER]);

        expect(seeded.refused).toBeTruthy();
        expect(seeded.created).toEqual([]);
        expect(panelSpecs(workspaceId).map((s) => s.id)).toEqual(before);
        // VISIBLY. A GApp that was refused must not look like a GApp that opened.
        expect(boxes).toHaveLength(1);
        expect(`${boxes[0]?.message ?? ''} ${boxes[0]?.detail ?? ''}`).toContain('Trader');
    });

    it('seeds the whole roster when the workspace has room', () => {
        setSettings({ max_agent_terminals: '4' });
        const { appId, workspaceId } = installApp();

        const seeded = ensureAppAgentPanels(appId, { agents: 2 }, [STRATEGIST, REVIEWER]);

        expect(seeded.refused).toBeUndefined();
        expect(panelSpecs(workspaceId)).toHaveLength(2);
        expect(boxes).toHaveLength(0);
    });

    it('does not ration a GApp’s plain panels against the AGENT cap', () => {
        setSettings({ max_agent_terminals: '1' });
        const { appId, workspaceId, folder } = installApp();
        createAgentTerminal({
            workspaceId,
            cwd: folder,
            label: 'the user’s own agent',
            agentMeta: { agent: 'claude', command: 'claude' , engineOverride: 'pty' },
        });

        // No roster, so no agent terminal is being asked for — the Files/Terminal
        // furniture of a window the USER opened is not a fan-out. Three declared
        // panels against the one the agent terminal above already occupies leaves
        // two to seed, and the cap of 1 must not touch either.
        const seeded = ensureAppAgentPanels(appId, { agents: 3 });

        expect(seeded.refused).toBeUndefined();
        expect(seeded.created).toHaveLength(2);
    });
});

describe('a GApp whose install did not finish', () => {
    it('opens with no panels rather than throwing', () => {
        // Refusing to open a window over a missing workspace row turns a partial
        // install into an app that cannot be looked at, let alone repaired.
        const seeded = ensureAppAgentPanels('com.example.nothing', { agents: 1 }, [STRATEGIST]);

        expect(seeded.created).toEqual([]);
        expect(seeded.refused).toBeUndefined();
    });

    it('refuses the whole roster when the chosen provider has no command', () => {
        // `custom` with nothing configured. Falling back to a bare terminal would
        // be genie#245 exactly — an app that looks like it opened and quietly is
        // not running the agents its consent screen named — so the roster is
        // refused, visibly, and NOTHING is created.
        setSettings({ gapp_ai_provider: 'custom', agent_command_custom: '' });
        const { appId, workspaceId } = installApp();

        const seeded = ensureAppAgentPanels(appId, { agents: 2 }, [STRATEGIST, REVIEWER]);

        expect(seeded.created).toEqual([]);
        expect(seeded.refused).toMatch(/custom/i);
        expect(panelSpecs(workspaceId)).toHaveLength(0);
        expect(boxes).toHaveLength(1);
    });

    it('does not seed an agent whose persona is missing from the workspace', () => {
        const { appId, workspaceId, folder } = installApp();
        fs.rmSync(path.join(folder, '.agents', 'strategist.md'));

        const seeded = ensureAppAgentPanels(appId, { agents: 1 }, [STRATEGIST]);

        // The install-time check (`validateAppFolder`) already refuses a declared
        // agent with nothing behind it, so reaching here means the folder changed
        // under Genie. Launching a TUI against a path that is not there would open
        // an agent with no instructions — the same empty terminal, now with a model
        // session attached to it.
        expect(seeded.created).toEqual([]);
        expect(seeded.refused).toBeTruthy();
        expect(panelSpecs(workspaceId)).toHaveLength(0);
        expect(boxes).toHaveLength(1);
    });
});
