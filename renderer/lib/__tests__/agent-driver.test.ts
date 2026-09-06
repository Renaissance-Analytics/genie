import { describe, expect, it } from 'vitest';
import {
    agentManagerTabs,
    agentRunControl,
    driverRows,
    driverSummary,
} from '../agent-manager';
import type { AgentManagerState } from '../genie';

/**
 * THE DRIVER CONTROL — genie#463.
 *
 * `runAgent switchTui` has been fully built over MCP since v55, and the manager
 * had four tabs, none of which was a driver. So an AGENT could change the TUI it
 * runs under and a HUMAN could not, past the one-shot picker in the create form.
 *
 * The decisions live here, as everywhere else in `renderer/lib`, because the
 * renderer has no DOM harness. The one that matters most is the refusal:
 * `AGENT.md` may list the TUIs an agent is written for, `decideTuiSwitch` turns
 * that into a refusal on the host, and a UI that offered the switch anyway would
 * be a button whose only outcome is an error message. So the rows are built from
 * THE SAME decision the host makes — not a second copy of the rule.
 */

const drivers = [
    { tui: 'claude', label: 'Claude Code' },
    { tui: 'codex', label: 'Codex' },
    { tui: 'genie', label: 'Genie' },
];

const runtime = (tui: string, fronted = false) => ({
    id: `r-${tui}`,
    tui,
    terminalSpecId: fronted ? `t-${tui}` : null,
    fronted,
});

describe('driverRows', () => {
    it('marks the fronted TUI active and offers it no switch', () => {
        const rows = driverRows({
            drivers,
            runtimes: [runtime('claude', true)],
            allowed: [],
        });
        const claude = rows.find((r) => r.tui === 'claude')!;
        expect(claude.state).toBe('active');
        expect(claude.action).toBeNull();
    });

    it('offers ONE action for a driver the agent already holds — flipping to it', () => {
        const rows = driverRows({
            drivers,
            runtimes: [runtime('claude', true), runtime('codex')],
            allowed: [],
        });
        const codex = rows.find((r) => r.tui === 'codex')!;
        expect(codex.state).toBe('sidecar');
        expect(codex.action).toEqual({ kind: 'front', label: 'Switch to Codex' });
    });

    it('offers the SAME one action for a driver it has never run', () => {
        // "Switching between them as ONE action rather than two concepts": the
        // human presses Switch either way; the row's state is what tells them
        // whether a conversation is waiting on the other side.
        const rows = driverRows({
            drivers,
            runtimes: [runtime('claude', true)],
            allowed: [],
        });
        const genie = rows.find((r) => r.tui === 'genie')!;
        expect(genie.state).toBe('unused');
        expect(genie.action).toEqual({ kind: 'create', label: 'Switch to Genie' });
    });

    it('does NOT offer a switch the host would refuse, and gives the host’s reason', () => {
        const rows = driverRows({
            drivers,
            runtimes: [runtime('claude', true)],
            allowed: ['claude', 'codex'],
        });
        const genie = rows.find((r) => r.tui === 'genie')!;
        expect(genie.action).toBeNull();
        expect(genie.refusal).toContain('does not list "genie"');
        expect(genie.refusal).toContain('claude, codex');

        // POSITIVE CONTROL. "The switch is not offered" passes against a
        // component that offers no switches at all, so assert in the SAME call
        // that a permitted driver still gets one.
        expect(rows.find((r) => r.tui === 'codex')!.action).toEqual({
            kind: 'create',
            label: 'Switch to Codex',
        });
        expect(rows.find((r) => r.tui === 'codex')!.refusal).toBeNull();
    });

    /**
     * A registered agent that has never been STARTED has no `agent_runtimes`
     * row at all — the binding is created when a terminal is (see
     * `bind-creates-missing-runtime.test.ts`). Its driver is the one on the
     * record, which is exactly what `effectiveTui` falls back to on the host.
     *
     * Without this the panel said "moic is not running. Its driver is Claude
     * Code." and then offered, one line below, to switch it to Claude Code.
     */
    it('marks the RECORD’s driver active when no runtime is fronted yet', () => {
        const rows = driverRows({
            drivers,
            runtimes: [],
            allowed: [],
            current: 'claude',
        });
        const claude = rows.find((r) => r.tui === 'claude')!;
        expect(claude.state).toBe('active');
        expect(claude.action).toBeNull();
        // POSITIVE CONTROL: the other drivers are still switchable, so this is
        // not a panel that has simply stopped offering anything.
        expect(rows.find((r) => r.tui === 'codex')!.action).toEqual({
            kind: 'create',
            label: 'Switch to Codex',
        });
    });

    it('lets a FRONTED runtime win over a stale record driver', () => {
        // The record's `tui` is a fallback, not the truth: once a runtime is
        // fronted it is the driver in the chair.
        const rows = driverRows({
            drivers,
            runtimes: [runtime('codex', true)],
            allowed: [],
            current: 'claude',
        });
        expect(rows.find((r) => r.tui === 'codex')!.state).toBe('active');
        expect(rows.find((r) => r.tui === 'claude')!.action).not.toBeNull();
    });

    it('treats an EMPTY tuis list as no opinion, not as a lockout', () => {
        // `agentAllowedTuis` returns [] both for a file that says nothing and
        // for an agent with no file at all. Reading that as "none" would make
        // every agent unswitchable until somebody edited a file they have never
        // seen.
        const rows = driverRows({ drivers, runtimes: [], allowed: [] });
        expect(rows.every((r) => r.refusal === null)).toBe(true);
        expect(rows.every((r) => r.action !== null)).toBe(true);
    });
});

describe('driverSummary', () => {
    it('names the driver an agent is actually running under', () => {
        expect(driverSummary({ name: 'moic', tui: 'claude', running: true }, drivers)).toBe(
            'moic is running under Claude Code.',
        );
    });

    it('POSITIVE CONTROL: a dormant agent reads differently, and still names its driver', () => {
        expect(driverSummary({ name: 'moic', tui: 'codex', running: false }, drivers)).toBe(
            'moic is not running. Its driver is Codex.',
        );
    });

    it('says so plainly when no driver is set at all', () => {
        expect(driverSummary({ name: 'trader', tui: null, running: false }, drivers)).toBe(
            'trader is not running, and has no driver yet.',
        );
    });
});

describe('agentRunControl — the human half of `runAgent stop` (genie#474)', () => {
    it('offers STOP for a running agent, and says what it leaves alone', () => {
        const control = agentRunControl({ name: 'moic', running: true });
        expect(control.action).toBe('stop');
        expect(control.label).toBe('Stop moic');
        // The whole point of the issue: the only other direction offered was
        // Delete, so the copy has to distinguish them where the button is.
        expect(control.note).toMatch(/keeps its identity/i);
        expect(control.note).toMatch(/AGENT\.md/);
    });

    it('POSITIVE CONTROL: a dormant agent is offered START instead', () => {
        const control = agentRunControl({ name: 'moic', running: false });
        expect(control.action).toBe('start');
        expect(control.label).toBe('Start moic');
    });
});

describe('the manager gets a Driver tab', () => {
    const state = (over: Record<string, unknown> = {}): AgentManagerState =>
        ({
            ok: true,
            agent: {
                id: 'a1',
                workspaceId: 'ws',
                name: 'moic',
                purpose: 'p',
                avatar: null,
                role: 'specialized',
                tui: 'claude',
                running: true,
                isSidecar: false,
                terminalSpecId: 't1',
                allowedTuis: [],
                runtimes: [runtime('claude', true)],
                ...over,
            },
            persona: null,
            mcp: null,
            sidecar: null,
        }) as unknown as AgentManagerState;

    it('sits beside identity, prompt, MCP and sidecar', () => {
        expect(agentManagerTabs(state()).map((t) => t.id)).toEqual([
            'identity',
            'driver',
            'prompt',
            'mcp',
            'sidecar',
        ]);
    });

    it('POSITIVE CONTROL: a sidecar still loses only the sidecar tab', () => {
        expect(agentManagerTabs(state({ isSidecar: true })).map((t) => t.id)).toEqual([
            'identity',
            'driver',
            'prompt',
            'mcp',
        ]);
    });
});
