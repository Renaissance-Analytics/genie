import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { windowLaunchFlags } from '../src/core/launch-flags.js';
import { helperLaunch, relaunchSpec } from '../src/main/updates-host.js';

/*
 * A RELAUNCH IS THE LAUNCH IT REPLACES (Tynn #386, the real-app hang row). genie-host starts a new window after ending a
 * hung one, from the launch the window published. That launch copies only the window's OWN switches: the ones an Electron
 * needs to start here at all, and a debugger port or inspector the window itself was started with — never one it was not.
 * Anyone able to start Genie with a debug port already had it; carrying it over gives nobody anything new. The updater
 * helper is another process beside the window, so it gets no debugger switch (it would ask for the same port).
 */
const published = (argv: readonly string[]) => ({ file: '/opt/genie/genie', args: ['/app', '--updater', ...windowLaunchFlags(argv)] });

describe('the window publishes its own switches, and only those', () => {
    it('(a) a window started with a debugger port and an inspector is relaunched with exactly the same values', () => {
        const argv = ['/opt/genie/genie', '.', '--inspect=9230', '--remote-debugging-port=9344', '--no-sandbox', '--ozone-platform=x11'];
        const relaunch = relaunchSpec(published(argv), {});
        expect(relaunch.args).toEqual(['/app', '--inspect=9230', '--remote-debugging-port=9344', '--no-sandbox', '--ozone-platform=x11']);
        // The updater helper beside it gets neither: the window still holds those ports.
        expect(helperLaunch(published(argv)).args).toEqual(['/app', '--updater', '--no-sandbox', '--ozone-platform=x11']);
    });

    it('(b) a plain launch (a real user\'s) is relaunched with neither', () => {
        const argv = ['/opt/genie/genie', '--password-store=basic'];
        const relaunch = relaunchSpec(published(argv), {});
        expect(relaunch.args).toEqual(['/app', '--password-store=basic']);
        expect(relaunch.args.some((a) => a.startsWith('--inspect') || a.startsWith('--remote-debugging-port'))).toBe(false);
    });

    it('never invents one: a bare --inspect, a look-alike, or a value smuggled in another switch is not copied', () => {
        expect(windowLaunchFlags(['x', '--inspect', '--inspect-brk=1', '--remote-debugging-portx=1', '--remote-debugging-pipe', '--foo=--inspect=1'])).toEqual([]);
    });

    it('wired: main publishes windowLaunchFlags(process.argv); the host starts its helper through helperLaunch', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).toMatch(/'--updater', \.\.\.windowLaunchFlags\(process\.argv\)\]/);
        const host = readFileSync('src/main/genie-host.ts', 'utf8');
        // Tynn #535: through the host's spawn-host child while it is up, spawnUpdaterProcess between its lives: helperLaunch either way.
        expect(host).toMatch(/startHelper: \(launch\) => \{ startOwnDetached\('updater', helperLaunch\(launch\),[\s\S]{0,200}spawnUpdaterProcess\(helperLaunch\(launch\),/);
    });
});
