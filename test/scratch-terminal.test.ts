import { describe, expect, it } from 'vitest';
import { OS_WORKSPACE } from '../src/main/registry.js';
import { openScratchTerminal } from '../src/main/scratch-terminal.js';
import { trayMenuTemplate } from '../src/main/tray.js';

/**
 * THE TRAY'S NEW SCRATCH TERMINAL (Tynn #761, Genie 1's tray; the owner, 2026-10-19: in "Genie's own" workspace). A
 * shell in the person's home folder, in a window of its own, filed under Genie's workspace — not a project's, so it never
 * shows up among a project's terminals and needs no project open.
 */
const handlers = { onOpen: () => {}, onSettings: () => {}, onCheckUpdates: () => {}, onQuit: () => {} };

describe('the tray item', () => {
    it('New scratch terminal, right after Open Genie, and clicking it opens one', () => {
        let opened = 0;
        const menu = trayMenuTemplate({ ...handlers, onScratchTerminal: () => { opened += 1; } });
        const labels = menu.map((i) => i.label);
        expect(labels.indexOf('New scratch terminal')).toBe(labels.indexOf('Open Genie') + 1);
        menu.find((i) => i.label === 'New scratch terminal')!.click!();
        expect(opened).toBe(1);
    });

    it('CONTROL: without a handler there is no item that would do nothing', () => {
        expect(trayMenuTemplate(handlers).some((i) => i.label === 'New scratch terminal')).toBe(false);
    });
});

describe('opening one', () => {
    it('a shell in the home folder, in Genie’s own workspace, in a window of its own (COUNTED: one terminal, one window)', () => {
        const opened: Array<{ workspaceId: string; cwd: string; command?: string | undefined }> = [];
        const windows: string[] = [];
        const result = openScratchTerminal({
            terminals: { open: (o: { workspaceId: string; cwd: string; command?: string }) => { opened.push(o); return { id: 'pty_7', pid: 1, shell: 'bash' }; } } as never,
            openWindow: (route) => windows.push(route),
            home: '/home/example',
        });
        expect(result).toEqual({ ok: true, terminalId: 'pty_7' });
        expect(opened).toEqual([{ workspaceId: OS_WORKSPACE, cwd: '/home/example' }]);
        expect(windows).toEqual(['genie://takeover/pty_7']);
    });

    it('a terminal that cannot start says why, and opens no window', () => {
        const windows: string[] = [];
        const result = openScratchTerminal({
            terminals: { open: () => { throw new Error('no shell'); } } as never,
            openWindow: (route) => windows.push(route),
            home: '/home/example',
        });
        expect(result).toEqual({ ok: false, reason: 'The scratch terminal could not start: no shell' });
        expect(windows).toEqual([]);
    });
});
