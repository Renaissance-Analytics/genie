import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { installQuit } from '../src/core/quit.js';

/**
 * A HOST UPDATE UNDER THE LAUNCHER CLOSES THE WINDOW, NOTHING ELSE (Tynn #1058 L6). electron-updater replaced the whole
 * install, so a window that saw the host installing shut everything down. Under the launcher that answer is
 * `launcher.shutDown`: the Linux host-update-rollback row (1127-143956-fffa82) saw the open window stop the host the
 * launcher had just started again ("shutting down: a window asked", 0.4 s after it served), and the launcher then stop and
 * exit. The launcher owns the host's stop and swap; the window only leaves, and the launcher opens it again after the swap
 * (the owner: "drain and swap the host, then refresh the UI"). Without a launcher (the bridge release) nothing changes.
 */
describe('what a window does when the host installs', () => {
    it('under the launcher, any update closes this window only', () => {
        expect(installQuit({ kind: 'full', why: 'a host update (it comes with its client)' }, true)).toBe('exit-window');
        expect(installQuit({ kind: 'client-only' }, true)).toBe('exit-window');
        expect(installQuit(undefined, true)).toBe('exit-window');
    });

    it('without a launcher (the bridge release), a full install shuts everything down and a client-only one exits, as before', () => {
        expect(installQuit({ kind: 'full', why: 'another host' }, false)).toBe('shut-down');
        expect(installQuit(undefined, false)).toBe('shut-down');
        expect(installQuit({ kind: 'client-only' }, false)).toBe('exit-window');
    });

    it('main.ts says whether a launcher started this window', () => {
        expect(readFileSync('src/main/main.ts', 'utf8')).toMatch(/const how = installQuit\(scope, launcherLink\(process\.env\) !== null\);/);
    });
});
