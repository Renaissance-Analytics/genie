import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OS_WORKSPACE } from '../src/main/registry.js';
import { isGenieOwnScratch, scratchTerminalFor } from '../src/main/scratch-terminal.js';

/*
 * GENIE'S OWN SCRATCH TERMINAL HAS A HOME IN THE CLIENT (Tynn #1058 L5). It was the client tray's "New scratch terminal"
 * (Tynn #761: a shell in the home folder, in Genie's own workspace); the client has no tray since L5. The genie row's
 * terminal button in the rail asks for it by Genie's own workspace's id, and gets the same home-folder shell. It stays the
 * host owner's: a guest asking by that id is refused as a guest asking by null was.
 */
function ports() {
    const opened: { workspaceId: string; cwd: string }[] = [];
    return {
        opened,
        p: {
            scratch: { open: (where: { workspaceId: string; cwd: string }) => { opened.push({ workspaceId: where.workspaceId, cwd: where.cwd }); return { ok: true as const, terminalId: `t${opened.length}` }; } },
            home: '/home/person',
            workspace: (id: string) => (id === 'ws1' ? { id: 'ws1', path: '/work/ws1' } : null),
            envFor: () => ({}),
        },
    };
}

describe('Genie’s own scratch terminal', () => {
    it('by Genie’s own workspace’s id (the genie row’s button): the home folder, in Genie’s own workspace, as null always was', () => {
        const { p, opened } = ports();
        expect(scratchTerminalFor(p, OS_WORKSPACE)).toEqual({ ok: true, terminalId: 't1', route: 'genie://takeover/t1' });
        expect(scratchTerminalFor(p, null)).toEqual({ ok: true, terminalId: 't2', route: 'genie://takeover/t2' });
        expect(opened).toEqual([{ workspaceId: OS_WORKSPACE, cwd: '/home/person' }, { workspaceId: OS_WORKSPACE, cwd: '/home/person' }]);
    });

    it('CONTROL: a workspace’s own id opens in its folder; an unknown one is refused in words', () => {
        const { p, opened } = ports();
        expect(scratchTerminalFor(p, 'ws1')).toMatchObject({ ok: true });
        expect(opened).toEqual([{ workspaceId: 'ws1', cwd: '/work/ws1' }]);
        expect(scratchTerminalFor(p, 'nope')).toEqual({ ok: false, reason: 'That workspace is not open in Genie.' });
        expect(isGenieOwnScratch('ws1')).toBe(false);
        expect(isGenieOwnScratch(OS_WORKSPACE)).toBe(true);
        expect(isGenieOwnScratch(null)).toBe(true);
    });

    it('stays the host owner’s: the remote refusal covers Genie’s own id too, not only null', () => {
        const src = readFileSync('src/main/remote-host.ts', 'utf8');
        expect(src).toMatch(/if \(!auth\.isOwner && method === 'terminals\.scratch' && isGenieOwnScratch\(typeof args\[0\] === 'string' \? args\[0\] : null\)\) return refuse\(/);
    });

    it('the Dashboard’s genie row opens it (its window menu: the terminal, no Files); a scoped window’s does not', () => {
        const dash = readFileSync('src/renderer/components/Dashboard.tsx', 'utf8');
        expect(dash).toMatch(/const opensWindows = \(row: AgentRow\) => windowEntriesFor\(row\.workspaceId, scopeWorkspaceId\)\.length > 0 && \(!isGenieRow\(row\) \|\| onOpenTerminalWindow !== undefined\);/);
        expect(dash).toMatch(/const terminalOpenerFor = \(row: AgentRow\) => opensWindows\(row\) && onOpenTerminalWindow \? \(\) => onOpenTerminalWindow\(row\.workspaceId\) : undefined;/);
        expect(dash).toMatch(/onFiles: !isGenieRow\(row\) && onOpenFilesWindow \?/);
    });
});
