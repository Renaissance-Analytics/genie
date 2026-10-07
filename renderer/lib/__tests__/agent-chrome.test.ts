import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentChromeControls, agentChromeMenu, agentTerminalSurface } from '../agent-chrome';
import type { AgentSpecLike } from '../../../main/agents/restart-options';

/**
 * ONE set of agent chrome, rendered by BOTH the grid tile and the Agent view header.
 *
 * Owner decision 2026-10-07, answering whether to delete `AgentPanel`: *"share the chrome
 * between both surfaces — note: we need terminal support but we don't need the TUI agent
 * support like we have it now. We do want to keep enough support that lets users open their
 * agent in a TUI terminal if needed but that is not the main ux."*
 *
 * So this is deliberately LEANER than `AgentPanel` was:
 *
 *  - **No driver switcher.** `AgentTuiSwitcher` sat in the panel header AND in Agent
 *    settings → Driver. The manager's own note says the picker *"moved here rather than
 *    being duplicated — this is the one place in the manager that answers 'what is this
 *    agent running under, and is it running'"*, and that tab is the one built on
 *    `decideTuiSwitch`, so it never offers a switch the host would refuse (genie#463).
 *    Dropping the header copy removes a duplicate, not a capability.
 *  - **Terminal access is kept**, which is the "if needed" half: the Agent view has a
 *    `terminal` tab, and a grid tile IS the pty. Neither needs a control here.
 *  - **Restart stays** (genie#443) — agent lifecycle, not TUI apparatus.
 *  - **Settings stays**, and is now the single route to driver and sidecar control.
 *
 * The decisions live here rather than in the `.tsx` for the reason `agent-manager.ts`
 * already states: the renderer has no DOM harness, so a decision left inline in a component
 * is a decision nobody can assert on.
 */

const spec = (meta: AgentSpecLike['meta']): AgentSpecLike => ({ meta });

/**
 * An agent whose conversation Genie captured — resume is real.
 *
 * `meta.chat_session_id`, which is where `capturedSessionId` looks first: it is the live
 * record, updated when a session is detected or re-captured.
 */
const resumable = spec({ agent: 'claude', chat_session_id: '3f2b9c10-0000-4000-8000-abcdef123456' });
/**
 * The same thing recorded ONLY in the stored launch command (genie#364).
 *
 * Covered because it is a different code path and the one that is easy to lose: an id minted
 * by `renderAgentLaunch` can live solely in `--session-id`, and a restart that misses it
 * replays a create that can only ever succeed once.
 */
const resumableViaCommand = spec({
    agent: 'claude',
    agent_command: 'claude --session-id 3f2b9c10-0000-4000-8000-abcdef123456',
});
/** An agent Genie has no session id for — fresh is the only honest offer. */
const freshOnly = spec({ agent: 'aider' });
/** Not an agent at all: an ordinary terminal. */
const plainTerminal = spec({});

describe('agentTerminalSurface', () => {
    it('is `agent` for an agent spec, which is what strips the shell switcher', () => {
        // THE safety property, and it lives in TerminalPanel:
        //   shells={surface === 'agent' ? [] : shellOptions}
        // An agent panel offers NO shells, so the switcher cannot quietly turn a saved
        // agent into an ordinary terminal. `AgentPanel` used to guarantee this by always
        // passing `surface="agent"`; with it gone, each caller must, and this is the
        // decision they share rather than each remembering a prop.
        expect(agentTerminalSurface(resumable)).toBe('agent');
        expect(agentTerminalSurface(freshOnly)).toBe('agent');
    });

    it('is `terminal` for a spec with no agent, which keeps its shells', () => {
        // The inverse matters as much: a plain terminal losing its shell switcher would be
        // a silent feature removal, and "no shells anywhere" would pass a test that only
        // checked the agent case.
        expect(agentTerminalSurface(plainTerminal)).toBe('terminal');
    });
});

describe('agentChromeControls', () => {
    it('offers resume as the primary restart when there is a conversation to keep', () => {
        // The control is never the button that only ever refuses — the defect genie#443
        // fixed for every provider with no resume grammar.
        const controls = agentChromeControls({ spec: resumable, onRestart: true, onSettings: true });
        const restart = controls.find((c) => c.kind === 'restart');
        expect(restart).toMatchObject({ kind: 'restart', mode: 'resume' });
        expect(restart?.title).toMatch(/resume the conversation/i);
    });

    it('treats an id recorded only in the launch command as resumable too (genie#364)', () => {
        const restart = agentChromeControls({
            spec: resumableViaCommand,
            onRestart: true,
            onSettings: true,
        }).find((c) => c.kind === 'restart');
        expect(restart).toMatchObject({ mode: 'resume' });
    });

    it('offers fresh as the primary restart when nothing can be carried across', () => {
        const controls = agentChromeControls({ spec: freshOnly, onRestart: true, onSettings: true });
        const restart = controls.find((c) => c.kind === 'restart');
        expect(restart).toMatchObject({ kind: 'restart', mode: 'fresh' });
        // Says so, rather than implying a resume it cannot perform.
        expect(restart?.title).toMatch(/fresh/i);
    });

    it('offers no restart for something that is not an agent', () => {
        expect(agentChromeControls({ spec: plainTerminal, onRestart: true, onSettings: true })).toEqual([]);
    });

    it('offers no restart when the caller supplied no handler', () => {
        // A control whose handler is absent is a dead control — the same reason the command
        // palette drops undeliverable rows instead of showing them greyed.
        const controls = agentChromeControls({ spec: resumable, onRestart: false, onSettings: true });
        expect(controls.some((c) => c.kind === 'restart')).toBe(false);
    });

    it('NEVER offers a driver switcher — that is Agent settings → Driver', () => {
        // The reduction the owner asked for. If this ever comes back, it is a duplicate of
        // the one control built on `decideTuiSwitch`, and the duplicate is the one that can
        // offer a switch the host would refuse.
        for (const s of [resumable, freshOnly]) {
            const kinds = agentChromeControls({ spec: s, onRestart: true, onSettings: true }).map((c) => c.kind);
            expect(kinds).not.toContain('tui-switcher');
            expect(kinds).not.toContain('driver');
        }
    });

    it('passes a screen switch through when the surface supplies one', () => {
        // Grid-tile navigation between an agent and its `<name>-slave` screen. The Agent
        // view reaches the sidecar by route instead, so it supplies none — which is why
        // this is an input rather than something derived from the spec.
        const controls = agentChromeControls({
            spec: resumable,
            onRestart: true,
            onSettings: true,
            screenSwitch: { label: 'View moic sidecar screen', name: 'moic-slave', target: 'sidecar', busy: false },
        });
        expect(controls.find((c) => c.kind === 'screen-switch')).toMatchObject({
            name: 'moic-slave',
            target: 'sidecar',
        });
    });

    it('puts the screen switch BEFORE restart, so a busy control never moves under the cursor', () => {
        const controls = agentChromeControls({
            spec: resumable,
            onRestart: true,
            onSettings: true,
            screenSwitch: { label: 'x', name: 'n', target: 'sidecar', busy: false },
        });
        expect(controls.map((c) => c.kind)).toEqual(['screen-switch', 'restart']);
    });
});

describe('agentChromeMenu', () => {
    it('offers settings and BOTH restart modes when both are real', () => {
        // The header button takes the mode that preserves the most; the menu is where the
        // other one is reachable without guessing.
        const items = agentChromeMenu({ spec: resumable, onRestart: true, onSettings: true });
        expect(items.map((i) => i.kind)).toEqual(['settings', 'restart-resume', 'restart-fresh']);
    });

    it('omits resume when there is no conversation to resume', () => {
        const items = agentChromeMenu({ spec: freshOnly, onRestart: true, onSettings: true });
        expect(items.map((i) => i.kind)).toEqual(['settings', 'restart-fresh']);
    });

    it('offers settings alone for a non-agent, never a restart', () => {
        const items = agentChromeMenu({ spec: plainTerminal, onRestart: true, onSettings: true });
        expect(items.map((i) => i.kind)).toEqual(['settings']);
    });

    it('is empty when the surface wired no handlers, so no menu is opened at all', () => {
        expect(agentChromeMenu({ spec: resumable, onRestart: false, onSettings: false })).toEqual([]);
    });

    it('says what a fresh restart COSTS when there is a conversation to lose', () => {
        // `losesConversation` is true only when Genie actually holds a session id. Warning
        // when there is nothing to lose would train people to ignore the warning.
        const items = agentChromeMenu({ spec: resumable, onRestart: true, onSettings: true });
        const fresh = items.find((i) => i.kind === 'restart-fresh');
        expect(fresh?.label).toMatch(/fresh/i);
        expect(fresh?.warns).toBe(true);

        const plain = agentChromeMenu({ spec: freshOnly, onRestart: true, onSettings: true });
        expect(plain.find((i) => i.kind === 'restart-fresh')?.warns).toBe(false);
    });
});

/**
 * BOTH surfaces must render the shared chrome, and neither may grow its own.
 *
 * The whole reason `AgentPanel` was proposed for deletion is that it was the ONLY place
 * this chrome existed, so the Agent view had none of it — restart and agent settings were
 * reachable from a grid tile and nowhere else. Sharing it is only worth anything if it
 * stays shared: a component that quietly re-implements a restart button puts the two
 * surfaces back out of step, and the drift is invisible because both still "have restart".
 *
 * Source-level, because the renderer has no DOM harness. Comments are stripped first so
 * this file's own prose about `AgentTuiSwitcher` cannot satisfy or trip it — the mistake
 * genie#517 is made of.
 */
describe('both agent surfaces render the shared chrome', () => {
    const root = path.resolve(__dirname, '../..');
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
    const code = (src: string) =>
        src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const GRID = 'components/Master/AgentTerminal.tsx';
    const VIEW = 'components/Master/AgentView.tsx';

    it('positive control: both files exist and were really read', () => {
        expect(read(GRID).length).toBeGreaterThan(500);
        expect(read(VIEW).length).toBeGreaterThan(2_000);
    });

    it.each([GRID, VIEW])('%s renders AgentHeaderActions from the shared module', (file) => {
        const src = code(read(file));
        expect(src).toMatch(/<AgentHeaderActions\b/);
        expect(src).toMatch(/from '\.\/AgentChrome'|from '\.\.\/Master\/AgentChrome'/);
    });

    it.each([GRID, VIEW])('%s offers the shared context menu', (file) => {
        const src = code(read(file));
        expect(src).toMatch(/<AgentChromeMenu\b/);
        expect(src).toMatch(/useAgentChromeMenu\(\)/);
    });

    it.each([GRID, VIEW])('%s does NOT hand-roll a restart control', (file) => {
        // A second restart button is how the surfaces drift: both would look complete while
        // disagreeing about which mode is primary, which is genie#443's whole defect.
        const src = code(read(file));
        expect(src).not.toMatch(/restartOptionsFor\s*\(/);
        expect(src).not.toMatch(/Restart agent \(/);
    });

    it.each([GRID, VIEW])('%s does NOT reintroduce the driver switcher', (file) => {
        // The reduction the owner asked for. Agent settings → Driver is the one control
        // built on `decideTuiSwitch`; a header copy can offer a switch the host refuses.
        expect(code(read(file))).not.toMatch(/AgentTuiSwitcher/);
    });

    it('AgentTerminal derives the terminal surface rather than hard-coding it', () => {
        // `surface="agent"` is the safety property (TerminalPanel renders no shells for it).
        // Hard-coding it would silently strip a NON-agent spec's shells, so it is derived —
        // and `agentTerminalSurface` is the one place that decides.
        const src = code(read(GRID));
        expect(src).toMatch(/surface=\{agentTerminalSurface\(/);
        expect(src).not.toMatch(/surface="agent"/);
    });
});
