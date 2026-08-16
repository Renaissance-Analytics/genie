import { describe, expect, it, vi } from 'vitest';
import type { CommandResult, CommandRunner, StreamHandle } from '../container-runtime';
import { createToolchainPerformDeps } from '../toolchain-effects';
import type { ToolchainEffectPrimitives } from '../toolchain-effects';

/**
 * `createToolchainPerformDeps` assembles the REAL effect the executor runs
 * through from a machine's primitives. Almost all of it is pass-through wiring;
 * the two decisions worth pinning are: an ELEVATED command goes to the elevated
 * runner (not the plain one), and VERIFY re-probes the just-installed tool for
 * its version — asking docker's ENGINE, every other tool its `--version`. The
 * platform primitives (download, resolve, installArtifact) are injected, so this
 * is provable without spawning, downloading, or elevating anything.
 */

const OK = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
const MISSING: CommandResult = { code: null, stdout: '', stderr: 'ENOENT' };
const isServerProbe = (args: string[]) => args.includes('--format');

function fakeRunner(handle: (cmd: string, args: string[]) => CommandResult): CommandRunner {
    return {
        run: vi.fn(async (cmd, args) => handle(cmd, args)),
        stream: (): StreamHandle => {
            throw new Error('unused');
        },
    };
}

function primitives(over: Partial<ToolchainEffectPrimitives> = {}): ToolchainEffectPrimitives {
    return {
        runner: fakeRunner(() => MISSING),
        runElevated: vi.fn(async () => OK('')),
        download: vi.fn(async () => ({ ok: true, path: '/tmp/x' })),
        resolveDownloadUrl: vi.fn(async () => 'https://example/x'),
        installArtifact: vi.fn(async () => OK('')),
        ...over,
    };
}

/** The machine-changed callback every assembly must supply. */
const noop = () => {};

describe('createToolchainPerformDeps — run routing', () => {
    it('sends an unelevated command to the plain runner', async () => {
        const prim = primitives({ runner: fakeRunner(() => OK('done')) });
        const deps = createToolchainPerformDeps(prim, noop);
        const res = await deps.run('winget', ['install'], { elevated: false });
        expect(prim.runner.run).toHaveBeenCalledWith('winget', ['install']);
        expect(prim.runElevated).not.toHaveBeenCalled();
        expect(res.code).toBe(0);
    });

    it('sends an elevated command to the elevated runner', async () => {
        const prim = primitives();
        const deps = createToolchainPerformDeps(prim, noop);
        await deps.run('apt-get', ['install', '-y', 'git'], { elevated: true });
        expect(prim.runElevated).toHaveBeenCalledWith('apt-get', ['install', '-y', 'git']);
        expect(prim.runner.run).not.toHaveBeenCalled();
    });
});

describe('createToolchainPerformDeps — verify', () => {
    it('reads a tool version back from its --version', async () => {
        const prim = primitives({
            runner: fakeRunner((cmd) => (cmd === 'git' ? OK('git version 2.45.0') : MISSING)),
        });
        const deps = createToolchainPerformDeps(prim, noop);
        expect(await deps.verify?.('git')).toBe('2.45.0');
    });

    it('verifies docker against its ENGINE, not just the CLI', async () => {
        const prim = primitives({
            runner: fakeRunner((cmd, args) =>
                cmd === 'docker' && isServerProbe(args) ? OK('27.3.1') : MISSING,
            ),
        });
        const deps = createToolchainPerformDeps(prim, noop);
        expect(await deps.verify?.('docker')).toBe('27.3.1');
    });

    it('returns undefined when the tool cannot be verified (e.g. not yet on PATH)', async () => {
        const deps = createToolchainPerformDeps(primitives(), noop);
        expect(await deps.verify?.('codex')).toBeUndefined();
    });
});

describe('createToolchainPerformDeps — pass-through', () => {
    it('wires the read-only platform primitives straight through', () => {
        const prim = primitives();
        const deps = createToolchainPerformDeps(prim, noop);
        expect(deps.download).toBe(prim.download);
        expect(deps.resolveDownloadUrl).toBe(prim.resolveDownloadUrl);
    });

    it('delegates an artifact install to the primitive, unchanged', async () => {
        const prim = primitives();
        const deps = createToolchainPerformDeps(prim, noop);
        const cmd = { via: 'download' as const, tool: 'php' as const, url: 'https://x', artifact: 'zip' as const, label: 'x', requiresElevation: false, requiresRestart: false };
        expect((await deps.installArtifact(cmd, '/tmp/x.zip')).code).toBe(0);
        expect(prim.installArtifact).toHaveBeenCalledWith(cmd, '/tmp/x.zip');
    });
});

/**
 * THE CHOKE POINT for "this machine just changed" (genie#209 follow-up).
 *
 * The Toolchain page caches its scan, and the only two things that dropped that
 * cache were the page's OWN add-version and remove-version. The setup wizard
 * installs through `runInstallPlan`, which never touched it — so a user could run
 * the wizard, watch Node.js install, close it, open the Toolchain page and be
 * told nothing was installed.
 *
 * Putting the invalidation on each call site is what produced that bug, so it
 * lives here instead: every install anywhere goes through this assembly to get a
 * `PerformInstall`, and the callback is a REQUIRED argument, so a new install
 * path cannot quietly skip it. It fires on the MUTATING effects only — a verify
 * is a read and must not throw away a cache it did not invalidate.
 */
describe('createToolchainPerformDeps — invalidating the machine scan', () => {
    it('reports a change after an unelevated command', async () => {
        const changed = vi.fn();
        const deps = createToolchainPerformDeps(primitives(), changed);
        await deps.run('winget', ['install'], { elevated: false });
        expect(changed).toHaveBeenCalledTimes(1);
    });

    it('reports a change after an elevated command', async () => {
        const changed = vi.fn();
        const deps = createToolchainPerformDeps(primitives(), changed);
        await deps.run('apt-get', ['install', '-y', 'git'], { elevated: true });
        expect(changed).toHaveBeenCalledTimes(1);
    });

    it('reports a change after an artifact install', async () => {
        const changed = vi.fn();
        const deps = createToolchainPerformDeps(primitives(), changed);
        await deps.installArtifact(
            { via: 'download', tool: 'php', url: 'https://x', artifact: 'zip', label: 'x', requiresElevation: false, requiresRestart: false },
            '/tmp/x.zip',
        );
        expect(changed).toHaveBeenCalledTimes(1);
    });

    it('reports a change even when the command FAILED — a failed install still moved bytes', async () => {
        const changed = vi.fn();
        const deps = createToolchainPerformDeps(
            primitives({ runner: fakeRunner(() => ({ code: 1, stdout: '', stderr: 'boom' })) }),
            changed,
        );
        await deps.run('winget', ['install'], { elevated: false });
        expect(changed).toHaveBeenCalledTimes(1);
    });

    it('does NOT report a change for a verify — that is a read', async () => {
        const changed = vi.fn();
        const deps = createToolchainPerformDeps(primitives(), changed);
        await deps.verify?.('git');
        expect(changed).not.toHaveBeenCalled();
    });
});

/**
 * Verifying a runtime LIBRARY (genie#209). A DLL has no `--version`, so the
 * effect checks its files instead — and must answer something TRUTHY when they
 * are there, because the executor reads a truthy verify as proof that a non-zero
 * exit still left the thing installed. The VC++ redistributable exits 3010
 * ("reboot required") on a perfectly good install, so that path is not
 * hypothetical.
 */
describe('createToolchainPerformDeps — verifying a runtime library', () => {
    it('reports it present by checking files, never by running it', async () => {
        const ran: string[] = [];
        const prim = primitives({
            runner: fakeRunner((cmd) => {
                ran.push(cmd);
                return MISSING;
            }),
            fileExists: async () => true,
            systemRoot: ['C:', 'Windows'].join(String.fromCharCode(92)),
        });
        const deps = createToolchainPerformDeps(prim, noop);
        expect(await deps.verify?.('vcredist')).toBeTruthy();
        expect(ran).toEqual([]);
    });

    it('reports it absent when a file is missing', async () => {
        const prim = primitives({
            fileExists: async (p) => !p.toLowerCase().includes('msvcp140'),
            systemRoot: ['C:', 'Windows'].join(String.fromCharCode(92)),
        });
        const deps = createToolchainPerformDeps(prim, noop);
        expect(await deps.verify?.('vcredist')).toBeUndefined();
    });

    it('reports it absent when there is no filesystem seam at all', async () => {
        const deps = createToolchainPerformDeps(primitives(), noop);
        expect(await deps.verify?.('vcredist')).toBeUndefined();
    });
});
