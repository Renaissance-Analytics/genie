import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import { toNativeCwd, resolveSpawnCwd } from '../cwd';

/**
 * Spoof process.platform for the win32-specific conversions. Restored after
 * each test so the rest of the suite sees the real platform.
 */
function withPlatform(p: NodeJS.Platform, fn: () => void): void {
    const desc = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
    try {
        fn();
    } finally {
        if (desc) Object.defineProperty(process, 'platform', desc);
    }
}

afterEach(() => vi.restoreAllMocks());

describe('toNativeCwd', () => {
    it('converts an MSYS path to a native Windows path on win32', () => {
        withPlatform('win32', () => {
            expect(toNativeCwd('/c/Users/me/proj')).toBe('C:\\Users\\me\\proj');
            expect(toNativeCwd('/d/work')).toBe('D:\\work');
        });
    });

    it('converts a bare MSYS drive root on win32', () => {
        withPlatform('win32', () => {
            expect(toNativeCwd('/c')).toBe('C:\\');
            expect(toNativeCwd('/c/')).toBe('C:\\');
        });
    });

    it('leaves already-native Windows paths untouched on win32', () => {
        withPlatform('win32', () => {
            expect(toNativeCwd('C:\\Users\\me')).toBe('C:\\Users\\me');
        });
    });

    it('is a no-op on POSIX (a /c/... path is a real unix path there)', () => {
        withPlatform('linux', () => {
            expect(toNativeCwd('/c/Users/me')).toBe('/c/Users/me');
            expect(toNativeCwd('/home/me/proj')).toBe('/home/me/proj');
        });
    });
});

describe('resolveSpawnCwd', () => {
    it('returns the requested dir when it exists', () => {
        const tmp = os.tmpdir();
        expect(resolveSpawnCwd(tmp)).toBe(tmp);
    });

    it('falls back to home for a missing dir (the error-267 guard)', () => {
        expect(resolveSpawnCwd('/no/such/dir/anywhere-12345')).toBe(os.homedir());
    });

    it('falls back to home for undefined/empty', () => {
        expect(resolveSpawnCwd(undefined)).toBe(os.homedir());
        expect(resolveSpawnCwd('')).toBe(os.homedir());
        expect(resolveSpawnCwd(null)).toBe(os.homedir());
    });

    it('falls back to home when the path exists but is a file, not a dir', () => {
        vi.spyOn(fs, 'existsSync').mockReturnValue(true);
        vi.spyOn(fs, 'statSync').mockReturnValue({
            isDirectory: () => false,
        } as unknown as fs.Stats);
        expect(resolveSpawnCwd('/some/file.txt')).toBe(os.homedir());
    });
});
