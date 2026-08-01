import { describe, expect, it } from 'vitest';
import {
    WORKSPACE_LABEL,
    devContainerNameFor,
    execArgv,
    imageInspectArgv,
    logsArgv,
    networkCreateArgv,
    networkLsArgv,
    networkNameFor,
    portArgv,
    psArgv,
    runArgv,
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
