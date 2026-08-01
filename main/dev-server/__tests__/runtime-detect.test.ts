import { describe, expect, it } from 'vitest';
import { detectContainerRuntime, installHintFor } from '../runtime-detect';
import type { CommandResult, CommandRunner, StreamHandle } from '../container-runtime';

/**
 * Detection is the FIRST thing every dev-server call does, so its contract is
 * the load-bearing one: it must never throw. A user without Docker is the
 * normal case on a fresh desktop, not an error — the owner's decision was
 * "detect Docker OR Podman; guide install if absent", and a thrown exception
 * from a probe is how that turns into a crash instead of a hint.
 */

const OK = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
/** What the real runner returns when the executable is not on PATH — it
 *  RESOLVES (see `seams.ts`), it does not reject. */
const MISSING: CommandResult = { code: null, stdout: '', stderr: 'spawn ENOENT' };
/** CLI installed, engine not reachable. */
const DAEMON_DOWN: CommandResult = {
    code: 1,
    stdout: '',
    stderr: 'failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine',
};

function runner(handle: (command: string, args: string[]) => CommandResult): CommandRunner {
    return {
        async run(command, args) {
            return handle(command, args);
        },
        stream(): StreamHandle {
            throw new Error('detection never streams');
        },
    };
}

/** `docker version --format {{.Server.Version}}` vs `docker --version`. */
const isServerProbe = (args: string[]) => args.includes('--format');

describe('detectContainerRuntime', () => {
    it('reports docker when the docker engine answers', async () => {
        const result = await detectContainerRuntime({
            runner: runner((cmd) => (cmd === 'docker' ? OK('27.3.1\n') : MISSING)),
            platform: 'win32',
        });
        expect(result.kind).toBe('docker');
        expect(result.version).toBe('27.3.1');
        expect(result.installHint).toBeUndefined();
    });

    it('reports podman when only podman is present', async () => {
        const result = await detectContainerRuntime({
            runner: runner((cmd) => (cmd === 'podman' ? OK('5.2.0') : MISSING)),
            platform: 'linux',
        });
        expect(result.kind).toBe('podman');
        expect(result.version).toBe('5.2.0');
    });

    it('prefers docker when both are installed — Genie Cloud parity', async () => {
        const result = await detectContainerRuntime({
            runner: runner((cmd) => OK(cmd === 'docker' ? '27.3.1' : '5.2.0')),
            platform: 'darwin',
        });
        expect(result.kind).toBe('docker');
        expect(result.version).toBe('27.3.1');
    });

    it('falls through to podman when docker is installed but its daemon is down', async () => {
        // A stopped Docker Desktop must not shadow a WORKING podman. Preference
        // ranks runtimes that answer, not runtimes that exist.
        const result = await detectContainerRuntime({
            runner: runner((cmd, args) => {
                if (cmd === 'docker') return isServerProbe(args) ? DAEMON_DOWN : OK('Docker version 27.3.1');
                return OK('5.2.0');
            }),
            platform: 'win32',
        });
        expect(result.kind).toBe('podman');
    });

    it('returns none + an install hint when neither is installed — never throws', async () => {
        const result = await detectContainerRuntime({
            runner: runner(() => MISSING),
            platform: 'win32',
        });
        expect(result.kind).toBe('none');
        expect(result.reason).toBe('not-installed');
        expect(result.installHint).toContain('Docker Desktop');
        expect(result.installHint).toContain('Podman');
    });

    it('says "not running" — not "not installed" — when the CLI is there but the engine is not', async () => {
        // This machine is exactly this case. Telling the user to install Docker
        // when Docker IS installed sends them round a loop they cannot exit.
        const result = await detectContainerRuntime({
            runner: runner((cmd, args) => {
                if (cmd !== 'docker') return MISSING;
                return isServerProbe(args) ? DAEMON_DOWN : OK('Docker version 27.3.1, build abc');
            }),
            platform: 'win32',
        });
        expect(result.kind).toBe('none');
        expect(result.reason).toBe('not-running');
        expect(result.installHint).toMatch(/start/i);
        expect(result.installHint).toContain('Docker');
    });

    it('records what each candidate reported, for diagnostics', async () => {
        const result = await detectContainerRuntime({
            runner: runner((cmd, args) => {
                if (cmd !== 'docker') return MISSING;
                return isServerProbe(args) ? DAEMON_DOWN : OK('Docker version 27.3.1');
            }),
            platform: 'linux',
        });
        expect(result.probes).toEqual([
            expect.objectContaining({ kind: 'docker', installed: true, running: false }),
            expect.objectContaining({ kind: 'podman', installed: false, running: false }),
        ]);
    });

    it('treats an exit-0 probe with empty output as not running', async () => {
        // `docker version --format …` can exit 0 and print nothing when the
        // context points at an engine that is gone. Empty is not a version.
        const result = await detectContainerRuntime({
            runner: runner((cmd, args) => (cmd === 'docker' && isServerProbe(args) ? OK('  \n') : MISSING)),
            platform: 'linux',
        });
        expect(result.kind).toBe('none');
    });

    it('never asks the second candidate once the first one answers', async () => {
        const asked: string[] = [];
        await detectContainerRuntime({
            runner: runner((cmd) => {
                asked.push(cmd);
                return OK('27.3.1');
            }),
            platform: 'linux',
        });
        expect(asked).toEqual(['docker']);
    });

    it('survives a runner that rejects', async () => {
        const result = await detectContainerRuntime({
            runner: {
                run: () => Promise.reject(new Error('boom')),
                stream: () => {
                    throw new Error('unused');
                },
            },
            platform: 'linux',
        });
        expect(result.kind).toBe('none');
    });
});

describe('installHintFor', () => {
    it('names a real path to a runtime on each platform', () => {
        expect(installHintFor('win32')).toMatch(/docker\.com|docker desktop/i);
        expect(installHintFor('darwin')).toMatch(/brew|docker/i);
        expect(installHintFor('linux')).toMatch(/apt|docker\.com|podman/i);
    });
});
