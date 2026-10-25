import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LANGS, currentLinkDir, defaultPathEntries } from '../src/core/toolchain-defaults.js';
import { listDefaults, restoreDefaultsEnv, setDefault, type DefaultsPorts, type LinkFs } from '../src/main/toolchain-defaults.js';

/**
 * EACH LANGUAGE'S DEFAULT (the owner's design, 2026-10-18: "Default: one of the installed versions, or the system's own.
 * It is what `php`, `node`, `python` and `go` mean"; plan `.ai/plans/genie-2-toolchain-rest.md`, row TC3a).
 *
 * The design doc said "shims"; a `.cmd` shim on Windows would not do it — a program that starts `node` directly (Genie
 * itself, most build tools) goes through CreateProcess, which looks for node.exe and never runs a .cmd. So each language
 * gets ONE stable link, `<toolchain>/current/<lang>` (a directory junction on Windows, a symlink elsewhere), pointing at
 * the chosen version; the PATH gets the fixed `current` entries once, and choosing a default repoints the link — the
 * real executable resolves for every program on every OS. The truth is the LINK on disk, not a state file.
 */

const TC = join('/data', 'genie2-toolchain');

function fakeLinks(dirs: string[] = []) {
    const real = new Set<string>(dirs);
    const links = new Map<string, string>();
    const ops: string[] = [];
    const fs: LinkFs = {
        exists: (p) => real.has(p) || (links.has(p) && real.has(links.get(p)!)),
        readLink: (p) => links.get(p) ?? null,
        link: (target, path) => { ops.push(`link ${path} -> ${target}`); if (links.has(path)) throw new Error('EEXIST'); links.set(path, target); },
        unlink: (path) => { ops.push(`unlink ${path}`); links.delete(path); },
        mkdirp: () => {},
    };
    return { fs, links, ops };
}

const env = (path: string) => { const m = new Map([['PATH', path]]); return { get: (n: string) => m.get(n), set: (n: string, v: string) => { m.set(n, v); }, map: m }; };

function ports(platform: 'win32' | 'linux', managed: Record<string, string[]>, dirs: string[] = []) {
    const links = fakeLinks(dirs);
    const p: DefaultsPorts = { platform, toolchainDir: TC, fs: links.fs, managed: (lang) => managed[lang] ?? [] };
    return { p, ...links };
}

describe('where the defaults live', () => {
    it('one link per language, and the fixed PATH entries that reach each one’s executables, per OS', () => {
        expect(DEFAULT_LANGS).toEqual(['node', 'go', 'php', 'python']);
        expect(currentLinkDir(TC, 'node')).toBe(join(TC, 'current', 'node'));
        // Python on Windows needs TWO: python.exe at the top, and Scripts\ — where pip.exe and every console script pip
        // installs live (measured on the Windows VM, TC4a-2).
        expect(defaultPathEntries(TC, 'win32')).toEqual([
            join(TC, 'current', 'node'), join(TC, 'current', 'go', 'bin'), join(TC, 'current', 'php'),
            join(TC, 'current', 'python'), join(TC, 'current', 'python', 'Scripts'),
        ]);
        // PHP and Python versions are Genie-managed on Windows only (Python elsewhere is TC4b); no link to put on PATH.
        expect(defaultPathEntries(TC, 'linux')).toEqual([join(TC, 'current', 'node', 'bin'), join(TC, 'current', 'go', 'bin')]);
    });
});

describe('choosing a default', () => {
    it('links current/<lang> to the chosen managed version; listDefaults reads it back FROM THE LINK', () => {
        const a = ports('linux', { go: ['1.27.3', '1.26.10'] }, [join(TC, 'go-versions', '1.27.3'), join(TC, 'go-versions', '1.26.10')]);
        expect(setDefault('go', '1.27.3', a.p)).toEqual({ kind: 'set', lang: 'go', version: '1.27.3' });
        expect(a.links.get(join(TC, 'current', 'go'))).toBe(join(TC, 'go-versions', '1.27.3'));
        expect(listDefaults(a.p)).toEqual({ node: null, go: '1.27.3', php: null, python: null });
    });

    it('switching repoints the one link (old link removed, new one made) — the PATH entry never changes', () => {
        const a = ports('linux', { go: ['1.27.3', '1.26.10'] }, [join(TC, 'go-versions', '1.27.3'), join(TC, 'go-versions', '1.26.10')]);
        setDefault('go', '1.27.3', a.p);
        expect(setDefault('go', '1.26.10', a.p)).toEqual({ kind: 'set', lang: 'go', version: '1.26.10' });
        expect(a.ops.slice(-2)).toEqual([`unlink ${join(TC, 'current', 'go')}`, `link ${join(TC, 'current', 'go')} -> ${join(TC, 'go-versions', '1.26.10')}`]);
        expect(listDefaults(a.p).go).toBe('1.26.10');
    });

    it('"the system’s own" clears the link; a version Genie does not manage is refused by name and nothing changes', () => {
        const a = ports('win32', { node: ['24.22.1'] }, [join(TC, 'node-versions', '24.22.1')]);
        setDefault('node', '24.22.1', a.p);
        expect(setDefault('node', '22.0.0', a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/Node 22\.0\.0 is not a version Genie manages/) });
        expect(listDefaults(a.p).node).toBe('24.22.1');
        expect(setDefault('node', null, a.p)).toEqual({ kind: 'cleared', lang: 'node' });
        expect(a.links.has(join(TC, 'current', 'node'))).toBe(false);
    });

    it('PHP and Python have no default off Windows (Genie manages them on Windows only, for now) — said, not attempted', () => {
        const a = ports('linux', { php: ['8.4.27'], python: ['3.15.1'] });
        expect(setDefault('php', '8.4.27', a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/Windows/) });
        expect(setDefault('python', '3.15.1', a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/Python versions on Windows only/) });
        expect(a.ops).toEqual([]);
    });
});

describe('what Genie’s children get', () => {
    it('each language with a default goes FIRST on the PATH Genie gives its terminals, processes and agents; none without', () => {
        const a = ports('linux', { go: ['1.27.3'], node: ['24.22.1'] }, [join(TC, 'go-versions', '1.27.3'), join(TC, 'node-versions', '24.22.1')]);
        setDefault('go', '1.27.3', a.p);
        const e = env('/usr/local/bin:/usr/bin');
        expect(restoreDefaultsEnv({ ...a.p, env: e })).toEqual([join(TC, 'current', 'go', 'bin')]);
        expect(e.map.get('PATH')).toBe(`${join(TC, 'current', 'go', 'bin')}:/usr/local/bin:/usr/bin`);
        // Twice is the same PATH (no duplicate entries); a cleared default is taken off.
        restoreDefaultsEnv({ ...a.p, env: e });
        expect(e.map.get('PATH')).toBe(`${join(TC, 'current', 'go', 'bin')}:/usr/local/bin:/usr/bin`);
    });

    it('a Python default puts BOTH its entries first, python before Scripts, ahead of the Store alias', () => {
        const a = ports('win32', { python: ['3.15.1'] }, [join(TC, 'python-versions', '3.15.1')]);
        expect(setDefault('python', '3.15.1', a.p)).toEqual({ kind: 'set', lang: 'python', version: '3.15.1' });
        const alias = 'C:/Users/me/AppData/Local/Microsoft/WindowsApps';
        const e = env(`C:/Windows/system32;${alias}`);
        const want = [join(TC, 'current', 'python'), join(TC, 'current', 'python', 'Scripts')];
        expect(restoreDefaultsEnv({ ...a.p, env: e })).toEqual(want);
        expect(e.map.get('PATH')).toBe(`${want.join(';')};C:/Windows/system32;${alias}`);
    });

    it('CONTROL: no defaults chosen → the PATH is untouched', () => {
        const a = ports('linux', {});
        const e = env('/usr/bin');
        expect(restoreDefaultsEnv({ ...a.p, env: e })).toEqual([]);
        expect(e.map.get('PATH')).toBe('/usr/bin');
    });
});
