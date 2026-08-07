import { describe, expect, it, vi } from 'vitest';
import { runPrivileged, isProcessElevated, elevationLauncherArgv, type ElevateDeps } from '../elevate';

/**
 * Running the privileged bits of host-native hosting (trust-store install, hosts-
 * file write) — story #238. The key path for CI: on Ubuntu CI the process is
 * already root, so `runPrivileged` runs DIRECTLY (no launcher) — that's what E2E
 * exercises. On a normal local machine it routes through the OS elevation launcher
 * (UAC / pkexec / osascript), which only the user's run validates.
 */
function deps(over: Partial<ElevateDeps> = {}): ElevateDeps {
    return {
        platform: 'linux',
        isElevated: () => false,
        spawnDirect: vi.fn().mockResolvedValue({ code: 0 }),
        spawnElevated: vi.fn().mockResolvedValue({ code: 0 }),
        ...over,
    };
}

describe('runPrivileged', () => {
    it('runs DIRECTLY when already privileged (the CI-root path)', async () => {
        const d = deps({ isElevated: () => true });
        const res = await runPrivileged({ cmd: 'certutil', args: ['-addstore', 'Root', 'ca.crt'] }, d);
        expect(res.ok).toBe(true);
        expect(d.spawnDirect).toHaveBeenCalledWith('certutil', ['-addstore', 'Root', 'ca.crt']);
        expect(d.spawnElevated).not.toHaveBeenCalled();
    });

    it('ELEVATES when not privileged (the local path)', async () => {
        const d = deps({ isElevated: () => false });
        const res = await runPrivileged({ cmd: 'certutil', args: ['x'] }, d);
        expect(res.ok).toBe(true);
        expect(d.spawnElevated).toHaveBeenCalledOnce();
        expect(d.spawnDirect).not.toHaveBeenCalled();
    });

    it('reports a loud failure on a non-zero exit (never silent)', async () => {
        const d = deps({ isElevated: () => true, spawnDirect: vi.fn().mockResolvedValue({ code: 1, stderr: 'access denied' }) });
        const res = await runPrivileged({ cmd: 'x', args: [] }, d);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toContain('access denied');
    });
});

describe('elevationLauncherArgv', () => {
    it('uses pkexec on Linux (clean argv, no shell)', () => {
        expect(elevationLauncherArgv('certutil', ['a', 'b'], 'linux')).toEqual(['pkexec', 'certutil', 'a', 'b']);
    });

    it('wraps with PowerShell Start-Process -Verb RunAs on Windows', () => {
        const argv = elevationLauncherArgv('certutil', ['-addstore', 'Root', 'C:/ca.crt'], 'win32');
        expect(argv[0].toLowerCase()).toContain('powershell');
        const joined = argv.join(' ');
        expect(joined).toContain('RunAs');
        expect(joined).toContain('certutil');
    });

    it('uses osascript admin on macOS', () => {
        const argv = elevationLauncherArgv('security', ['add-trusted-cert'], 'darwin');
        expect(argv[0]).toBe('osascript');
        expect(argv.join(' ')).toContain('administrator privileges');
    });
});

describe('isProcessElevated', () => {
    it('is false on Windows by default (always route through UAC)', () => {
        expect(isProcessElevated('win32')).toBe(false);
    });
});
