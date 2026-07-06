import { describe, expect, it } from 'vitest';
import {
    toBashPath,
    shimFileName,
    winShimContent,
    buildShimSet,
    mergePathEntry,
    isInstallCurrent,
} from '../win-shims';

/**
 * Pure Windows-shim + PATH logic. These are the safety-critical rules — a wrong
 * PATH merge could duplicate or DROP the user's PATH entries, and a wrong shim
 * would call the wrong bash/script — so they're pinned directly here (no Windows
 * box / registry needed).
 */

describe('toBashPath', () => {
    it('converts a drive-letter Windows path to the /c/ MSYS form', () => {
        expect(toBashPath('C:\\Users\\me\\.genie\\tynn-cli\\bin\\resetme')).toBe(
            '/c/Users/me/.genie/tynn-cli/bin/resetme',
        );
    });
    it('lower-cases the drive letter', () => {
        expect(toBashPath('D:\\Work\\x')).toBe('/d/Work/x');
    });
    it('accepts a forward-slashed drive path', () => {
        expect(toBashPath('C:/Users/me/x')).toBe('/c/Users/me/x');
    });
    it('leaves an already-POSIX path alone', () => {
        expect(toBashPath('/c/already/posix')).toBe('/c/already/posix');
    });
});

describe('shimFileName', () => {
    it('adds a .cmd extension', () => {
        expect(shimFileName('resetme')).toBe('resetme.cmd');
    });
});

describe('winShimContent', () => {
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const script = 'C:\\Users\\me\\.genie\\tynn-cli\\bin\\resetme';
    const content = winShimContent(bash, script);

    it('invokes the resolved Git Bash, quoted (Windows form)', () => {
        expect(content).toContain(`"${bash}"`);
    });
    it('points at the underlying script in bash form, quoted', () => {
        expect(content).toContain('"/c/Users/me/.genie/tynn-cli/bin/resetme"');
    });
    it('forwards all arguments via %*', () => {
        expect(content).toContain('%*');
    });
    it('is a silent wrapper (@echo off)', () => {
        expect(content.startsWith('@echo off')).toBe(true);
    });
    it('produces the exact single-command shape', () => {
        expect(content).toBe(
            '@echo off\r\n"C:\\Program Files\\Git\\bin\\bash.exe" "/c/Users/me/.genie/tynn-cli/bin/resetme" %*\r\n',
        );
    });
});

describe('buildShimSet', () => {
    it('maps each command to <cmd>.cmd pointing at binDir/<cmd>', () => {
        const set = buildShimSet(
            ['resetme', 'puse'],
            'C:\\Git\\bash.exe',
            'C:\\Users\\me\\.genie\\tynn-cli\\bin',
        );
        expect(Object.keys(set).sort()).toEqual(['puse.cmd', 'resetme.cmd']);
        expect(set['resetme.cmd']).toContain(
            '"/c/Users/me/.genie/tynn-cli/bin/resetme"',
        );
        expect(set['puse.cmd']).toContain(
            '"/c/Users/me/.genie/tynn-cli/bin/puse"',
        );
    });
});

describe('mergePathEntry', () => {
    const shim = 'C:\\Users\\me\\.genie\\tynn-cli\\win-shims';

    it('appends the entry when absent', () => {
        const { value, changed } = mergePathEntry('C:\\Windows;C:\\Windows\\System32', shim);
        expect(changed).toBe(true);
        expect(value).toBe(`C:\\Windows;C:\\Windows\\System32;${shim}`);
    });

    it('is idempotent — no change when already present', () => {
        const current = `C:\\Windows;${shim};C:\\Other`;
        const { value, changed } = mergePathEntry(current, shim);
        expect(changed).toBe(false);
        expect(value).toBe(current); // preserved byte-for-byte
    });

    it('treats case / slash-direction / trailing slash as the same entry', () => {
        const current = 'c:/users/me/.genie/tynn-cli/win-shims\\';
        const { changed } = mergePathEntry(current, shim);
        expect(changed).toBe(false);
    });

    it('never drops or reorders existing entries when appending', () => {
        const current = 'A;B;C';
        const { value } = mergePathEntry(current, shim);
        expect(value.split(';').slice(0, 3)).toEqual(['A', 'B', 'C']);
        expect(value.split(';')).toHaveLength(4);
    });

    it('handles an empty PATH', () => {
        expect(mergePathEntry('', shim)).toEqual({ value: shim, changed: true });
    });

    it('does not create a double separator when PATH ends with one', () => {
        const { value } = mergePathEntry('C:\\Windows;', shim);
        expect(value).toBe(`C:\\Windows;${shim}`);
    });
});

describe('isInstallCurrent', () => {
    it('is false with no marker', () => {
        expect(isInstallCurrent(null, '1.2.3')).toBe(false);
    });
    it('is true when the marker version matches the build', () => {
        expect(isInstallCurrent({ version: '1.2.3', installedAt: 0 }, '1.2.3')).toBe(true);
    });
    it('is false when the marker is from a different build', () => {
        expect(isInstallCurrent({ version: '1.2.2', installedAt: 0 }, '1.2.3')).toBe(false);
    });
});
