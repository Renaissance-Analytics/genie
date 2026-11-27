import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { restoresAtBoot } from '../src/main/boot-restore-owner.js';

/**
 * WHO RESTORES THE AGENTS AFTER A HOST UPDATE (Tynn #1058 L6). The record a drain writes (`running-at-quit.json`) used to be
 * restored by the WINDOW's boot (main.ts, restoreAfterRelaunch): electron-updater's install always relaunched one. The
 * launcher swaps the host with no window open (the spec: "the new host restores each agent once"), so the Linux
 * host-update row (1127-143956-fffa82) found the new host running and the record never spent: nobody restored. A host the
 * launcher started restores its own agents; a window the launcher started does not (two restores of one record could
 * start an agent twice: the record is read, not taken, Tynn #754). Without a launcher (a dev run, the bridge release),
 * the window restores, as before.
 */
const LAUNCHED = { GENIE_LAUNCHER_EXE: '/home/me/.local/share/genie/launcher/2026.11.27-1/genie' };

describe('who restores the agents at boot', () => {
    it('a host the launcher started restores; a window the launcher started does not', () => {
        expect(restoresAtBoot('host', LAUNCHED)).toBe(true);
        expect(restoresAtBoot('window', LAUNCHED)).toBe(false);
    });

    it('with no launcher (a dev run, the bridge release) the window restores, as before, and the host does not', () => {
        expect(restoresAtBoot('host', {})).toBe(false);
        expect(restoresAtBoot('window', {})).toBe(true);
    });

    it('a launcher path that is not absolute is no launcher (launcherLink’s rule)', () => {
        expect(restoresAtBoot('host', { GENIE_LAUNCHER_EXE: 'genie' })).toBe(false);
        expect(restoresAtBoot('window', { GENIE_LAUNCHER_EXE: 'genie' })).toBe(true);
    });

    it('genie-host restores through restoreAfterRelaunch when it is the one, once it serves; main.ts only when it is', () => {
        const host = readFileSync('src/main/genie-host.ts', 'utf8');
        expect(host).toMatch(/if \(restoresAtBoot\('host', process\.env\)\) \{[\s\S]{0,200}void restoreAfterRelaunch\(\{/);
        expect(host.indexOf("restoresAtBoot('host', process.env)")).toBeGreaterThan(host.indexOf('say(`serving ${endpoint}'));
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).toMatch(/if \(restoresAtBoot\('window', process\.env\)\) void restoreAfterRelaunch\(\{/);
    });
});
