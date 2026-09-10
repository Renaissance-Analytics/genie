import { describe, expect, it, vi } from 'vitest';
import {
    MAX_PRIVILEGED_STEPS,
    PRIVILEGED_STEP_EXIT_BASE,
    elevationBatchArgv,
    elevationLauncherArgv,
    isProcessElevated,
    privilegedStepMarker,
    runPrivilegedBatch,
    type PrivilegedBatchDeps,
    type PrivilegedStep,
} from '../elevate';

/**
 * Running the privileged bits of host-native hosting (trust-store install, hosts-
 * file write) — story #238, batched into ONE prompt by genie#604. The key path
 * for CI: on Ubuntu CI the process is already root, so the batch runs each step
 * DIRECTLY (no launcher) — that's what E2E exercises. On a normal local machine
 * it routes through the OS elevation launcher (UAC / pkexec / osascript), which
 * only the user's run validates.
 */
function deps(over: Partial<PrivilegedBatchDeps> = {}): PrivilegedBatchDeps {
    return {
        platform: 'linux',
        isElevated: () => false,
        spawn: vi.fn().mockResolvedValue({ code: 0 }),
        ...over,
    };
}

const CA_STEP: PrivilegedStep = {
    id: 'ca-trust',
    label: 'install its local CA into the trust store',
    run: { cmd: 'trust', args: ['anchor', '/g/gen-ca.crt'] },
};
const HOSTS_STEP: PrivilegedStep = {
    id: 'hosts-file',
    label: 'update the hosts file',
    run: { cmd: 'cp', args: ['-f', '/tmp/hosts.new', '/etc/hosts'] },
};

describe('runPrivilegedBatch', () => {
    it('does NOT spawn at all for an empty batch (nothing needed ⇒ no prompt)', async () => {
        const d = deps();
        const res = await runPrivilegedBatch([], d);
        expect(res.ok).toBe(true);
        expect(d.spawn).not.toHaveBeenCalled();
    });

    it('runs every step DIRECTLY, in order, when already privileged (the CI-root path)', async () => {
        const d = deps({ isElevated: () => true });
        const res = await runPrivilegedBatch([CA_STEP, HOSTS_STEP], d);
        expect(res.ok).toBe(true);
        expect((d.spawn as ReturnType<typeof vi.fn>).mock.calls).toEqual([
            ['trust', ['anchor', '/g/gen-ca.crt']],
            ['cp', ['-f', '/tmp/hosts.new', '/etc/hosts']],
        ]);
    });

    it('elevates ONCE for the whole batch when not privileged (genie#604)', async () => {
        const d = deps({ isElevated: () => false });
        const res = await runPrivilegedBatch([CA_STEP, HOSTS_STEP], d);
        expect(res.ok).toBe(true);
        expect(d.spawn).toHaveBeenCalledOnce();
        const [cmd, args] = (d.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(cmd).toBe('pkexec');
        // …and the one elevation carries BOTH commands.
        expect(args.join(' ')).toContain('anchor');
        expect(args.join(' ')).toContain('/etc/hosts');
    });

    it('names WHICH step failed on the direct path, and stops there', async () => {
        const spawn = vi
            .fn()
            .mockResolvedValueOnce({ code: 0 })
            .mockResolvedValueOnce({ code: 1, stderr: 'permission denied' });
        const d = deps({ isElevated: () => true, spawn });
        const res = await runPrivilegedBatch([CA_STEP, HOSTS_STEP, CA_STEP], d);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.step?.id).toBe('hosts-file');
            expect(res.error).toContain('permission denied');
        }
        // A failed step ABORTS the batch — the third step never ran.
        expect(spawn).toHaveBeenCalledTimes(2);
    });

    it('names WHICH step failed from the batch exit code (the Windows channel)', async () => {
        // Windows gives back only the elevated process's exit code — no stderr —
        // so the batch script encodes the failing step's index in it.
        const spawn = vi.fn().mockResolvedValue({ code: PRIVILEGED_STEP_EXIT_BASE + 1 });
        const d = deps({ platform: 'win32', spawn });
        const res = await runPrivilegedBatch([CA_STEP, HOSTS_STEP], d);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.step?.id).toBe('hosts-file');
    });

    it('names WHICH step failed from the stderr marker (the macOS channel)', async () => {
        // osascript collapses every failure to exit 1, but the failing command's
        // stderr comes back inside its error text — so the script also marks it.
        const spawn = vi.fn().mockResolvedValue({
            code: 1,
            stderr: `execution error: ${privilegedStepMarker(0)}\nSEC_ERROR_BAD_DATABASE (1)`,
        });
        const d = deps({ platform: 'darwin', spawn });
        const res = await runPrivilegedBatch([CA_STEP, HOSTS_STEP], d);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.step?.id).toBe('ca-trust');
            // The marker is machinery, not a message — it must not reach the user.
            expect(res.error).not.toContain('genie-privileged-step');
            expect(res.error).toContain('SEC_ERROR_BAD_DATABASE');
        }
    });

    it('reports an UNATTRIBUTED failure when the elevation itself fails (prompt dismissed)', async () => {
        const spawn = vi.fn().mockResolvedValue({ code: 1, stderr: 'The operation was canceled by the user.' });
        const d = deps({ platform: 'win32', spawn });
        const res = await runPrivilegedBatch([CA_STEP, HOSTS_STEP], d);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.step).toBeNull(); // nothing ran — do not blame a step
            expect(res.error).toContain('canceled');
        }
    });
});

describe('elevationBatchArgv', () => {
    it('refuses to elevate for zero commands', () => {
        expect(() => elevationBatchArgv([], 'linux')).toThrow(/zero/i);
    });

    it('refuses a batch too long to encode a step index in the exit code', () => {
        const many = Array.from({ length: MAX_PRIVILEGED_STEPS + 1 }, () => ({ cmd: 'x', args: [] }));
        expect(() => elevationBatchArgv(many, 'linux')).toThrow(/steps/i);
    });

    it('Linux: one pkexec running both commands, each guarded by its own exit code', () => {
        const argv = elevationBatchArgv([CA_STEP.run, HOSTS_STEP.run], 'linux');
        expect(argv.slice(0, 3)).toEqual(['pkexec', '/bin/sh', '-c']);
        expect(argv).toHaveLength(4);
        expect(argv[3]).toBe(
            `'trust' 'anchor' '/g/gen-ca.crt' || { echo 'genie-privileged-step:0' >&2; exit ${PRIVILEGED_STEP_EXIT_BASE}; }; ` +
                `'cp' '-f' '/tmp/hosts.new' '/etc/hosts' || { echo 'genie-privileged-step:1' >&2; exit ${PRIVILEGED_STEP_EXIT_BASE + 1}; }`,
        );
    });

    it('Linux: POSIX-quotes arguments carrying quotes, spaces and backslashes', () => {
        const argv = elevationBatchArgv([{ cmd: 'cp', args: ["a'b", 'c d', 'e\\f', 'g"h'] }], 'linux');
        expect(argv[3]).toContain(`'cp' 'a'\\''b' 'c d' 'e\\f' 'g"h'`);
    });

    it('macOS: one osascript admin prompt carrying the whole batch', () => {
        const argv = elevationBatchArgv([CA_STEP.run, HOSTS_STEP.run], 'darwin');
        expect(argv[0]).toBe('osascript');
        expect(argv[1]).toBe('-e');
        expect(argv).toHaveLength(3);
        expect(argv[2]).toMatch(/^do shell script ".*" with administrator privileges$/s);
        expect(argv[2]).toContain('anchor');
        expect(argv[2]).toContain('/etc/hosts');
    });

    it('macOS: escapes BACKSLASHES, not just quotes, in the AppleScript literal', () => {
        const runs = [
            { cmd: 'security', args: ["a'b", 'c\\d'] },
            { cmd: 'cp', args: ['-f', 'say "hi"'] },
        ];
        // An arg with a single quote becomes '\'' in the inner /bin/sh string —
        // which INTRODUCES a backslash — and an arg may carry a backslash of its
        // own. AppleScript's `do shell script "…"` literal treats backslash as its
        // escape char, so a lone backslash corrupts the command (and is an
        // injection vector: CodeQL js/incomplete-sanitization, the bug this guards).
        const argv = elevationBatchArgv(runs, 'darwin');
        const m = argv[2].match(/^do shell script "(.*)" with administrator privileges$/s);
        expect(m).not.toBeNull();
        const literal = m![1];

        // Every backslash in the literal must belong to a \\ or \" escape — no lone
        // backslash may reach AppleScript.
        expect(literal.replace(/\\[\\"]/g, '')).not.toContain('\\');

        // And decoding the AppleScript escaping must recover the exact /bin/sh
        // script, with each arg still single-quote-safe.
        const sh = literal.replace(/\\(["\\])/g, '$1');
        expect(sh).toContain("'a'\\''b'"); // POSIX single-quote escaping of a'b
        expect(sh).toContain("'c\\d'"); // backslash is literal inside sh single quotes
        expect(sh).toContain(`'say "hi"'`); // a double quote survives the round trip
        // Both unix platforms run the SAME script — only the wrapper differs.
        expect(sh).toBe(elevationBatchArgv(runs, 'linux')[3]);
    });

    it('Windows: ONE Start-Process -Verb RunAs for the whole batch', () => {
        const argv = elevationBatchArgv([CA_STEP.run, HOSTS_STEP.run], 'win32');
        expect(argv[0].toLowerCase()).toContain('powershell');
        expect(argv.slice(1, 3)).toEqual(['-NoProfile', '-Command']);
        const inner = argv[3];
        // The fix, asserted directly: one shield, not one per command.
        expect(inner.match(/Start-Process/g)).toHaveLength(1);
        expect(inner).toContain('-Verb RunAs');
    });

    it('Windows: propagates the elevated exit code instead of swallowing it', () => {
        const inner = elevationBatchArgv([CA_STEP.run], 'win32')[3];
        expect(inner).toContain('-PassThru');
        expect(inner).toContain('exit $p.ExitCode');
        // A dismissed prompt returns no process object — that must not read as success.
        expect(inner).toContain('if ($null -eq $p) { exit 1 }');
    });

    it('Windows: the elevated script runs each command and exits with its step index', () => {
        const script = decodeWindowsBatchScript(elevationBatchArgv([CA_STEP.run, HOSTS_STEP.run], 'win32'));
        expect(script).toBe(
            [
                `& 'trust' 'anchor' '/g/gen-ca.crt'`,
                `if ($LASTEXITCODE -ne 0) { exit ${PRIVILEGED_STEP_EXIT_BASE} }`,
                `& 'cp' '-f' '/tmp/hosts.new' '/etc/hosts'`,
                `if ($LASTEXITCODE -ne 0) { exit ${PRIVILEGED_STEP_EXIT_BASE + 1} }`,
                'exit 0',
            ].join('\n'),
        );
    });

    it('Windows: PowerShell-quotes arguments carrying quotes, spaces and backslashes', () => {
        const argv = elevationBatchArgv(
            [{ cmd: 'cmd', args: ['/c', 'copy', '/y', "C:\\Temp\\it's here\\hosts.new", 'C:\\Windows\\a b\\hosts'] }],
            'win32',
        );
        const script = decodeWindowsBatchScript(argv);
        // Single-quoted PowerShell strings are literal — backslashes need no
        // escaping, and an embedded quote is DOUBLED.
        expect(script).toContain(`'C:\\Temp\\it''s here\\hosts.new'`);
        expect(script).toContain(`'C:\\Windows\\a b\\hosts'`);
        // The base64 payload is quote-proof by construction: nothing the caller
        // supplies can break out of the outer command line.
        expect(argv[3]).not.toContain("it's");
    });
});

/** The elevated script Windows carries as base64 UTF-16LE (`-EncodedCommand`),
 *  which is what keeps the caller's quotes off three nested command lines. */
function decodeWindowsBatchScript(argv: string[]): string {
    const m = argv[3].match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/);
    expect(m, 'no -EncodedCommand payload in the Windows launcher').not.toBeNull();
    return Buffer.from(m![1], 'base64').toString('utf16le');
}

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
        // Same fixed bug as the batch generator above — the single-command
        // launcher is still what the toolchain installer elevates through.
        const argv = elevationLauncherArgv('security', ["a'b", 'c\\d'], 'darwin');
        const m = argv[2].match(/^do shell script "(.*)" with administrator privileges$/s);
        expect(m).not.toBeNull();
        const literal = m![1];

        expect(literal.replace(/\\[\\"]/g, '')).not.toContain('\\');

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
