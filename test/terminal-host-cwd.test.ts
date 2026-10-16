import { describe, expect, it } from 'vitest';
import { TerminalHost, type PtyPort } from '../src/main/terminal-host.js';

/**
 * CWD RESUME (§6.5) — the engine reports each shell's working directory (OSC-7); the host keeps it
 * per terminal and answers the workspace's LAST one, so a new terminal opens where the previous
 * left off. Without a report the answer is `null` — the caller falls back to the workspace folder;
 * Genie never guesses a directory.
 */

function pty() {
    let cwdListener: ((id: string, cwd: string) => void) | null = null;
    let n = 0;
    const port: PtyPort = {
        open: (o) => ({ id: `pty_${++n}`, pid: n, shell: o.command ?? '/bin/sh', scrollback: '' }),
        write: () => true,
        resize: () => true,
        kill: () => true,
        scrollback: () => '',
        onData: () => () => {},
        onExit: () => () => {},
        onCwd: (l) => { cwdListener = l; return () => { cwdListener = null; }; },
    };
    return { port, cwd: (id: string, path: string) => cwdListener?.(id, path) };
}

describe('cwd tracking', () => {
    it('records what the engine reports, per terminal, and lastCwd answers the workspace’s newest; nothing reported → null', () => {
        const f = pty();
        const host = new TerminalHost(f.port);
        const a = host.open({ workspaceId: 'tynn', cwd: '/w/tynn' });
        const b = host.open({ workspaceId: 'tynn', cwd: '/w/tynn' });
        host.open({ workspaceId: 'fancy', cwd: '/w/fancy' });
        expect(host.lastCwd('tynn')).toBeNull();
        f.cwd(a.id, '/w/tynn/repos/genie2');
        expect(host.list().find((t) => t.id === a.id)?.cwd).toBe('/w/tynn/repos/genie2');
        expect(host.lastCwd('tynn')).toBe('/w/tynn/repos/genie2');
        f.cwd(b.id, '/w/tynn/.ai');
        expect(host.lastCwd('tynn')).toBe('/w/tynn/.ai');
        expect(host.lastCwd('fancy')).toBeNull();
        // A report for a terminal Genie does not know is ignored, not a throw.
        f.cwd('pty_99', '/elsewhere');
        expect(host.lastCwd('tynn')).toBe('/w/tynn/.ai');
    });

    it('a closed terminal no longer counts for lastCwd', () => {
        const f = pty();
        const host = new TerminalHost(f.port);
        const a = host.open({ workspaceId: 'tynn', cwd: '/w/tynn' });
        f.cwd(a.id, '/w/tynn/x');
        host.close(a.id);
        expect(host.lastCwd('tynn')).toBeNull();
    });

    it('an engine without a cwd event is fine: nothing is tracked and lastCwd is null', () => {
        const { port } = pty();
        const { onCwd: _ignored, ...withoutCwd } = port;
        const host = new TerminalHost(withoutCwd as PtyPort);
        host.open({ workspaceId: 'tynn', cwd: '/w/tynn' });
        expect(host.lastCwd('tynn')).toBeNull();
    });
});
