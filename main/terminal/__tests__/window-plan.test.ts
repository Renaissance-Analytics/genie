import { describe, expect, it } from 'vitest';
import { planTerminalWindow, closePolicyFor } from '../window-plan';

/**
 * What a "new terminal window" actually opens — Tynn #447.
 *
 * Owner direction: every workspace can open a terminal, or start an agent in TUI mode,
 * and it opens as its OWN WINDOW so TheFloor stays clean under the Genie 2 UX.
 *
 * The trap this module exists to close: `renderer/pages/terminal.tsx` today renders
 * `<Terminal cwd={home} />` — a bare pty with NO `terminal_specs` row. A terminal with no
 * spec has no `GENIE_TERMINAL_ID`, no per-terminal MCP token, no AgentInbox identity, no
 * roster entry, no cap accounting and no revival. So it can host a shell and can NEVER
 * host an agent. Every assertion below is about refusing to open that kind of window.
 */

describe('a plain terminal window', () => {
    it('is spec-backed, so it has an identity like any other terminal', () => {
        const plan = planTerminalWindow({ kind: 'terminal', workspaceId: 'ws1' });
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        // The whole point: it goes through spec creation, not a bare pty. `create` is
        // nullable now because a take-over window creates nothing; this kind always does.
        expect(plan.create).not.toBeNull();
        if (!plan.create) return;
        expect(plan.create.kind).toBe('terminal');
        expect(plan.create.workspaceId).toBe('ws1');
    });

    it('REFUSES a request with no workspace', () => {
        // A window with no workspace has no cwd to root in and no workspace to belong to.
        // Falling back to $HOME is what the diagnostic page does, and it is why that page
        // cannot be the product surface.
        const plan = planTerminalWindow({ kind: 'terminal', workspaceId: '' });
        expect(plan.ok).toBe(false);
        if (plan.ok) return;
        expect(plan.reason).toBe('no-workspace');
    });
});

describe('an agent in TUI mode', () => {
    it('routes through the AGENT spec path, never a plain terminal', () => {
        // createSpecializedAgentTerminal is what sets meta.agent and mints the identity.
        // Creating a plain spec and typing a command into it is the bug, not the feature.
        const plan = planTerminalWindow({ kind: 'agent', workspaceId: 'ws1', agent: 'claude' });
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        expect(plan.create).not.toBeNull();
        if (!plan.create) return;
        expect(plan.create.kind).toBe('agent');
        if (plan.create.kind !== 'agent') return;
        expect(plan.create.agent).toBe('claude');
    });

    it('refuses an agent with no workspace, for the same reason', () => {
        const plan = planTerminalWindow({ kind: 'agent', workspaceId: '', agent: 'claude' });
        expect(plan.ok).toBe(false);
    });
});

describe('the window route', () => {
    it('carries the spec id, so the window ATTACHES instead of opening a second pty', () => {
        // If the route carried only a workspace, the renderer would have to create its own
        // terminal — two ptys for one window, and the agent would be in whichever one the
        // race favoured.
        const plan = planTerminalWindow({ kind: 'terminal', workspaceId: 'ws1' });
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        expect(plan.routeFor('spec-abc')).toBe('?spec=spec-abc');
        // cwd and ws ride along so the window can attach without a round trip, and a
        // Windows path must survive the trip -- backslashes and spaces and all.
        const windowsPath = ['C:', 'a b', 'c'].join(String.fromCharCode(92));
        expect(plan.routeFor('s1', { cwd: windowsPath, workspaceId: 'ws1' })).toBe(
            '?spec=s1&cwd=C%3A%5Ca%20b%5Cc&ws=ws1',
        );
    });
});

describe('closing the window', () => {
    it('DETACHES an agent rather than killing it', () => {
        // "Demote the terminal, do not delete it": the pty stays live so take-over is
        // instant. Closing a view must not end the agent's work.
        expect(closePolicyFor('agent')).toBe('detach');
    });

    it('ends a plain shell, which has nothing to outlive its window', () => {
        expect(closePolicyFor('terminal')).toBe('kill');
    });
});

/**
 * TAKING OVER AN AGENT THAT ALREADY EXISTS.
 *
 * Owner's ruling, 2026-10-08: a provider TUI opens in its OWN WINDOW, never on the Floor.
 * For an agent already running, that window must ATTACH to the pty it already has.
 *
 * The hazard this guards is specific and expensive: the only window-opening path that
 * existed created a spec every time, so wiring "Take over" to it would have started a
 * SECOND agent — same workspace, same provider, a fresh conversation — while the one you
 * meant to reach kept running unattended. That is strictly worse than the dead button it
 * would have replaced, because it looks like it worked.
 */
describe('a window onto an agent that is ALREADY running', () => {
    it('creates nothing — the spec is the one that exists', () => {
        const plan = planTerminalWindow({ kind: 'existing', workspaceId: 'ws1', specId: 's9' });
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        expect(plan.create).toBeNull();
    });

    it('addresses the window at the EXISTING spec, carrying cwd and workspace', () => {
        const plan = planTerminalWindow({
            kind: 'existing',
            workspaceId: 'ws1',
            specId: 's9',
            cwd: '/repo',
        });
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        expect(plan.routeFor('s9', { cwd: '/repo', workspaceId: 'ws1' })).toBe(
            '?spec=s9&cwd=%2Frepo&ws=ws1',
        );
    });

    it('still refuses without a workspace, like every other kind', () => {
        const plan = planTerminalWindow({ kind: 'existing', workspaceId: '', specId: 's9' });
        expect(plan.ok).toBe(false);
    });

    it('DETACHES on close — it is a live pty with work in it', () => {
        // The one policy that must never be `kill` here: closing a window onto a running
        // agent would end the work, which is the opposite of taking over.
        expect(closePolicyFor('existing')).toBe('detach');
    });
});
