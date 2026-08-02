import { describe, expect, it } from 'vitest';
import { buildArgv, pullArgv, runArgv } from '../argv';
import { createDockerRuntime } from '../docker-adapter';
import { createPodmanRuntime } from '../podman-adapter';
import type {
    CommandResult,
    CommandRunner,
    ContainerSpec,
    StreamHandle,
    StreamOptions,
} from '../container-runtime';

/**
 * How an image ARRIVES, and the two runtime-shaped gaps P1 left open
 * (`dev-base/README.md` items 1 and 2).
 *
 * P1 reported `image-missing` and told the user to type `docker pull` — correct
 * while there was no consent surface, and a dead end for an agent driving this
 * through the MCP. So P2 adds `pullImage`, and the properties that matter are:
 *
 *   - **progress is streamed, not accumulated.** A multi-gigabyte pull that
 *     reports only on completion is indistinguishable from a hang.
 *   - **a failed pull is a RESULT.** Same rule as every other verb in this
 *     module: the caller decides what to say, and no rejection crosses an IPC
 *     boundary.
 *   - **`--userns=keep-id` is podman-ONLY.** Docker's `--userns` accepts only
 *     `host` or empty, so passing it there is not "ignored" — it is a hard CLI
 *     error, and the flag has to be dropped by the argv builder, not by hope.
 */

interface Call {
    command: string;
    args: string[];
}

const OK = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });

interface Harness {
    runner: CommandRunner;
    calls: Call[];
    streams: Call[];
}

function harness(opts: {
    exit?: number | null;
    chunks?: string[];
    run?: (command: string, args: string[]) => CommandResult;
} = {}): Harness {
    const calls: Call[] = [];
    const streams: Call[] = [];
    return {
        calls,
        streams,
        runner: {
            async run(command, args) {
                calls.push({ command, args });
                return opts.run ? opts.run(command, args) : OK();
            },
            stream(command, args, streamOpts: StreamOptions): StreamHandle {
                streams.push({ command, args });
                for (const chunk of opts.chunks ?? []) streamOpts.onData(chunk);
                // `exit: null` (an unspawnable CLI) is a MEANINGFUL value here,
                // so it must not collapse into the 0 default.
                return {
                    stop() {},
                    exited: Promise.resolve('exit' in opts ? (opts.exit ?? null) : 0),
                };
            },
        },
    };
}

const SPEC: ContainerSpec = {
    workspaceId: 'acme',
    name: 'genie-ws-acme-dev',
    image: 'alpine',
};

// --- argv ------------------------------------------------------------------

describe('pullArgv / buildArgv', () => {
    it('pulls exactly one image', () => {
        expect(pullArgv('ghcr.io/x/genie-dev-base:1')).toEqual([
            'pull',
            'ghcr.io/x/genie-dev-base:1',
        ]);
    });

    it('builds a tagged image from a context directory', () => {
        expect(buildArgv({ tag: 'genie-site-web:latest', context: '/work/app' })).toEqual([
            'build',
            '--tag',
            'genie-site-web:latest',
            '/work/app',
        ]);
    });

    it('builds from a named Dockerfile inside that context', () => {
        expect(
            buildArgv({ tag: 't', context: '/work/app', dockerfile: 'docker/Dockerfile.dev' }),
        ).toEqual(['build', '--tag', 't', '--file', 'docker/Dockerfile.dev', '/work/app']);
    });
});

describe('runArgv — the host-identity flags', () => {
    it('passes HOST_UID / HOST_GID through as ordinary env', () => {
        // The dev image's entrypoint renumbers its `genie` user to these, so
        // files written into the bind mount come out owned by the person who
        // owns the workspace instead of by root.
        const args = runArgv(
            { ...SPEC, env: { HOST_UID: '1000', HOST_GID: '1000' } },
            { kind: 'docker', platform: 'linux' },
        );
        expect(args).toContain('--env');
        expect(args).toContain('HOST_UID=1000');
        expect(args).toContain('HOST_GID=1000');
    });

    it('emits --userns=keep-id for podman', () => {
        const args = runArgv({ ...SPEC, userns: 'keep-id' }, { kind: 'podman', platform: 'linux' });
        expect(args).toContain('--userns=keep-id');
    });

    it('DROPS --userns=keep-id for docker, which cannot accept it', () => {
        const args = runArgv({ ...SPEC, userns: 'keep-id' }, { kind: 'docker', platform: 'linux' });
        expect(args.join(' ')).not.toContain('userns');
    });
});

// --- the adapters ----------------------------------------------------------

describe('pullImage', () => {
    it('streams progress while it runs and reports success', async () => {
        const seen: string[] = [];
        const h = harness({ chunks: ['Pulling from x\n', '1: Downloading  12MB\n'] });
        const result = await createDockerRuntime({ runner: h.runner }).pullImage('alpine', {
            onProgress: (line) => seen.push(line),
        });

        expect(h.streams[0]).toEqual({ command: 'docker', args: ['pull', 'alpine'] });
        // Streamed, not summarised: a caller can render a live progress line.
        expect(seen).toEqual(['Pulling from x\n', '1: Downloading  12MB\n']);
        expect(result).toMatchObject({ ok: true, image: 'alpine' });
    });

    it('returns a FAILED result carrying the output, never a rejection', async () => {
        const h = harness({
            exit: 1,
            chunks: ['Error response from daemon: manifest unknown\n'],
        });
        const result = await createPodmanRuntime({ runner: h.runner }).pullImage('nope:9');
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/manifest unknown/);
        // The image name is on the result so a caller can report WHICH pull
        // failed without threading it back through itself.
        expect(result.image).toBe('nope:9');
    });

    it('reports an unspawnable CLI as a failure with a usable message', async () => {
        const h = harness({ exit: null });
        const result = await createDockerRuntime({ runner: h.runner }).pullImage('alpine');
        expect(result.ok).toBe(false);
        expect(result.error).toBeTruthy();
    });
});

describe('buildImage', () => {
    it('streams the build and tags the result', async () => {
        const seen: string[] = [];
        const h = harness({ chunks: ['STEP 1/4\n'] });
        const result = await createDockerRuntime({
            runner: h.runner,
            platform: 'linux',
        }).buildImage(
            { tag: 'genie-site-web:latest', context: '/work/app' },
            { onProgress: (line) => seen.push(line) },
        );
        expect(h.streams[0]?.args).toEqual([
            'build',
            '--tag',
            'genie-site-web:latest',
            '/work/app',
        ]);
        expect(seen).toEqual(['STEP 1/4\n']);
        expect(result).toMatchObject({ ok: true, image: 'genie-site-web:latest' });
    });

    it('returns a failed result with the compiler output on a bad Dockerfile', async () => {
        const h = harness({ exit: 2, chunks: ['ERROR: unknown instruction: FRM\n'] });
        const result = await createDockerRuntime({
            runner: h.runner,
            platform: 'linux',
        }).buildImage({ tag: 't', context: '/work/app' });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/unknown instruction/);
    });
});
