import {
    execArgv,
    imageInspectArgv,
    logsArgv,
    networkCreateArgv,
    networkLsArgv,
    networkNameFor,
    networkRemoveArgv,
    portArgv,
    psArgv,
    removeArgv,
    runArgv,
    startArgv,
    stopArgv,
} from './argv';
import { installHintFor, notRunningHintFor, probeRuntime } from './runtime-detect';
import { defaultCommandRunner } from './seams';
import type {
    CommandResult,
    CommandRunner,
    ContainerRef,
    ContainerRuntime,
    ContainerRuntimeKind,
    ContainerSpec,
    ContainerState,
    ContainerSummary,
    LogOptions,
    NetworkRef,
    PortMapping,
    RuntimeDetection,
    StreamHandle,
} from './container-runtime';

/**
 * The docker / podman adapter — everything between "a pure argv" and "a real
 * child process".
 *
 * ONE implementation, not two. Podman's CLI is deliberately Docker-compatible,
 * so the genuine differences are exactly three, and none of them is a verb:
 * the executable name, the Windows bind-mount path (handled in `mount-path.ts`),
 * and a `ps` names column that podman sometimes brackets. Forking this file to
 * express those would guarantee the two adapters drift; `docker-adapter.ts` and
 * `podman-adapter.ts` are therefore the named entry points and this is the body.
 *
 * ## The two behaviours that are not obvious
 *
 * **Idempotence.** `networkEnsure` is called on every workspace open, so it must
 * be a no-op the second time. `--filter name=` is a SUBSTRING match, which means
 * asking about `genie-ws-a` also returns `genie-ws-abc` — so the returned names
 * are compared exactly rather than trusted, or workspace `a` would adopt
 * workspace `abc`'s network.
 *
 * **Tolerance.** Stopping or removing something that is already gone is SUCCESS.
 * Teardown has to converge: if the second attempt at removing a half-removed
 * workspace throws, the user is left with a workspace they cannot finish
 * deleting. Conversely a failure that is NOT "already gone" is still raised —
 * silently swallowing those is how a leaked container becomes invisible.
 *
 * And `ps` returns `[]` rather than throwing when the engine is unreachable: it
 * is what every status read calls, and a stopped Docker Desktop must read as
 * "no containers", not as an exception crossing the IPC boundary.
 */

export interface CliRuntimeOptions {
    runner?: CommandRunner;
    platform?: NodeJS.Platform | string;
    /** Override the executable — a non-PATH install, or a test. */
    bin?: string;
}

/** Errors that mean the postcondition already holds. */
const ALREADY_GONE = /no such |not found|is not running|no container|removal .* already/i;

/** A create that lost a race with another `ensure`. */
const ALREADY_EXISTS = /already exists/i;

const CONTAINER_STATES: readonly ContainerState[] = [
    'running',
    'exited',
    'created',
    'paused',
    'restarting',
    'removing',
    'dead',
];

export function createCliRuntime(
    kind: ContainerRuntimeKind,
    opts: CliRuntimeOptions = {},
): ContainerRuntime {
    const runner = opts.runner ?? defaultCommandRunner;
    const platform = opts.platform ?? process.platform;
    const bin = opts.bin ?? kind;

    const run = (args: string[]): Promise<CommandResult> => runner.run(bin, args);
    const ok = (result: CommandResult): boolean => result.code === 0;

    /** Everything the CLI said, trimmed to something a human can read. */
    const detailOf = (result: CommandResult): string =>
        (result.stderr || result.stdout || '').trim().slice(0, 600);

    const fail = (verb: string, result: CommandResult): never => {
        const where = result.code === null ? 'could not be run' : `failed (${result.code})`;
        throw new Error(`${bin} ${verb} ${where}: ${detailOf(result) || 'no output'}`);
    };

    /** Run a verb whose failure is only interesting when it is not "already gone". */
    const runTolerant = async (verb: string, args: string[]): Promise<void> => {
        const result = await run(args);
        if (ok(result) || ALREADY_GONE.test(detailOf(result))) return;
        fail(verb, result);
    };

    return {
        kind,

        async detect(): Promise<RuntimeDetection> {
            const probe = await probeRuntime(kind, runner, bin);
            if (probe.running) {
                return {
                    kind,
                    ...(probe.version ? { version: probe.version } : {}),
                    probes: [probe],
                };
            }
            return {
                kind: 'none',
                reason: probe.installed ? 'not-running' : 'not-installed',
                installHint: probe.installed
                    ? notRunningHintFor(kind, platform)
                    : installHintFor(platform),
                probes: [probe],
            };
        },

        async networkEnsure(workspaceId: string): Promise<NetworkRef> {
            const name = networkNameFor(workspaceId);
            const listed = await run(networkLsArgv(name));
            if (ok(listed) && splitLines(listed.stdout).includes(name)) {
                return { name, created: false };
            }
            const created = await run(networkCreateArgv(name, workspaceId));
            if (!ok(created)) {
                // Two windows opening the same workspace at once both see "no
                // network" and both create; the loser is not an error.
                if (ALREADY_EXISTS.test(detailOf(created))) return { name, created: false };
                fail('network create', created);
            }
            return { name, created: true };
        },

        async networkRemove(workspaceId: string): Promise<void> {
            await runTolerant('network rm', networkRemoveArgv(networkNameFor(workspaceId)));
        },

        async imageExists(image: string): Promise<boolean> {
            return ok(await run(imageInspectArgv(image)));
        },

        async runContainer(spec: ContainerSpec): Promise<ContainerRef> {
            const args = runArgv(
                { ...spec, network: spec.network ?? networkNameFor(spec.workspaceId) },
                { kind, platform },
            );
            const result = await run(args);
            if (!ok(result)) fail('run', result);
            // The id is the last line: a first run may print pull progress above it.
            const id = splitLines(result.stdout).pop() ?? '';
            if (!id) {
                throw new Error(`${bin} run succeeded but printed no container id`);
            }
            return { id, name: spec.name };
        },

        async start(id: string): Promise<void> {
            const result = await run(startArgv(id));
            if (!ok(result)) fail('start', result);
        },

        async stop(id: string): Promise<void> {
            await runTolerant('stop', stopArgv(id));
        },

        async remove(id: string): Promise<void> {
            await runTolerant('rm', removeArgv(id));
        },

        exec(id: string, argv: string[]): Promise<CommandResult> {
            // Verbatim: a non-zero exit from the command INSIDE the container is
            // the caller's news, not this adapter's failure.
            return run(execArgv(id, argv));
        },

        async logs(id: string, logOpts: LogOptions = {}): Promise<string> {
            const result = await run(logsArgv(id, logOpts));
            // A container's own stderr arrives on our stderr; both are the log.
            return [result.stdout, result.stderr].filter(Boolean).join('');
        },

        followLogs(id: string, onData: (chunk: string) => void): StreamHandle {
            return runner.stream(bin, logsArgv(id, { follow: true }), { onData });
        },

        async ps(workspaceId?: string): Promise<ContainerSummary[]> {
            const result = await run(psArgv(workspaceId));
            if (!ok(result)) return [];
            return parsePs(result.stdout, workspaceId);
        },

        async portMappings(id: string): Promise<PortMapping[]> {
            const result = await run(portArgv(id));
            if (!ok(result)) return [];
            return parsePorts(result.stdout);
        },
    };
}

// --- pure parsing ----------------------------------------------------------

function splitLines(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

export function parsePs(stdout: string, workspaceId?: string): ContainerSummary[] {
    return splitLines(stdout).flatMap((line) => {
        const [id, rawName, image, rawState, status] = line.split('\t');
        if (!id || !rawName) return [];
        const state = String(rawState ?? '').trim() as ContainerState;
        return [
            {
                id,
                // Podman renders the names column as a list — `[name]`.
                name: rawName.replace(/^\[|\]$/g, ''),
                image: image ?? '',
                state: CONTAINER_STATES.includes(state) ? state : 'unknown',
                status: (status ?? '').trim(),
                workspaceId,
            },
        ];
    });
}

/** `5173/tcp -> 0.0.0.0:49153`, or `80/tcp -> [::]:8080` for IPv6. */
const PORT_LINE = /^(\d+)\/(tcp|udp)\s*->\s*(.+):(\d+)$/;

export function parsePorts(stdout: string): PortMapping[] {
    return splitLines(stdout).flatMap((line) => {
        const match = PORT_LINE.exec(line);
        if (!match) return [];
        return [
            {
                container: Number(match[1]),
                protocol: match[2] as 'tcp' | 'udp',
                hostIp: match[3].replace(/^\[|\]$/g, ''),
                hostPort: Number(match[4]),
            },
        ];
    });
}
