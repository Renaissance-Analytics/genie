import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * NO AGENT HOLDS A PTY. NOT ONE, NOT EVER, NOT AN UNUSED ONE.
 *
 * Owner directive, said many times before it was located: *"the only thing that should hold
 * a pty is bg process or services and such that genie spawns. No agents should ever hold a
 * pty."*
 *
 * ## What was actually happening
 *
 * `createAgentTerminal` called `terminalManager().create(createOpts)` UNCONDITIONALLY at
 * `ipc.ts:882` — about seventy lines BEFORE `launchPlan` decided the engine at `:949`. Every
 * agent, ACP or not, got a real pty spawned for it; the engine decision only ever controlled
 * whether a launch line was TYPED into that pty. The function's own comment said the quiet
 * part: *"Creating an agent terminal is ONE host-side operation: spawn the pty AND start the
 * agent's CLI in it."*
 *
 * That is why removing the pty ENGINE in v2.0.0-beta.3 did not stop agents being terminals —
 * they still held one. It is why they appear in `manageTerminals list`, and why
 * host-recovery revival reaches agents at all: losing the pty host means they had a pty to
 * lose.
 *
 * The approved design always said an ACP session gets a `terminal_specs` row **with no
 * pty** — that row is Genie's panel/identity table, not a pty table, and `code`, `plugin`
 * and `plugin-panel` specs have never had one. Only the "no pty" half was never built.
 *
 * ## The shape of this test
 *
 * TWO-SIDED on purpose. "An agent spawns no pty" is equally satisfied by a build where
 * NOTHING spawns one — terminals broken for everybody — so the positive control requires a
 * plain terminal to spawn exactly one. Counts, not booleans, so a second spawn cannot hide
 * behind a truthy check.
 *
 * Harness mirrors `agent-launch-eager.test.ts`: the REAL in-process backend from
 * fancy-term-host over a fake `node-pty`, so a spawn is observed where it actually happens
 * rather than at a mock of the manager that wraps it.
 */

vi.mock('electron', () => ({
    ipcMain: { handle: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
    WebContents: class {},
}));

const spawned: Array<{ pid: number }> = [];

vi.mock('node-pty', () => ({
    spawn: () => {
        let onExit: ((e: { exitCode: number }) => void) | null = null;
        const pid = spawned.length + 1;
        const p = {
            pid,
            process: 'fake',
            killed: false,
            onData: () => {},
            onExit: (cb: (e: { exitCode: number }) => void) => {
                onExit = cb;
            },
            write: () => {},
            resize: () => {},
            kill() {
                this.killed = true;
                onExit?.({ exitCode: 0 });
            },
        };
        spawned.push(p);
        return p;
    },
}));

vi.mock('../../agentinbox/codex-app-server-lifecycle', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../agentinbox/codex-app-server-lifecycle')>();
    return {
        ...actual,
        codexAppServerManager: {
            preparedFor: vi.fn(() => undefined),
            start: vi.fn(async () => ({
                address: 'ws://127.0.0.1:47891',
                session: { deliver: vi.fn(async () => undefined) },
            })),
            stop: vi.fn(),
        },
    };
});

const specs = new Map<string, Record<string, unknown>>();
vi.mock('../../db', () => ({
    getAllSettings: () => ({ track_cwd: 'off' }),
    getTerminalSpec: (id: string) => specs.get(id) ?? null,
    createTerminalSpec: (row: Record<string, unknown>) => {
        specs.set(row.id as string, row);
        return row;
    },
    updateTerminalSpec: (id: string, patch: Record<string, unknown>) => {
        const cur = specs.get(id);
        if (cur) specs.set(id, { ...cur, ...patch });
        return specs.get(id) ?? null;
    },
    listTerminalSpecs: () => Array.from(specs.values()),
    listWorkspaceAgents: () => [],
    listWorkspaces: () => [],
    getWorkspace: () => null,
    workspaceMcpEnabled: () => false,
}));

vi.mock('../genie-adapter', () => ({
    getSnapshotStore: () => ({
        readSnapshot: () => null,
        writeSnapshot: () => 1,
        deleteSnapshot: () => undefined,
    }),
    dbSettingsProvider: () => ({
        get: (k: string) => (k === 'track_cwd' ? 'off' : undefined),
    }),
}));

import { createAgentTerminal } from '../ipc';
import { configureInProcessBackend } from '@particle-academy/fancy-term-host';
import { recordProviderAvailability } from '../../agents/availability';

configureInProcessBackend({
    settings: { get: (k) => (k === 'track_cwd' ? 'off' : undefined) },
    snapshots: {
        readSnapshot: () => null,
        writeSnapshot: () => 1,
        deleteSnapshot: () => undefined,
    },
});

describe('an agent gets an identity row, never a pty', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        spawned.length = 0;
        specs.clear();
        recordProviderAvailability('claude', true);
    });

    // Every test file shares one fork, so leaving the fake clock installed hands the NEXT
    // file a dead clock that never fires (genie#76). Restored here, not at the end of each
    // case, so an early assertion failure cannot skip it.
    afterEach(() => {
        vi.useRealTimers();
    });

    it('spawns ZERO ptys for a claude agent', () => {
        createAgentTerminal({
            id: 'agent-acp',
            workspaceId: 'ws-1',
            cwd: process.cwd(),
            label: 'claude · agent',
            agentMeta: { agent: 'claude', command: 'claude --dangerously-skip-permissions' },
        });
        vi.runAllTimers();

        expect(spawned).toHaveLength(0);
    });

    it('spawns ZERO ptys even with a stale engineOverride: pty on the spec', () => {
        // The owner's machine carries that string on 30 specs from before the engine change.
        // A persisted value must not be able to buy a pty back.
        createAgentTerminal({
            id: 'agent-pinned',
            workspaceId: 'ws-1',
            cwd: process.cwd(),
            label: 'claude · pinned',
            agentMeta: { agent: 'claude', command: 'claude', engineOverride: 'pty' },
        });
        vi.runAllTimers();

        expect(spawned).toHaveLength(0);
    });

    it('POSITIVE CONTROL: a plain terminal DOES spawn exactly one pty', () => {
        // Services, builds, background processes and a shell a person opened are the only
        // things that should hold a pty — and they must keep holding one. Without this, every
        // assertion above passes against a build where terminals are simply broken.
        createAgentTerminal({
            id: 'plain-shell',
            workspaceId: 'ws-1',
            cwd: process.cwd(),
            label: 'a shell',
        });
        vi.runAllTimers();

        expect(spawned).toHaveLength(1);
    });
});
