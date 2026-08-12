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

describe('createToolchainPerformDeps — run routing', () => {
    it('sends an unelevated command to the plain runner', async () => {
        const prim = primitives({ runner: fakeRunner(() => OK('done')) });
        const deps = createToolchainPerformDeps(prim);
        const res = await deps.run('winget', ['install'], { elevated: false });
        expect(prim.runner.run).toHaveBeenCalledWith('winget', ['install']);
        expect(prim.runElevated).not.toHaveBeenCalled();
        expect(res.code).toBe(0);
    });

    it('sends an elevated command to the elevated runner', async () => {
        const prim = primitives();
        const deps = createToolchainPerformDeps(prim);
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
        const deps = createToolchainPerformDeps(prim);
        expect(await deps.verify?.('git')).toBe('2.45.0');
    });

    it('verifies docker against its ENGINE, not just the CLI', async () => {
        const prim = primitives({
            runner: fakeRunner((cmd, args) =>
                cmd === 'docker' && isServerProbe(args) ? OK('27.3.1') : MISSING,
            ),
        });
        const deps = createToolchainPerformDeps(prim);
        expect(await deps.verify?.('docker')).toBe('27.3.1');
    });

    it('returns undefined when the tool cannot be verified (e.g. not yet on PATH)', async () => {
        const deps = createToolchainPerformDeps(primitives());
        expect(await deps.verify?.('codex')).toBeUndefined();
    });
});

describe('createToolchainPerformDeps — pass-through', () => {
    it('wires the platform primitives straight through', () => {
        const prim = primitives();
        const deps = createToolchainPerformDeps(prim);
        expect(deps.download).toBe(prim.download);
        expect(deps.resolveDownloadUrl).toBe(prim.resolveDownloadUrl);
        expect(deps.installArtifact).toBe(prim.installArtifact);
    });
});
