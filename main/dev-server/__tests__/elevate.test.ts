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

    it('escapes BACKSLASHES, not just quotes, in the macOS AppleScript literal', () => {
        // An arg with a single quote becomes '\'' in the inner /bin/sh string —
        // which INTRODUCES a backslash — and an arg may carry a backslash of its
        // own. AppleScript's `do shell script "…"` literal treats backslash as its
        // escape char, so a lone backslash corrupts the command (and is an
        // injection vector: CodeQL js/incomplete-sanitization, the bug this guards).
        const argv = elevationLauncherArgv('security', ["a'b", 'c\\d'], 'darwin');
        const m = argv[2].match(/^do shell script "(.*)" with administrator privileges$/s);
        expect(m).not.toBeNull();
        const literal = m![1];

        // Every backslash in the literal must belong to a \\ or \" escape — no lone
        // backslash may reach AppleScript.
        expect(literal.replace(/\\[\\"]/g, '')).not.toContain('\\');

        // And decoding the AppleScript escaping must recover the exact /bin/sh
        // command, with each arg still single-quote-safe.
        const sh = literal.replace(/\\(["\\])/g, '$1');
        expect(sh).toContain("'a'\\''b'"); // POSIX single-quote escaping of a'b
        expect(sh).toContain("'c\\d'"); // backslash is literal inside sh single quotes
    });
});

describe('isProcessElevated', () => {
    it('is false on Windows by default (always route through UAC)', () => {
        expect(isProcessElevated('win32')).toBe(false);
    });
});
