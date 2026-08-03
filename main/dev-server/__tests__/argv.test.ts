import { describe, expect, it } from 'vitest';
import {
    SERVICE_LABEL,
    SHARED_SERVICES_NETWORK,
    WORKSPACE_LABEL,
    devContainerNameFor,
    execArgv,
    imageInspectArgv,
    logsArgv,
    networkConnectArgv,
    networkCreateArgv,
    networkCreateNamedArgv,
    networkDisconnectArgv,
    networkLsArgv,
    networkNameFor,
    portArgv,
    psArgv,
    psServicesArgv,
    runArgv,
    serviceContainerNameFor,
    serviceVolumeNameFor,
    volumeRemoveArgv,
    workspaceSlugFor,
} from '../argv';
import type { ContainerSpec } from '../container-runtime';

/**
 * The argv builders are PURE — every decision about what Genie types on the
 * command line is made here, with no process to spawn, so the security property
 * that matters is directly assertable: nothing is ever a shell string, and
 * everything is labelled with the workspace it belongs to.
 */

const spec = (over: Partial<ContainerSpec> = {}): ContainerSpec => ({
    workspaceId: 'ws-1',
    name: 'genie-ws-ws-1-dev',
    image: 'alpine:3.20',
    ...over,
});

/** The value that follows `flag` in an argv, or undefined. */
const valueAfter = (args: string[], flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
};
const valuesAfter = (args: string[], flag: string): string[] =>
    args.flatMap((token, i) => (token === flag ? [args[i + 1] ?? ''] : []));

describe('names', () => {
    it('derives a stable network + container name from the workspace id', () => {
        expect(networkNameFor('acme')).toBe('genie-ws-acme');
        expect(devContainerNameFor('acme')).toBe('genie-ws-acme-dev');
    });

    it('keeps a uuid workspace id legible — it is already a legal name', () => {
        const id = '3f0b2c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b';
        expect(workspaceSlugFor(id)).toBe(id);
    });

    it('sanitises an id a container name cannot carry', () => {
        expect(workspaceSlugFor('Acme Corp/Repo')).toMatch(/^acme-corp-repo-[0-9a-f]{8}$/);
    });

    it('never collides two ids that sanitise the same way', () => {
        // `Acme Corp` and `acme/corp` both reduce to `acme-corp`; without the
        // digest they would share one network and one dev container, and each
        // workspace would see the other's files.
        expect(workspaceSlugFor('Acme Corp')).not.toBe(workspaceSlugFor('acme/corp'));
    });

    it('is deterministic', () => {
        expect(workspaceSlugFor('Acme Corp')).toBe(workspaceSlugFor('Acme Corp'));
    });

    it('bounds the length of a very long id', () => {
        expect(workspaceSlugFor('x'.repeat(400)).length).toBeLessThanOrEqual(64);
    });
});

describe('networkLsArgv / networkCreateArgv', () => {
    it('lists by name and prints only names', () => {
        const args = networkLsArgv('genie-ws-acme');
        expect(args.slice(0, 2)).toEqual(['network', 'ls']);
        expect(valueAfter(args, '--filter')).toBe('name=genie-ws-acme');
        expect(valueAfter(args, '--format')).toBe('{{.Name}}');
    });

    it('labels the network it creates with the workspace', () => {
        const args = networkCreateArgv('genie-ws-acme', 'acme');
        expect(args.slice(0, 2)).toEqual(['network', 'create']);
        expect(valuesAfter(args, '--label')).toContain(`${WORKSPACE_LABEL}=acme`);
        expect(args.at(-1)).toBe('genie-ws-acme');
    });
});

describe('runArgv', () => {
    it('runs detached, named, labelled and attached to the workspace network', () => {
        const args = runArgv(spec({ network: 'genie-ws-ws-1' }), { kind: 'docker', platform: 'linux' });
        expect(args[0]).toBe('run');
        expect(args).toContain('-d');
        expect(valueAfter(args, '--name')).toBe('genie-ws-ws-1-dev');
        expect(valuesAfter(args, '--label')).toContain(`${WORKSPACE_LABEL}=ws-1`);
        expect(valueAfter(args, '--network')).toBe('genie-ws-ws-1');
    });

    it('puts the image last, with the command after it', () => {
        const args = runArgv(spec({ command: ['sleep', 'infinity'] }), {
            kind: 'docker',
            platform: 'linux',
        });
        expect(args.slice(-3)).toEqual(['alpine:3.20', 'sleep', 'infinity']);
    });

    it('bind-mounts through --mount, translated for the runtime', () => {
        const args = runArgv(
            spec({ mounts: [{ source: 'C:\\work\\acme', target: '/workspace' }] }),
            { kind: 'docker', platform: 'win32' },
        );
        expect(valueAfter(args, '--mount')).toBe(
            'type=bind,source=C:/work/acme,target=/workspace',
        );
    });

    it('translates the same mount to the podman machine path', () => {
        const args = runArgv(
            spec({ mounts: [{ source: 'C:\\work\\acme', target: '/workspace' }] }),
            { kind: 'podman', platform: 'win32' },
        );
        expect(valueAfter(args, '--mount')).toBe(
            'type=bind,source=/mnt/c/work/acme,target=/workspace',
        );
    });

    it('marks a read-only mount', () => {
        const args = runArgv(
            spec({ mounts: [{ source: '/srv/a', target: '/a', readOnly: true }] }),
            { kind: 'docker', platform: 'linux' },
        );
        expect(valueAfter(args, '--mount')).toBe('type=bind,source=/srv/a,target=/a,readonly');
    });

    it('refuses to build argv for a mount source no runtime can carry', () => {
        expect(() =>
            runArgv(spec({ mounts: [{ source: '\\\\srv\\share', target: '/workspace' }] }), {
                kind: 'docker',
                platform: 'win32',
            }),
        ).toThrow(/mount/i);
    });

    it('publishes only declared ports, on loopback by default', () => {
        const args = runArgv(spec({ ports: [{ container: 5173, host: 5173 }] }), {
            kind: 'docker',
            platform: 'linux',
        });
        expect(valueAfter(args, '--publish')).toBe('127.0.0.1:5173:5173/tcp');
    });

    it('lets the runtime choose the host port when none is given', () => {
        const args = runArgv(spec({ ports: [{ container: 5173 }] }), {
            kind: 'docker',
            platform: 'linux',
        });
        expect(valueAfter(args, '--publish')).toBe('127.0.0.1::5173/tcp');
    });

    it('never adds --network host or --privileged', () => {
        // The sandbox boundary IS the isolated network. Either flag dissolves it.
        const args = runArgv(spec({ ports: [{ container: 80 }] }), {
            kind: 'docker',
            platform: 'linux',
        });
        expect(args).not.toContain('--privileged');
        expect(args.join(' ')).not.toContain('--network host');
    });

    it('passes env as separate literal tokens, never interpolated', () => {
        const args = runArgv(spec({ env: { API_URL: 'http://a;b&c', EMPTY: '' } }), {
            kind: 'docker',
            platform: 'linux',
        });
        // One token per variable: a shell metacharacter in a VALUE is inert
        // because there is no shell — `seams.ts` spawns with shell:false.
        expect(valuesAfter(args, '--env')).toEqual(['API_URL=http://a;b&c', 'EMPTY=']);
    });

    it('rejects an env name that is not a plain variable name', () => {
        expect(() =>
            runArgv(spec({ env: { 'BAD NAME': 'x' } }), { kind: 'docker', platform: 'linux' }),
        ).toThrow(/env/i);
    });

    it('carries resource limits and restart policy when asked', () => {
        const args = runArgv(spec({ memory: '2g', cpus: '2', restart: 'unless-stopped' }), {
            kind: 'docker',
            platform: 'linux',
        });
        expect(valueAfter(args, '--memory')).toBe('2g');
        expect(valueAfter(args, '--cpus')).toBe('2');
        expect(valueAfter(args, '--restart')).toBe('unless-stopped');
    });

    it('rejects a NUL byte anywhere in the argv', () => {
        expect(() =>
            runArgv(spec({ command: ['sh', '-c', 'echo \0'] }), {
                kind: 'docker',
                platform: 'linux',
            }),
        ).toThrow();
    });

    it('OVERRIDES the image healthcheck when the spec sets one, aimed at the real serve port', () => {
        // The FrankenPHP image bakes a HEALTHCHECK that curls its disabled Caddy
        // admin endpoint (:2019), so the container is `(unhealthy)` forever while
        // it serves fine (genie #119, Blocker 5). The site manager replaces it.
        const args = runArgv(
            spec({
                healthcheck: {
                    cmd: 'curl -sS -o /dev/null --max-time 5 http://127.0.0.1:8080/',
                    intervalSec: 10,
                    timeoutSec: 5,
                    retries: 3,
                    startPeriodSec: 10,
                },
            }),
            { kind: 'docker', platform: 'linux' },
        );
        expect(valueAfter(args, '--health-cmd')).toBe(
            'curl -sS -o /dev/null --max-time 5 http://127.0.0.1:8080/',
        );
        expect(valueAfter(args, '--health-interval')).toBe('10s');
        expect(valueAfter(args, '--health-timeout')).toBe('5s');
        expect(valueAfter(args, '--health-retries')).toBe('3');
        expect(valueAfter(args, '--health-start-period')).toBe('10s');
        // Every health flag is a CLI flag, so it precedes the image.
        expect(args.indexOf('--health-cmd')).toBeLessThan(args.indexOf('alpine:3.20'));
    });

    it('adds no health flags when the spec sets none — the image keeps its own', () => {
        const args = runArgv(spec(), { kind: 'docker', platform: 'linux' });
        expect(args).not.toContain('--health-cmd');
        expect(args).not.toContain('--health-interval');
    });
});

describe('the remaining verbs', () => {
    it('filters ps by the workspace label and asks for parseable fields', () => {
        const args = psArgv('acme');
        expect(args.slice(0, 2)).toEqual(['ps', '-a']);
        expect(valueAfter(args, '--filter')).toBe(`label=${WORKSPACE_LABEL}=acme`);
        expect(valueAfter(args, '--format')).toContain('{{.ID}}');
        expect(valueAfter(args, '--format')).toContain('{{.Names}}');
        expect(valueAfter(args, '--format')).toContain('{{.State}}');
    });

    it('lists every Genie-managed container when no workspace is named', () => {
        expect(valueAfter(psArgv(), '--filter')).toBe(`label=${WORKSPACE_LABEL}`);
    });

    it('asks for FULL container ids, so an adopted container compares equal to a created one', () => {
        // `docker ps` truncates {{.ID}} to 12 characters while `docker run`
        // prints all 64. Without --no-trunc the second workspace to adopt a
        // shared service engine reports a DIFFERENT container id than the first
        // one that created it — which reads as "the deduplication failed".
        // Caught by the live smoke, not by a fake.
        expect(psArgv()).toContain('--no-trunc');
        expect(psServicesArgv()).toContain('--no-trunc');
    });

    it('execs a literal argv', () => {
        expect(execArgv('abc', ['php', '-v'])).toEqual(['exec', 'abc', 'php', '-v']);
    });

    it('refuses an empty exec argv', () => {
        expect(() => execArgv('abc', [])).toThrow();
    });

    it('tails logs without following', () => {
        const args = logsArgv('abc', { tail: 200 });
        expect(args).toEqual(['logs', '--tail', '200', 'abc']);
        expect(args).not.toContain('--follow');
    });

    it('follows logs when asked', () => {
        expect(logsArgv('abc', { follow: true })).toContain('--follow');
    });

    it('asks for the port map and the image', () => {
        expect(portArgv('abc')).toEqual(['port', 'abc']);
        expect(imageInspectArgv('alpine:3.20')).toEqual(['image', 'inspect', 'alpine:3.20']);
    });
});

// --- P3: what a SHARED service engine needs from the argv layer --------------

describe('shared service engines (P3)', () => {
    it('names an engine by (engine, major) so two workspaces on PG16 name ONE container', () => {
        expect(serviceContainerNameFor('postgres-16')).toBe(
            serviceContainerNameFor('postgres-16'),
        );
        expect(serviceContainerNameFor('postgres-16')).not.toBe(
            serviceContainerNameFor('postgres-15'),
        );
        expect(serviceContainerNameFor('postgres-16')).toMatch(/^genie-svc-postgres-16$/);
    });

    it('names a DEDICATED engine per workspace, so it cannot collide with the shared one', () => {
        const dedicated = serviceContainerNameFor('postgres-16', 'acme');
        expect(dedicated).not.toBe(serviceContainerNameFor('postgres-16'));
        expect(dedicated).toContain(workspaceSlugFor('acme'));
    });

    it('gives each engine its own named data volume', () => {
        expect(serviceVolumeNameFor('postgres-16', 'data')).toBe('genie-svc-postgres-16-data');
        expect(serviceVolumeNameFor('postgres-16', 'data', 'acme')).not.toBe(
            serviceVolumeNameFor('postgres-16', 'data'),
        );
    });

    it('does NOT stamp a workspace label on a machine-scoped engine', () => {
        // The whole point: `teardownWorkspaceSandbox` sweeps `genie.workspace`.
        // A shared engine carrying one workspace's label would be destroyed when
        // that workspace is removed — taking every other workspace's database
        // with it.
        const args = runArgv(
            {
                workspaceId: null,
                name: 'genie-svc-postgres-16',
                image: 'postgres:16',
                network: SHARED_SERVICES_NETWORK,
                labels: { [SERVICE_LABEL]: 'postgres-16' },
            },
            { kind: 'docker', platform: 'linux' },
        );
        expect(args.join(' ')).not.toContain(WORKSPACE_LABEL);
        expect(valuesAfter(args, '--label')).toContain(`${SERVICE_LABEL}=postgres-16`);
        expect(valueAfter(args, '--network')).toBe(SHARED_SERVICES_NETWORK);
    });

    it('still stamps the workspace label on a DEDICATED engine', () => {
        const args = runArgv(
            {
                workspaceId: 'acme',
                name: 'genie-svc-postgres-16-acme',
                image: 'postgres:16',
                labels: { [SERVICE_LABEL]: 'postgres-16' },
            },
            { kind: 'docker', platform: 'linux' },
        );
        expect(valuesAfter(args, '--label')).toContain(`${WORKSPACE_LABEL}=acme`);
    });

    it('mounts a named VOLUME (not a bind) for the engine data directory', () => {
        const args = runArgv(
            {
                workspaceId: null,
                name: 'genie-svc-postgres-16',
                image: 'postgres:16',
                network: SHARED_SERVICES_NETWORK,
                volumes: [{ name: 'genie-svc-postgres-16-data', target: '/var/lib/postgresql/data' }],
            },
            { kind: 'docker', platform: 'linux' },
        );
        expect(valuesAfter(args, '--mount')).toContain(
            'type=volume,source=genie-svc-postgres-16-data,target=/var/lib/postgresql/data',
        );
    });

    it('refuses a volume name or target that would break the --mount grammar', () => {
        const bad = (volume: { name: string; target: string }) =>
            runArgv(
                {
                    workspaceId: null,
                    name: 'svc',
                    image: 'postgres:16',
                    network: SHARED_SERVICES_NETWORK,
                    volumes: [volume],
                },
                { kind: 'docker', platform: 'linux' },
            );
        expect(() => bad({ name: 'a,b', target: '/data' })).toThrow();
        expect(() => bad({ name: 'ok', target: '/da=ta' })).toThrow();
    });

    it('creates a named network with arbitrary labels (the shared-services network)', () => {
        const args = networkCreateNamedArgv(SHARED_SERVICES_NETWORK, {
            [SERVICE_LABEL]: 'shared',
        });
        expect(args.slice(0, 2)).toEqual(['network', 'create']);
        expect(valuesAfter(args, '--label')).toEqual([`${SERVICE_LABEL}=shared`]);
        expect(args.at(-1)).toBe(SHARED_SERVICES_NETWORK);
    });

    it('attaches and detaches a running container from a workspace network', () => {
        expect(networkConnectArgv('genie-ws-acme', 'abc')).toEqual([
            'network',
            'connect',
            'genie-ws-acme',
            'abc',
        ]);
        expect(networkDisconnectArgv('genie-ws-acme', 'abc')).toEqual([
            'network',
            'disconnect',
            'genie-ws-acme',
            'abc',
        ]);
    });

    it('lists engines by the SERVICE label, not the workspace one', () => {
        expect(valueAfter(psServicesArgv(), '--filter')).toBe(`label=${SERVICE_LABEL}`);
        expect(valueAfter(psServicesArgv('postgres-16'), '--filter')).toBe(
            `label=${SERVICE_LABEL}=postgres-16`,
        );
        expect(psServicesArgv()).toContain('-a');
    });

    it('removes a data volume by name', () => {
        expect(volumeRemoveArgv('genie-svc-postgres-16-data')).toEqual([
            'volume',
            'rm',
            'genie-svc-postgres-16-data',
        ]);
    });
});
