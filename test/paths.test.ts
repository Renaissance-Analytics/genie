import { describe, expect, it } from 'vitest';
import { installDir, isInside, runtimeDir, sessionsDir } from '../src/main/paths.js';

/**
 * THE INSTALL DIRECTORY IS NOT THE RUNTIME DIRECTORY.
 *
 * §7.1, and first on that list because of a real upgrade that jammed on **31 orphaned
 * `OpenConsole.exe` processes with no error message at all** — the installer could not replace
 * files that running processes held open, and nothing in the product knew those processes
 * existed.
 */

const EXEC = 'C:\\Users\\glenn\\AppData\\Local\\Programs\\Genie\\Genie.exe';
const USER_DATA = 'C:\\Users\\glenn\\AppData\\Roaming\\Genie';

describe('the two directories', () => {
    it('never overlap, in either direction', () => {
        const install = installDir(EXEC);
        const runtime = runtimeDir(USER_DATA);

        expect(isInside(runtime, install)).toBe(false);
        expect(isInside(install, runtime)).toBe(false);

        // POSITIVE CONTROL: `isInside` is capable of saying yes, so the two `false`s above are
        // a reading and not a function that always refuses. Without this the test passes
        // against `isInside = () => false`.
        expect(isInside(sessionsDir(USER_DATA), runtime)).toBe(true);
        expect(isInside(EXEC, install)).toBe(true);
    });

    it('puts everything spawnable under the runtime directory', () => {
        // Anything that could outlive Genie — a pty host, a service, a session's files — lives
        // here, so a file a running process holds open can never block an install.
        expect(isInside(sessionsDir(USER_DATA), runtimeDir(USER_DATA))).toBe(true);
        expect(isInside(sessionsDir(USER_DATA), installDir(EXEC))).toBe(false);
    });
});

describe('isInside, which is the whole guarantee', () => {
    it('does not mistake a SIBLING for a child', () => {
        // The classic containment bug: a prefix comparison reports `…/Genie2` as being inside
        // `…/Genie`. Here that would say the new install's runtime is inside the old install
        // and quietly re-enable the thing this file exists to prevent.
        expect(isInside('C:/Programs/Genie2/runtime', 'C:/Programs/Genie')).toBe(false);
        expect(isInside('C:/Programs/Genie-old', 'C:/Programs/Genie')).toBe(false);

        // POSITIVE CONTROL: a real child still reads as one.
        expect(isInside('C:/Programs/Genie/runtime', 'C:/Programs/Genie')).toBe(true);
    });

    it('treats a path as inside itself', () => {
        expect(isInside('C:/Programs/Genie', 'C:/Programs/Genie')).toBe(true);
        expect(isInside('C:/Programs/Genie/', 'C:/Programs/Genie')).toBe(true);
    });

    it('compares Windows paths case- and separator-insensitively', () => {
        // `C:\Program Files\Genie` and `c:/program files/genie` are one directory. A
        // case-sensitive check would report a runtime path as safely outside an install it is
        // sitting in, which is the failure reading as a pass.
        expect(isInside('C:\\Program Files\\Genie\\runtime', 'c:/program files/genie')).toBe(true);
        expect(isInside('C:/Program Files/Genie/runtime', 'C:\\Program Files\\Genie')).toBe(true);
    });
});
