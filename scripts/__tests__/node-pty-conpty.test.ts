import { describe, expect, it } from 'vitest';
// @ts-expect-error — a build script, deliberately plain .mjs with no types.
import { needsConptyRestore, conptyDllPath } from '../node-pty-conpty.mjs';

/**
 * WHEN node-pty needs its ConPTY files put back (genie#228 follow-up).
 *
 * On Windows node-pty spawns through ConPTY and needs `conpty.dll` beside the
 * binding it loaded. That file is COPIED by node-pty's own postinstall, never
 * compiled — and `electron-builder install-app-deps` drives @electron/rebuild,
 * which calls node-gyp directly and runs no lifecycle scripts. `node-gyp rebuild`
 * cleans `build/`, so a rebuild that SUCCEEDS leaves a fresh
 * `build/Release/pty.node` with no `conpty/` beside it. node-pty's loader prefers
 * `build/Release` over the shipped `prebuilds/` that still has the dll, so every
 * spawn then throws and nothing can open a terminal.
 *
 * The three inputs matter for three different reasons, which is why this is a
 * predicate rather than an `if` buried in a script.
 */

const win = (over: Record<string, unknown> = {}) => ({
    platform: 'win32',
    hasBuildRelease: true,
    hasConptyDll: false,
    ...over,
});

describe('needsConptyRestore', () => {
    it('repairs a Windows tree whose rebuild dropped the dll', () => {
        expect(needsConptyRestore(win())).toBe(true);
    });

    it('leaves a tree that still has the dll alone — so it never runs twice', () => {
        expect(needsConptyRestore(win({ hasConptyDll: true }))).toBe(false);
    });

    it('leaves an UNREBUILT tree alone', () => {
        // No `build/Release` means nothing has overwritten the install: node-pty
        // loads from `prebuilds/`, which ships the dll and was never touched.
        // Running the repair there would create a `build/Release` the loader then
        // PREFERS — turning a working tree into a broken one.
        expect(needsConptyRestore(win({ hasBuildRelease: false }))).toBe(false);
    });

    it('does nothing off Windows, whatever the tree looks like', () => {
        // ConPTY is Windows-only; macOS and Linux have no equivalent file, and
        // node-pty's post-install would only clean their build dir for no reason.
        for (const platform of ['darwin', 'linux']) {
            expect(needsConptyRestore(win({ platform })), platform).toBe(false);
        }
    });
});

describe('conptyDllPath', () => {
    it('points where the LOADER looks — beside the build/Release binding', () => {
        // Not `prebuilds/win32-x64/conpty/`: node-pty checks build/Release first,
        // so once that directory exists it is the only one that matters.
        expect(conptyDllPath('/pkg/node-pty').replace(/\\/g, '/')).toBe(
            '/pkg/node-pty/build/Release/conpty/conpty.dll',
        );
    });
});
