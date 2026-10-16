import { describe, expect, it } from 'vitest';
import { visiblePanes } from '../src/core/panel-layout.js';
import { activate, codeClosed, codeOpened, emptyWorkspace, terminalOpened, type TerminalTab } from '../src/core/workspace-view.js';

/**
 * PANEL KINDS BEYOND THE TERMINAL (§4.6 `+code`, §6.5). A code pane is one file open in the workspace's
 * grid, beside the shells — the same strip, the same active pane, the same layout cap. Its id is the
 * file's path under a prefix, so opening the same file twice is one pane; closing it is just closing it
 * (the file stays on disk, the shells stay running).
 */

const tab = (id: string): TerminalTab => ({ id, workspaceId: 'tynn', shell: 'sh', pid: 1, exited: null });

describe('code panes in the workspace state', () => {
    it('codeOpened adds ONE pane per path and activates it; codeClosed removes it and falls back to a terminal', () => {
        let s = terminalOpened(emptyWorkspace(), tab('t1'), '');
        s = codeOpened(s, 'src/a.ts');
        expect(s.codes).toEqual([{ id: 'code:src/a.ts', path: 'src/a.ts' }]);
        expect(s.active).toBe('code:src/a.ts');
        s = codeOpened(s, 'src/a.ts');
        expect(s.codes).toHaveLength(1);
        s = codeOpened(s, 'README.md');
        expect(s.codes?.map((c) => c.id)).toEqual(['code:src/a.ts', 'code:README.md']);
        expect(s.active).toBe('code:README.md');
        s = codeClosed(s, 'code:README.md');
        expect(s.codes?.map((c) => c.id)).toEqual(['code:src/a.ts']);
        expect(s.active).toBe('code:src/a.ts');
        s = codeClosed(s, 'code:src/a.ts');
        expect(s.codes).toEqual([]);
        expect(s.active).toBe('t1');
        // Closing a pane that is not there changes nothing.
        expect(codeClosed(s, 'code:nope')).toEqual(s);
    });

    it('activate reaches a code pane like a terminal', () => {
        let s = terminalOpened(emptyWorkspace(), tab('t1'), '');
        s = codeOpened(s, 'src/a.ts');
        s = activate(s, 't1');
        expect(s.active).toBe('t1');
        s = activate(s, 'code:src/a.ts');
        expect(s.active).toBe('code:src/a.ts');
    });

    it('an empty workspace has no code panes', () => {
        expect(emptyWorkspace().codes ?? []).toEqual([]);
    });
});

describe('visiblePanes with code panes', () => {
    it('counts code panes against the layout cap, in strip order (terminals, then code), the active one always included', () => {
        let s = terminalOpened(emptyWorkspace(), tab('t1'), '');
        s = terminalOpened(s, tab('t2'), '');
        s = codeOpened(s, 'src/a.ts');
        expect(visiblePanes(s, 'single')).toEqual(['code:src/a.ts']);
        expect(visiblePanes(s, 'columns')).toEqual(['t1', 'code:src/a.ts']);
        expect(visiblePanes(activate(s, 't2'), 'columns')).toEqual(['t1', 't2']);
        expect(visiblePanes(s, 'grid')).toEqual(['t1', 't2', 'code:src/a.ts']);
    });
});
