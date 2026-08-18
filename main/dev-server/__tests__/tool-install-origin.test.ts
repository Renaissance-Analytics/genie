import { describe, expect, it } from 'vitest';
import { toolInstallOrigin } from '../tool-install-origin';

/**
 * Where a TOOL row's binary came from (genie#213).
 *
 * After #212 the language rows (php/node/…) can say who installed them and
 * which directory they are, because they come from `scanToolchain`. The tool
 * rows (git, docker, composer, claude-code, codex) come from the separate
 * `ToolUpdate` path and carry a name and two version numbers and nothing else —
 * so on one screen half the rows can answer "which git answered?" and half
 * cannot.
 *
 * This is the smaller of the two fixes the issue weighs: rather than force
 * single-version, install-once tools into the per-version model that exists
 * because LANGUAGES need pinning, give the existing path the two facts it is
 * missing. Both are read off the resolved path, so this is pure and the
 * `where`/`which` call stays where it already is.
 *
 * The distinction that actually matters is MANAGED vs DETECTED: Genie can
 * update what it installed and must not pretend to own a Docker that winget put
 * there. Naming the foreign installer is best-effort on top of that — and where
 * the path does not say, the answer is `unknown`, never a guess.
 */

const WIN = { platform: 'win32', home: 'C:\\Users\\dev', genieRoot: 'C:\\Users\\dev\\AppData\\Roaming\\genie\\toolchain' };
const NIX = { platform: 'darwin', home: '/Users/dev', genieRoot: '/Users/dev/Library/Application Support/genie/toolchain' };

describe('a binary Genie installed itself', () => {
    it('is managed, and named genie', () => {
        const o = toolInstallOrigin('C:\\Users\\dev\\AppData\\Roaming\\genie\\toolchain\\git\\2.42.0\\bin\\git.exe', WIN);

        expect(o.managedByGenie).toBe(true);
        expect(o.source).toBe('genie');
        expect(o.directory).toBe('C:\\Users\\dev\\AppData\\Roaming\\genie\\toolchain\\git\\2.42.0\\bin');
    });

    it('matches the root case-insensitively on Windows, where paths are', () => {
        // The same install reached through a differently-cased PATH entry is the
        // same install; reporting it as foreign would offer to install a second.
        const o = toolInstallOrigin('c:\\users\\dev\\appdata\\roaming\\GENIE\\toolchain\\git\\bin\\git.exe', WIN);
        expect(o.managedByGenie).toBe(true);
    });

    it('does NOT match a lookalike sibling of the root', () => {
        // `…\genie\toolchain-backup\…` starts with the root string but is not
        // inside it. A prefix test without a separator would claim it.
        const o = toolInstallOrigin(
            'C:\\Users\\dev\\AppData\\Roaming\\genie\\toolchain-backup\\git\\bin\\git.exe',
            WIN,
        );
        expect(o.managedByGenie).toBe(false);
    });
});

describe('a binary another installer put there', () => {
    it('names winget on Windows', () => {
        const o = toolInstallOrigin(
            'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links\\docker.exe',
            WIN,
        );
        expect(o.managedByGenie).toBe(false);
        expect(o.source).toBe('winget');
    });

    it('names Program Files as a system-wide install', () => {
        const o = toolInstallOrigin('C:\\Program Files\\Git\\cmd\\git.exe', WIN);
        expect(o.source).toBe('program-files');
        expect(o.managedByGenie).toBe(false);
    });

    it('names homebrew on macOS, on both the arm and intel prefixes', () => {
        expect(toolInstallOrigin('/opt/homebrew/bin/git', NIX).source).toBe('homebrew');
        expect(toolInstallOrigin('/usr/local/Cellar/git/2.42.0/bin/git', NIX).source).toBe('homebrew');
    });

    it('names an npm global install', () => {
        expect(
            toolInstallOrigin('C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd', WIN).source,
        ).toBe('npm-global');
        expect(toolInstallOrigin('/Users/dev/.npm-global/bin/codex', NIX).source).toBe('npm-global');
    });

    it('names a plain system location', () => {
        expect(toolInstallOrigin('/usr/bin/git', NIX).source).toBe('system');
    });
});

describe('what the path does not say', () => {
    it('is unknown rather than guessed', () => {
        const o = toolInstallOrigin('/home/dev/some/hand/rolled/place/git', {
            platform: 'linux',
            home: '/home/dev',
            genieRoot: '/home/dev/.config/genie/toolchain',
        });

        expect(o.source).toBe('unknown');
        expect(o.managedByGenie).toBe(false);
        // The directory is still worth reporting — it is the whole answer to
        // "which git answered?", which is most of why this exists.
        expect(o.directory).toBe('/home/dev/some/hand/rolled/place');
    });

    it('reports nothing at all for an unresolved binary, without throwing', () => {
        const o = toolInstallOrigin(undefined, WIN);
        expect(o).toEqual({ managedByGenie: false, source: 'unknown' });
    });
});
