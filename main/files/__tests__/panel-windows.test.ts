import { describe, expect, it } from 'vitest';
import { FilePanelWindows } from '../panel-windows';

function fixture() {
    const events: string[] = [];
    const closed: Array<() => void> = [];
    const windows = new FilePanelWindows({
        open: (id: string) => {
            events.push(`open:${id}`);
            return {
                focus: () => events.push(`focus:${id}`),
                close: () => closed.forEach((listener) => listener()),
                onClosed: (listener: () => void) => closed.push(listener),
            };
        },
        changed: () => events.push('changed'),
    });
    return { windows, events, closed };
}

describe('one popped file panel per workspace', () => {
    it('queues file-open requests until the popped CodePanel is listening', () => {
        const delivered: string[] = [];
        const windows = new FilePanelWindows({
            open: () => ({ id: 7, focus: () => {}, close: () => {}, onClosed: () => {}, sendOpenFile: (request) => { delivered.push(request.relPath); } }),
            changed: () => {},
        });
        windows.pop('workspace', 'files');
        expect(windows.routeOpenFile({ requestId: 'request', workspaceId: 'workspace', root: '/w', relPath: 'a.ts' })).toBe(true);
        expect(delivered).toEqual([]);
        windows.ready('files', 8);
        expect(delivered).toEqual([]);
        windows.ready('files', 7);
        expect(delivered).toEqual(['a.ts']);
        expect(windows.routeOpenFile({ requestId: 'other', workspaceId: 'other', root: '/other', relPath: 'b.ts' })).toBe(false);
    });
    it('leases the docked editor to one window, so popping cannot discard another window’s edits', () => {
        const { windows } = fixture();
        const owner = { focus: () => {}, close: () => {}, onClosed: () => {} };
        expect(windows.claim('workspace', 'files', 1, owner)).toBe(true);
        expect(windows.claim('workspace', 'files', 2, owner)).toBe(false);
        expect(() => windows.pop('workspace', 'files', 2)).toThrow('another window');
        windows.release('workspace', 1);
        expect(windows.claim('workspace', 'files', 2, owner)).toBe(true);
    });

    it('does not lease an editor while its popped window owns it', () => {
        const { windows } = fixture();
        windows.pop('workspace', 'files');
        expect(windows.claim('workspace', 'files', 1, { focus: () => {}, close: () => {}, onClosed: () => {} })).toBe(false);
    });
    it('focuses the same window instead of opening a second editor', () => {
        const { windows, events } = fixture();
        windows.pop('workspace', 'files');
        windows.pop('workspace', 'another-legacy-spec');
        expect(events.filter((event) => event.startsWith('open:'))).toEqual(['open:files']);
        expect(events).toContain('focus:files');
        expect(windows.list()).toEqual([{ workspaceId: 'workspace', specId: 'files' }]);
    });

    it('does not report bring-back complete before the window actually closes', () => {
        const { windows, events } = fixture();
        windows.pop('workspace', 'files');
        windows.bringBack('workspace');
        expect(windows.list()).toEqual([]);
        expect(events.filter((event) => event === 'changed')).toHaveLength(2);
    });

    it('retains popped ownership if closing is vetoed by unsaved edits', () => {
        const windows = new FilePanelWindows({
            open: () => ({ focus: () => {}, close: () => {}, onClosed: () => {} }),
            changed: () => {},
        });
        windows.pop('workspace', 'files');
        windows.bringBack('workspace');
        expect(windows.list()).toHaveLength(1);
    });

    it('publishes native window closure, and isolates workspaces', () => {
        const { windows, closed } = fixture();
        windows.pop('first', 'a');
        windows.pop('second', 'b');
        closed[0]!();
        expect(windows.list()).toEqual([{ workspaceId: 'second', specId: 'b' }]);
    });
});
