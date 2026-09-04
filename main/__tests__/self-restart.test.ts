import { describe, it, expect } from 'vitest';
import { relaunchOptions } from '../self-restart';

/**
 * genie#379 (part 2) — Genie re-execs itself without preserving argv, so any
 * launch flag silently reverts on the next self-restart. The reporter's two
 * instances were alive at once: the flagged one from the desktop launcher, and
 * a flagless one the FIRST had spawned (it inherited its cgroup scope). The
 * `.desktop` file still carried the flag, so the configuration looked right
 * while the running process contradicted it.
 */

const APPIMAGE = '/home/u/.local/bin/Genie.AppImage';
/** What `process.execPath` is inside a running AppImage — a temp mount that is
 *  GONE by the time the relaunched process would need it. */
const MOUNT_EXEC = '/tmp/.mount_GenieAbc123/genie';

describe('relaunchOptions', () => {
    it('carries the launch flags forward', () => {
        const o = relaunchOptions({
            platform: 'linux',
            env: {},
            argv: ['/usr/bin/genie', '--password-store=gnome-libsecret', '--disable-gpu'],
            execPath: '/usr/bin/genie',
        });
        expect(o.args).toEqual(['--password-store=gnome-libsecret', '--disable-gpu']);
        // Not an AppImage → let Electron use its own execPath.
        expect(o.execPath).toBeUndefined();
    });

    it('relaunches an AppImage by its DURABLE path, not the temp mount', () => {
        const o = relaunchOptions({
            platform: 'linux',
            env: { APPIMAGE },
            argv: [MOUNT_EXEC, '--password-store=gnome-libsecret'],
            execPath: MOUNT_EXEC,
        });
        expect(o.execPath).toBe(APPIMAGE);
        expect(o.args).toEqual(['--password-store=gnome-libsecret']);
        // The mount path must not survive into the relaunch in any form.
        expect(JSON.stringify(o)).not.toContain('.mount_');
    });

    it('drops one-shot launch markers that must not repeat', () => {
        const o = relaunchOptions({
            platform: 'linux',
            env: {},
            argv: [
                '/usr/bin/genie',
                '--autostart',
                'genie://auth/callback?code=abc',
                '--password-store=gnome-libsecret',
            ],
            execPath: '/usr/bin/genie',
        });
        // `--autostart` means "the OS started me at sign-in" and would make the
        // relaunched Genie hide in the tray; a genie:// URL would re-fire an
        // auth callback. Neither describes the new launch.
        expect(o.args).toEqual(['--password-store=gnome-libsecret']);
    });

    it('keeps working when there is nothing to carry', () => {
        const o = relaunchOptions({
            platform: 'win32',
            env: {},
            argv: ['C:\\Program Files\\Genie\\Genie.exe'],
            execPath: 'C:\\Program Files\\Genie\\Genie.exe',
        });
        expect(o.args).toEqual([]);
        expect(o.execPath).toBeUndefined();
    });

    it('ignores APPIMAGE off Linux (it is only ever set by an AppImage runtime)', () => {
        const o = relaunchOptions({
            platform: 'darwin',
            env: { APPIMAGE },
            argv: ['/Applications/Genie.app/Contents/MacOS/Genie', '--verbose'],
            execPath: '/Applications/Genie.app/Contents/MacOS/Genie',
        });
        expect(o.execPath).toBeUndefined();
        expect(o.args).toEqual(['--verbose']);
    });
});
