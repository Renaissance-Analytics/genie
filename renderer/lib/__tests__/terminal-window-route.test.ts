import { describe, expect, it } from 'vitest';
import { parseTerminalWindowRoute } from '../terminal-window-route';

/**
 * What a standalone terminal window is showing — Tynn #447.
 *
 * Two shapes, and keeping them apart is the point. `?spec=<id>` means ATTACH to an existing
 * spec, which is how a window hosts a real agent: the spec carries the identity
 * (`GENIE_TERMINAL_ID`, the MCP token, AgentInbox, the roster entry, revival). No query at
 * all is the tray's long-standing SCRATCH terminal — a bare pty at home, no workspace, no
 * identity — which is fine for a shell and can never host an agent.
 *
 * Conflating them is the bug this parser exists to prevent: minting a fresh pty for a
 * window that was supposed to attach would leave the agent in the terminal nobody is
 * looking at.
 */

describe('attaching to a spec', () => {
    it('reads the spec id', () => {
        const v = parseTerminalWindowRoute({ spec: 's1' });
        expect(v).toMatchObject({ kind: 'spec', specId: 's1' });
    });

    it('reads the cwd and workspace that rode along', () => {
        const v = parseTerminalWindowRoute({ spec: 's1', cwd: '/repo/sub', ws: 'ws1' });
        expect(v).toMatchObject({ kind: 'spec', cwd: '/repo/sub', workspaceId: 'ws1' });
    });

    it('still attaches when cwd and ws are absent — the SPEC is what matters', () => {
        // They are a shortcut, not a requirement. Refusing to attach without them would
        // turn a missing convenience into a broken window.
        const v = parseTerminalWindowRoute({ spec: 's1' });
        expect(v).toMatchObject({ kind: 'spec', cwd: null, workspaceId: null });
    });

    it('takes the first value when a param repeats', () => {
        // `?spec=a&spec=b` is malformed. Picking one beats refusing, and first is the one
        // the opener wrote.
        expect(parseTerminalWindowRoute({ spec: ['s1', 's2'] })).toMatchObject({ specId: 's1' });
    });
});

describe('the scratch terminal', () => {
    it('is what an empty query means', () => {
        expect(parseTerminalWindowRoute({})).toEqual({ kind: 'scratch' });
    });

    it('is what a BLANK spec means, rather than attaching to nothing', () => {
        // `?spec=` would otherwise produce a spec view with an empty id, and the window
        // would try to attach to a terminal that cannot exist.
        expect(parseTerminalWindowRoute({ spec: '' })).toEqual({ kind: 'scratch' });
        expect(parseTerminalWindowRoute({ spec: '   ' })).toEqual({ kind: 'scratch' });
    });

    it('ignores a cwd with no spec, rather than opening a shell somewhere unasked', () => {
        // A cwd alone is not an instruction to open there: nothing registered it, so there
        // is no spec to own it. Honouring it would start a pty in a directory no spec names.
        expect(parseTerminalWindowRoute({ cwd: '/etc' })).toEqual({ kind: 'scratch' });
    });
});
