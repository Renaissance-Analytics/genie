import { describe, expect, it, vi } from 'vitest';

/**
 * broadcastTerminalSpecsChanged() must push a `terminal-spec:changed` event to
 * every live window so the renderer re-fetches the spec list and the Processes
 * list stays live — this is what makes an MCP-created process appear without a
 * restart. We mock electron's BrowserWindow with capturing fakes and assert the
 * fan-out (and that destroyed windows are skipped). The other mocks mirror the
 * sibling ipc tests so importing ../ipc doesn't touch node-pty / db / disk.
 */

interface FakeWin {
    destroyed: boolean;
    sent: string[];
    webContents: { isDestroyed: () => boolean; send: (channel: string) => void };
}
const makeWin = (destroyed = false): FakeWin => {
    const win: FakeWin = {
        destroyed,
        sent: [],
        webContents: {
            isDestroyed: () => win.destroyed,
            send: (channel: string) => win.sent.push(channel),
        },
    };
    return win;
};
const windows: FakeWin[] = [];

vi.mock('electron', () => ({
    ipcMain: { handle: () => {} },
    BrowserWindow: { getAllWindows: () => windows },
    WebContents: class {},
}));

vi.mock('node-pty', () => ({ spawn: () => ({ onData: () => {}, onExit: () => {}, kill: () => {} }) }));
vi.mock('../../db', () => ({
    updateTerminalSpec: () => null,
    getAllSettings: () => ({ track_cwd: 'off' }),
    getTerminalSpec: () => null,
    listWorkspaces: () => [],
}));
vi.mock('../genie-adapter', () => ({
    getSnapshotStore: () => ({
        readSnapshot: () => null,
        writeSnapshot: () => 1,
        deleteSnapshot: () => undefined,
    }),
    dbSettingsProvider: () => ({ get: () => undefined }),
}));

import { broadcastTerminalSpecsChanged } from '../ipc';

describe('broadcastTerminalSpecsChanged', () => {
    it('sends terminal-spec:changed to every live window', () => {
        windows.length = 0;
        const a = makeWin();
        const b = makeWin();
        windows.push(a, b);

        broadcastTerminalSpecsChanged();

        expect(a.sent).toEqual(['terminal-spec:changed']);
        expect(b.sent).toEqual(['terminal-spec:changed']);
    });

    it('skips a destroyed window', () => {
        windows.length = 0;
        const live = makeWin();
        const dead = makeWin(true);
        windows.push(live, dead);

        broadcastTerminalSpecsChanged();

        expect(live.sent).toEqual(['terminal-spec:changed']);
        expect(dead.sent).toEqual([]);
    });
});
