import { describe, expect, it } from 'vitest';
import { hostToolInvocation } from '../seams';

/**
 * RUNNING A HOST TOOL ON WINDOWS (genie#205).
 *
 * `npm`, `composer` and `codex` are `.cmd`/`.bat` SHIMS on Windows, not `.exe`,
 * and `child_process.spawn` launches `.exe` only — so with `shell:false` every
 * one of them comes back `spawn <tool> ENOENT`. Measured on the reporting
 * machine: node/git/claude/docker answered, npm/composer/codex did not, which is
 * exactly the set that vanished from the Dev tools list and the set whose
 * installs failed.
 *
 * Resolving the shim's real path is NOT an escape: spawning a `.cmd` directly
 * throws `EINVAL` on modern Node (hardened after CVE-2024-27980). A shim has to
 * go through a shell.
 *
 * Which makes the QUOTING load-bearing rather than cosmetic — under a bare
 * `shell:true` an `&` in an argument really does execute (verified). So every
 * token is quoted with the SAME helper the host-native dev-server spawn uses;
 * a second copy of that logic is how the two drift and one of them becomes a
 * hole.
 */

describe('hostToolInvocation', () => {
    it('runs through a shell on win32, so a .cmd shim can start at all', () => {
        const inv = hostToolInvocation('npm', ['install', '-g', '@openai/codex'], 'win32');
        expect(inv.shell).toBe(true);
        // cmd.exe takes ONE command line; the args must be folded into it.
        expect(inv.args).toEqual([]);
        expect(inv.file).toBe('npm install -g @openai/codex');
    });

    it('does NOT use a shell off win32, where the binary is spawnable directly', () => {
        expect(hostToolInvocation('npm', ['--version'], 'linux')).toEqual({
            file: 'npm',
            args: ['--version'],
            shell: false,
        });
        expect(hostToolInvocation('composer', ['--version'], 'darwin').shell).toBe(false);
    });

    it('QUOTES a token that would otherwise be shell syntax', () => {
        // The injection this design has to survive: under a bare `shell:true`,
        // `& echo PWNED` executes. Quoted, it is one literal argument.
        const inv = hostToolInvocation('node', ['-e', 'x', '&', 'echo', 'PWNED'], 'win32');
        expect(inv.file).toBe('node -e x "&" echo PWNED');
    });

    it('quotes a path with spaces so it stays ONE argument', () => {
        const inv = hostToolInvocation('php', ['C:\\Program Files\\app\\x.php'], 'win32');
        expect(inv.file).toBe('php "C:\\Program Files\\app\\x.php"');
    });

    it('escapes an embedded quote rather than letting it close the string', () => {
        expect(hostToolInvocation('t', ['a"b'], 'win32').file).toBe('t "a""b"');
    });

    it('keeps an empty argument addressable instead of dropping it', () => {
        expect(hostToolInvocation('t', [''], 'win32').file).toBe('t ""');
    });

    it('leaves an ordinary token unquoted, so command lines stay readable', () => {
        expect(hostToolInvocation('git', ['--version'], 'win32').file).toBe('git --version');
    });
});
