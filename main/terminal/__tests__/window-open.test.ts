import { describe, expect, it } from 'vitest';
import { openTerminalWindow, type WindowOpenPorts } from '../window-open';

/**
 * Opening a terminal window FOR REAL — the half of Tynn #447 that was still missing.
 *
 * `window-plan.ts` decided what a window should be; nothing called it. This is the bridge
 * from that decision to a registered spec and an open window, and it is the piece that
 * makes "every workspace can open a terminal or start an agent in TUI mode" true rather
 * than planned.
 *
 * The ports are injected because the real ones are `createTerminalSpec`,
 * `createSpecializedAgentTerminal` and a `BrowserWindow` — none of which can be exercised
 * in a unit test, and all of which already work. What needs testing is the ORDER and the
 * refusals: a window must never open before its spec exists, because the renderer attaches
 * by spec id and would find nothing.
 */

const ports = (over: Partial<WindowOpenPorts> = {}) => {
    const calls: string[] = [];
    const opened: Array<{ route: string; title: string }> = [];
    const base: WindowOpenPorts = {
        createTerminal: (o) => {
            calls.push(`createTerminal:${o.workspaceId}:${o.cwd ?? '-'}`);
            return { ok: true, specId: 'spec-term' };
        },
        createAgent: (o) => {
            calls.push(`createAgent:${o.workspaceId}:${o.agent}`);
            return { ok: true, specId: 'spec-agent' };
        },
        openWindow: (route, title) => {
            calls.push(`openWindow:${route}`);
            opened.push({ route, title });
        },
        workspaceName: () => 'tynn',
        ...over,
    };
    return { ports: base, calls, opened };
};

describe('a plain terminal window', () => {
    it('creates the spec, then opens a window addressed to it', () => {
        const { ports: p, calls, opened } = ports();
        const r = openTerminalWindow({ kind: 'terminal', workspaceId: 'ws1' }, p);

        expect(r).toEqual({ ok: true, specId: 'spec-term' });
        // ORDER IS THE ASSERTION. A window opened first would attach to a spec that does
        // not exist yet and render an empty panel with no way to recover.
        expect(calls).toEqual(['createTerminal:ws1:-', 'openWindow:?spec=spec-term&ws=ws1']);
        // The spec id is what makes the window ATTACH; `ws` only saves a lookup.
        expect(opened[0]!.route).toContain('spec=spec-term');
    });

    it('names the window after the workspace, so several are tellable apart', () => {
        const { ports: p, opened } = ports();
        openTerminalWindow({ kind: 'terminal', workspaceId: 'ws1' }, p);
        expect(opened[0]!.title).toContain('tynn');
    });

    it('passes a requested cwd through', () => {
        const { ports: p, calls } = ports();
        openTerminalWindow({ kind: 'terminal', workspaceId: 'ws1', cwd: '/repo/sub' }, p);
        expect(calls[0]).toBe('createTerminal:ws1:/repo/sub');
    });
});

describe('an agent in TUI mode', () => {
    it('goes through the AGENT spec path, so it has an identity', () => {
        const { ports: p, calls } = ports();
        const r = openTerminalWindow({ kind: 'agent', workspaceId: 'ws1', agent: 'claude' }, p);
        expect(r).toEqual({ ok: true, specId: 'spec-agent' });
        expect(calls).toEqual(['createAgent:ws1:claude', 'openWindow:?spec=spec-agent&ws=ws1']);
    });

    it('never creates a plain terminal for an agent', () => {
        // A plain spec with a command typed into it is the bug this whole change exists to
        // avoid: no meta.agent, so no AgentInbox identity, no roster entry, no revival.
        const { ports: p, calls } = ports();
        openTerminalWindow({ kind: 'agent', workspaceId: 'ws1', agent: 'codex' }, p);
        expect(calls.some((c) => c.startsWith('createTerminal'))).toBe(false);
    });
});

describe('refusals — nothing half-opens', () => {
    it('refuses with no workspace, and opens NOTHING', () => {
        const { ports: p, calls } = ports();
        const r = openTerminalWindow({ kind: 'terminal', workspaceId: '' }, p);
        expect(r).toMatchObject({ ok: false, reason: 'no-workspace' });
        expect(calls).toEqual([]);
    });

    it('does NOT open a window when spec creation fails', () => {
        // The failure that matters most. An empty window with no spec behind it looks like
        // Genie broke, and the real error — "no command configured for that agent" — would
        // never reach anyone.
        const { ports: p, calls } = ports({
            createAgent: () => ({ ok: false, error: 'No command configured for agent "custom".' }),
        });
        const r = openTerminalWindow({ kind: 'agent', workspaceId: 'ws1', agent: 'custom' }, p);
        expect(r).toMatchObject({ ok: false, reason: 'create-failed' });
        expect(calls.some((c) => c.startsWith('openWindow'))).toBe(false);
    });

    it('carries the underlying error forward verbatim', () => {
        const { ports: p } = ports({ createAgent: () => ({ ok: false, error: 'Workspace not found.' }) });
        const r = openTerminalWindow({ kind: 'agent', workspaceId: 'ws1', agent: 'claude' }, p);
        expect(r).toMatchObject({ ok: false, error: 'Workspace not found.' });
    });
});
