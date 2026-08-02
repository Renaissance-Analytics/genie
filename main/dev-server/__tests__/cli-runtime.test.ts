import { describe, expect, it } from 'vitest';
import { createDockerRuntime } from '../docker-adapter';
import { createPodmanRuntime } from '../podman-adapter';
import type { CommandResult, CommandRunner, StreamHandle, StreamOptions } from '../container-runtime';

/**
 * The docker / podman adapters — everything between "a pure argv" and "a real
 * child process". The CommandRunner is injected, so the whole lifecycle is
 * exercised here with no container runtime installed at all.
 *
 * What is actually being asserted is the two things a fake cannot fake away:
 * IDEMPOTENCE (no second `network create`, no duplicate dev container) and
 * TOLERANCE (removing something that is already gone is success, not a throw).
 */

interface Call {
    command: string;
    args: string[];
}

interface Harness {
    runner: CommandRunner;
    calls: Call[];
    streams: Call[];
    /** argv of every call, joined — for readable assertions. */
    lines(): string[];
}

const OK = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
const FAIL = (stderr: string, code = 1): CommandResult => ({ code, stdout: '', stderr });

function harness(handle: (command: string, args: string[]) => CommandResult = () => OK()): Harness {
    const calls: Call[] = [];
    const streams: Call[] = [];
    return {
        calls,
        streams,
        lines: () => calls.map((c) => `${c.command} ${c.args.join(' ')}`),
        runner: {
            async run(command, args) {
                calls.push({ command, args });
                return handle(command, args);
            },
            stream(command, args, opts: StreamOptions): StreamHandle {
                streams.push({ command, args });
                opts.onData('hello\n');
                return { stop() {}, exited: Promise.resolve(0) };
            },
        },
    };
}

describe('adapter identity', () => {
    it('knows which CLI it drives', async () => {
        const h = harness();
        expect(createDockerRuntime({ runner: h.runner }).kind).toBe('docker');
        expect(createPodmanRuntime({ runner: h.runner }).kind).toBe('podman');
        await createPodmanRuntime({ runner: h.runner }).ps('acme');
        expect(h.calls[0]?.command).toBe('podman');
    });
});

describe('networkEnsure', () => {
    it('creates the workspace network when it does not exist', async () => {
        const h = harness((_c, args) => (args[1] === 'ls' ? OK('') : OK('netid\n')));
        const runtime = createDockerRuntime({ runner: h.runner });

        const net = await runtime.networkEnsure('acme');

        expect(net).toEqual({ name: 'genie-ws-acme', created: true });
        expect(h.lines().some((l) => l.includes('network create'))).toBe(true);
    });

    it('is idempotent — an existing network is not re-created', async () => {
        const h = harness((_c, args) => (args[1] === 'ls' ? OK('genie-ws-acme\n') : OK()));
        const runtime = createDockerRuntime({ runner: h.runner });

        const net = await runtime.networkEnsure('acme');

        expect(net).toEqual({ name: 'genie-ws-acme', created: false });
        expect(h.lines().some((l) => l.includes('network create'))).toBe(false);
    });

    it('matches the network name EXACTLY — `--filter name=` is a substring match', async () => {
        // `docker network ls --filter name=genie-ws-a` also returns
        // `genie-ws-abc`. Trusting the filter would make workspace `a` adopt
        // workspace `abc`'s network.
        const h = harness((_c, args) =>
            args[1] === 'ls' ? OK('genie-ws-acme-two\ngenie-ws-acme-three\n') : OK('netid'),
        );
        const runtime = createDockerRuntime({ runner: h.runner });

        expect(await runtime.networkEnsure('acme')).toEqual({
            name: 'genie-ws-acme',
            created: true,
        });
    });

    it('throws with the CLI own words when creation fails', async () => {
        const h = harness((_c, args) =>
            args[1] === 'ls' ? OK('') : FAIL('permission denied while trying to connect'),
        );
        const runtime = createDockerRuntime({ runner: h.runner });

        await expect(runtime.networkEnsure('acme')).rejects.toThrow(/permission denied/);
    });
});

describe('runContainer', () => {
    it('returns the id the CLI printed', async () => {
        const h = harness(() => OK('9f8e7d6c5b4a\n'));
        const runtime = createDockerRuntime({ runner: h.runner });

        const ref = await runtime.runContainer({
            workspaceId: 'acme',
            name: 'genie-ws-acme-dev',
            image: 'alpine:3.20',
        });

        expect(ref).toEqual({ id: '9f8e7d6c5b4a', name: 'genie-ws-acme-dev' });
    });

    it('defaults the network to the workspace network', async () => {
        const h = harness(() => OK('id'));
        await createDockerRuntime({ runner: h.runner }).runContainer({
            workspaceId: 'acme',
            name: 'genie-ws-acme-dev',
            image: 'alpine:3.20',
        });
        expect(h.calls[0]?.args).toContain('genie-ws-acme');
    });

    it('surfaces a failure rather than returning a bogus id', async () => {
        const h = harness(() => FAIL('Unable to find image \'genie/dev-base:1\' locally'));
        const runtime = createDockerRuntime({ runner: h.runner });

        await expect(
            runtime.runContainer({ workspaceId: 'a', name: 'n', image: 'genie/dev-base:1' }),
        ).rejects.toThrow(/Unable to find image/);
    });
});

describe('ps', () => {
    it('parses the tab-delimited rows', async () => {
        const h = harness(() =>
            OK(
                'abc123\tgenie-ws-acme-dev\tgenie/dev-base:1\trunning\tUp 3 minutes\n' +
                    'def456\tgenie-ws-acme-web\talpine:3.20\texited\tExited (0) 1 hour ago\n',
            ),
        );
        const runtime = createDockerRuntime({ runner: h.runner });

        expect(await runtime.ps('acme')).toEqual([
            {
                id: 'abc123',
                name: 'genie-ws-acme-dev',
                image: 'genie/dev-base:1',
                state: 'running',
                status: 'Up 3 minutes',
                workspaceId: 'acme',
            },
            {
                id: 'def456',
                name: 'genie-ws-acme-web',
                image: 'alpine:3.20',
                state: 'exited',
                status: 'Exited (0) 1 hour ago',
                workspaceId: 'acme',
            },
        ]);
    });

    it('ignores blank lines and unknown states', async () => {
        const h = harness(() => OK('\nabc\tn\ti\tsomething-new\t\n\n'));
        const rows = await createDockerRuntime({ runner: h.runner }).ps('acme');
        expect(rows).toHaveLength(1);
        expect(rows[0]?.state).toBe('unknown');
    });

    it('strips the brackets podman puts around a names list', async () => {
        const h = harness(() => OK('abc\t[genie-ws-acme-dev]\talpine\trunning\tUp\n'));
        const rows = await createPodmanRuntime({ runner: h.runner }).ps('acme');
        expect(rows[0]?.name).toBe('genie-ws-acme-dev');
    });

    it('returns nothing rather than throwing when the engine is unreachable', async () => {
        // `ps` is what every status read calls. A stopped Docker Desktop must
        // read as "no containers", not as an exception through the IPC layer.
        const h = harness(() => FAIL('Cannot connect to the Docker daemon'));
        expect(await createDockerRuntime({ runner: h.runner }).ps('acme')).toEqual([]);
    });
});

describe('portMappings', () => {
    it('parses `docker port` output', async () => {
        const h = harness(() => OK('5173/tcp -> 0.0.0.0:49153\n5432/tcp -> 127.0.0.1:49154\n'));
        expect(await createDockerRuntime({ runner: h.runner }).portMappings('abc')).toEqual([
            { container: 5173, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 49153 },
            { container: 5432, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 49154 },
        ]);
    });

    it('handles an IPv6 host binding', async () => {
        const h = harness(() => OK('80/tcp -> [::]:8080\n'));
        expect(await createDockerRuntime({ runner: h.runner }).portMappings('abc')).toEqual([
            { container: 80, protocol: 'tcp', hostIp: '::', hostPort: 8080 },
        ]);
    });

    it('returns nothing for a container that publishes nothing', async () => {
        const h = harness(() => OK(''));
        expect(await createDockerRuntime({ runner: h.runner }).portMappings('abc')).toEqual([]);
    });
});

describe('lifecycle verbs', () => {
    it('starts and stops by id', async () => {
        const h = harness(() => OK());
        const runtime = createDockerRuntime({ runner: h.runner });
        await runtime.start('abc');
        await runtime.stop('abc');
        expect(h.lines()).toEqual(['docker start abc', 'docker stop abc']);
    });

    it('treats removing something already gone as success', async () => {
        // Teardown must converge. "No such container" means the postcondition
        // already holds, so raising here would make a second teardown fail.
        const h = harness(() => FAIL('Error: No such container: abc'));
        const runtime = createDockerRuntime({ runner: h.runner });
        await expect(runtime.remove('abc')).resolves.toBeUndefined();
        await expect(runtime.stop('abc')).resolves.toBeUndefined();
        await expect(runtime.networkRemove('acme')).resolves.toBeUndefined();
    });

    it('still raises a removal failure that is NOT "already gone"', async () => {
        const h = harness(() => FAIL('Error response from daemon: container is running'));
        await expect(createDockerRuntime({ runner: h.runner }).remove('abc')).rejects.toThrow(
            /is running/,
        );
    });

    it('reports whether an image is present locally', async () => {
        const present = harness(() => OK('[{"Id":"sha256:…"}]'));
        expect(await createDockerRuntime({ runner: present.runner }).imageExists('alpine')).toBe(
            true,
        );

        const absent = harness(() => FAIL('Error: No such image: genie/dev-base:1'));
        expect(
            await createDockerRuntime({ runner: absent.runner }).imageExists('genie/dev-base:1'),
        ).toBe(false);
    });

    it('execs and returns the result verbatim', async () => {
        const h = harness(() => ({ code: 2, stdout: 'out', stderr: 'err' }));
        const result = await createDockerRuntime({ runner: h.runner }).exec('abc', ['php', '-v']);
        expect(result).toEqual({ code: 2, stdout: 'out', stderr: 'err' });
        expect(h.calls[0]?.args).toEqual(['exec', 'abc', 'php', '-v']);
    });

    it('reads a bounded log tail', async () => {
        const h = harness(() => OK('line one\nline two\n'));
        expect(await createDockerRuntime({ runner: h.runner }).logs('abc')).toBe(
            'line one\nline two\n',
        );
        expect(h.calls[0]?.args).toContain('--tail');
    });

    it('follows logs through the STREAM seam, not the buffered one', async () => {
        const h = harness();
        const chunks: string[] = [];
        const handle = createDockerRuntime({ runner: h.runner }).followLogs('abc', (c) =>
            chunks.push(c),
        );

        expect(h.streams[0]?.args).toContain('--follow');
        expect(h.calls).toHaveLength(0);
        expect(chunks).toEqual(['hello\n']);
        handle.stop();
    });
});

describe('detect', () => {
    it('is available on the adapter itself', async () => {
        const h = harness(() => OK('27.3.1'));
        expect((await createDockerRuntime({ runner: h.runner }).detect()).kind).toBe('docker');
    });
});
