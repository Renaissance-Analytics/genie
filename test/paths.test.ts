import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { genieHome, installDir, isInside, runtimeDir, sessionsDir } from '../src/main/paths.js';

/**
 * THE INSTALL DIRECTORY IS NOT THE RUNTIME DIRECTORY.
 *
 * §7.1, and first on that list because of a real upgrade that jammed on **31 orphaned
 * `OpenConsole.exe` processes with no error message at all** — the installer could not replace
 * files that running processes held open, and nothing in the product knew those processes
 * existed.
 *
 * ## Why the fixtures are built with `join` instead of written out
 *
 * The first version of this file hard-coded `C:\\Users\\…\\Genie.exe`. It passed on the
 * owner's Windows machine and **failed on CI's ubuntu runner**, because `path.join` is
 * host-specific: on POSIX a Windows path is one long segment with no separators in it, so
 * `join(exec, '..')` resolves to `.` and every containment answer inverts.
 *
 * The production code is right to use the host's `path` — Genie handles the paths of the
 * machine it is running on. It is the *test* that has to be portable, so these fixtures are
 * assembled with the same `join` and the assertions hold on either platform.
 *
 * Case sensitivity is now a parameter rather than ambient, and both modes are exercised here
 * regardless of platform — otherwise the Windows branch is never run by the Linux runner that
 * gates merges.
 */

const INSTALL = join('opt', 'programs', 'Genie');
const EXEC = join(INSTALL, 'Genie.exe');
const USER_DATA = join('home', 'glenn', 'config', 'Genie');

describe('the two directories', () => {
    it('never overlap, in either direction', () => {
        const install = installDir(EXEC);
        const runtime = runtimeDir(USER_DATA);

        expect(isInside(runtime, install)).toBe(false);
        expect(isInside(install, runtime)).toBe(false);

        // POSITIVE CONTROL: `isInside` is capable of saying yes, so the two `false`s above are
        // a reading rather than a function that always refuses. Without this the test passes
        // against `isInside = () => false`.
        expect(isInside(sessionsDir(USER_DATA), runtime)).toBe(true);
        expect(isInside(EXEC, install)).toBe(true);
    });

    it('resolves the install directory from the executable', () => {
        expect(installDir(EXEC)).toBe(INSTALL);
    });

    it('puts everything spawnable under the runtime directory', () => {
        // Anything that could outlive Genie — a pty host, a service, a session's files — lives
        // here, so a file a running process holds open can never block an install.
        expect(isInside(sessionsDir(USER_DATA), runtimeDir(USER_DATA))).toBe(true);
        expect(isInside(sessionsDir(USER_DATA), installDir(EXEC))).toBe(false);
    });
});

describe('where Genie keeps its data', () => {
    /**
     * The owner, 2026-10-10: "genie's data is supposed to be in ~/.genie no matter what version
     * we are on." Not Electron's userData — that is per app NAME (`%APPDATA%\genie2`), so a
     * new major would start empty and an old one could not find what the new one wrote. The
     * home directory is the one place every version agrees on.
     */
    it('is ~/.genie, from the home directory it is given', () => {
        expect(genieHome('/home/wish')).toBe(join('/home/wish', '.genie'));
        expect(genieHome('C:\\Users\\wish')).toBe(join('C:\\Users\\wish', '.genie'));
    });

    it('is NOT an app-name directory — the thing that made every major start empty', () => {
        expect(genieHome('/home/wish')).not.toContain('genie2');
        expect(genieHome('/home/wish')).not.toContain('AppData');
    });

    it('holds the runtime and the sessions under it', () => {
        const home = genieHome('/home/wish');
        expect(runtimeDir(home)).toBe(join(home, 'runtime'));
        expect(sessionsDir(home)).toBe(join(home, 'runtime', 'sessions'));
    });

    it('is never under the install directory — §7.1 still holds for the new root', () => {
        expect(isInside(genieHome('C:\\Users\\wish'), 'C:\\Users\\wish\\AppData\\Local\\Programs\\Genie', true)).toBe(false);
    });
});

describe('isInside, which is the whole guarantee', () => {
    it('does not mistake a SIBLING for a child', () => {
        // The classic containment bug: a prefix comparison reports `…/Genie2` as being inside
        // `…/Genie`. Here that would say the new install's runtime is inside the old install
        // and quietly re-enable the thing this file exists to prevent.
        expect(isInside('/programs/Genie2/runtime', '/programs/Genie')).toBe(false);
        expect(isInside('/programs/Genie-old', '/programs/Genie')).toBe(false);

        // POSITIVE CONTROL: a real child still reads as one.
        expect(isInside('/programs/Genie/runtime', '/programs/Genie')).toBe(true);
    });

    it('treats a path as inside itself, with or without a trailing separator', () => {
        expect(isInside('/programs/Genie', '/programs/Genie')).toBe(true);
        expect(isInside('/programs/Genie/', '/programs/Genie')).toBe(true);
    });

    it('normalises separators on both platforms', () => {
        // A backslash is a separator in a path Genie was handed on Windows, and the comparison
        // must not care which style the two arguments arrived in.
        expect(isInside('C:\\Programs\\Genie\\runtime', 'C:/Programs/Genie')).toBe(true);
        expect(isInside('C:/Programs/Genie/runtime', 'C:\\Programs\\Genie')).toBe(true);
    });

    it('folds case when asked, and NOT when it is not \u2014 both asserted on every platform', () => {
        /**
         * Two directories on POSIX, one directory on Windows, and the function must be able to
         * say both. Passing the flag explicitly is what makes the Windows behaviour testable
         * from the Linux runner — the version that read `process.platform` inline could only
         * ever exercise one branch, which is precisely how this file broke CI.
         */
        expect(isInside('C:\\Program Files\\Genie\\runtime', 'c:/program files/genie', true)).toBe(true);
        expect(isInside('/Programs/Genie/runtime', '/programs/genie', false)).toBe(false);

        // The same pair, both ways, so neither answer can be a constant.
        expect(isInside('/programs/genie/runtime', '/programs/genie', false)).toBe(true);
        expect(isInside('/Programs/Genie/runtime', '/programs/genie', true)).toBe(true);
    });

    it('defaults to the host\u2019s own rule', () => {
        // The default is what production uses, so it is worth one assertion. Written as a
        // branch on the platform rather than a fixed expectation, because the correct answer
        // genuinely differs — and a test that asserted one of them would fail on the other
        // runner, which is the bug this file already had once.
        const folded = isInside('/Programs/Genie/runtime', '/programs/genie');
        expect(folded).toBe(process.platform === 'win32');
    });
});
