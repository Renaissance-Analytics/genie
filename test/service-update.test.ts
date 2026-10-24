import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ServiceDriver, type DockerRunner } from '../src/main/service-driver.js';
import { composeServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import { hostingTools } from '../src/main/mcp-tools-hosting.js';
import { HostingSurface } from '../src/renderer/components/FeatureSurfaces.js';
import type { ServiceInstance } from '../src/core/services.js';
import { mintAgentId } from '../src/core/identity.js';

// An adopted container: its real name, volume, env and launch arguments differ from a new Genie's plan.
const name = 'genie-svc-postgres-17';
const original = () => ({
    Id: 'original-id', Image: 'sha256:old', Name: `/${name}`,
    State: { Status: 'running', StartedAt: 'before' },
    Config: { Image: 'registry.example/team/postgres:17', Env: ['POSTGRES_USER=owner', 'POSTGRES_PASSWORD=kept-secret', 'POSTGRES_DB=existing'], Entrypoint: ['docker-entrypoint.sh'], Cmd: ['postgres', '-c', 'max_connections=150'], Labels: { 'genie.owner': 'desktop' }, User: '', WorkingDir: '' },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 }, NetworkMode: 'default', PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '45123' }] }, Binds: ['legacy-volume:/var/lib/postgresql/data'] },
    Mounts: [{ Type: 'volume', Name: 'legacy-volume', Source: '/var/lib/docker/volumes/legacy-volume/_data', Destination: '/var/lib/postgresql/data', RW: true }],
});

function dockerFixture(options: { stopped?: boolean; failPull?: boolean; failCreate?: boolean; failCreateText?: string; failStart?: boolean; occupyName?: boolean; cutRename?: boolean; onPull?: () => void | Promise<void> } = {}) {
    const source = original();
    if (options.stopped) source.State.Status = 'exited';
    const containers = new Map<string, ReturnType<typeof original>>([[name, source]]);
    const calls: string[][] = [];
    let cut = options.cutRename;
    const run: DockerRunner = async (argv) => {
        const a = [...argv]; calls.push(a);
        if (a[0] === 'container' && a[1] === 'inspect') {
            const i = containers.get(a[2]!);
            return { exitCode: i ? 0 : 1, stdout: i ? JSON.stringify([i]) : 'No such container' };
        }
        if (a[0] === 'pull') { await options.onPull?.(); return { exitCode: options.failPull ? 1 : 0, stdout: options.failPull ? 'registry unavailable' : 'fresh tag pulled' }; }
        if (a[0] === 'stop') containers.get(a[1]!)!.State.Status = 'exited';
        if (a[0] === 'rename') {
            const i = containers.get(a[1]!)!;
            if (!i || containers.has(a[2]!)) return { exitCode: 1, stdout: 'name unavailable' };
            containers.delete(a[1]!); containers.set(a[2]!, i);
            if (cut) { cut = false; return { exitCode: 124, stdout: 'rename timed out after taking effect' }; }
        }
        if (a[0] === 'create') {
            if (options.occupyName) { const foreign = structuredClone(original()); foreign.Id = 'foreign-id'; containers.set(name, foreign); return { exitCode: 125, stdout: 'name is already in use' }; }
            if (options.failCreate) return { exitCode: 1, stdout: options.failCreateText ?? 'creation refused' };
            const i = structuredClone(original()); i.Id = 'replacement-id'; i.Image = 'sha256:new'; i.State.Status = 'created';
            for (let n = 0; n < a.length; n++) if (a[n] === '--label') { const [key, ...value] = a[n + 1]!.split('='); Object.assign(i.Config.Labels, { [key!]: value.join('=') }); }
            containers.set(a[a.indexOf('--name') + 1]!, i);
        }
        if (a[0] === 'start') {
            const i = containers.get(a[1]!)!;
            if (options.failStart && i.Id === 'replacement-id') return { exitCode: 1, stdout: 'replacement refused to start' };
            i.State.Status = 'running';
        }
        if (a[0] === 'rm') containers.delete(a.at(-1)!);
        return { exitCode: 0, stdout: '' };
    };
    return { source, containers, calls, run, driver: new ServiceDriver(run) };
}

describe('service image update', () => {
    it('asks consent even for a cached image, names its registry, and makes no change before it is given', async () => {
        const d = dockerFixture();
        const r = await d.driver.update(name, { consent: false });
        expect(r).toMatchObject({ kind: 'needs-consent', image: original().Config.Image });
        if (r.kind !== 'needs-consent') throw new Error('expected consent');
        expect(r.note).toContain('registry.example');
        expect(d.calls.filter((a) => a[0] !== 'container')).toEqual([]);
        expect(d.containers.get(name)?.Id).toBe('original-id');
    });

    it('pulls the existing tag fresh, then recreates the adopted name on its existing volume, port, env and command', async () => {
        const d = dockerFixture();
        expect(await d.driver.update(name, { consent: true })).toMatchObject({ kind: 'updated', image: original().Config.Image, restarted: true });
        expect(d.calls.filter((a) => a[0] === 'pull')).toEqual([['pull', original().Config.Image]]);
        const create = d.calls.find((a) => a[0] === 'create')!;
        expect(create.slice(0, 3)).toEqual(['create', '--name', name]);
        expect(create).toContain('127.0.0.1:45123:5432/tcp');
        expect(create).toContain('type=volume,source=legacy-volume,target=/var/lib/postgresql/data');
        expect(create).toContain('POSTGRES_PASSWORD=kept-secret');
        expect(create).toContain('genie.owner=desktop');
        expect(create.slice(-4)).toEqual([original().Config.Image, 'postgres', '-c', 'max_connections=150']);
        expect(create[create.indexOf('--entrypoint') + 1]).toBe('docker-entrypoint.sh');
        expect(d.calls.findIndex((a) => a[0] === 'pull')).toBeLessThan(d.calls.findIndex((a) => a[0] === 'stop'));
        expect(d.containers.size).toBe(1);
        expect(d.containers.get(name)).toMatchObject({ Id: 'replacement-id', State: { Status: 'running' } });
        expect(d.calls.filter((a) => a[0] === 'volume' || a.includes('-v'))).toEqual([]);
    });

    it('keeps a stopped engine stopped', async () => {
        const d = dockerFixture({ stopped: true });
        expect(await d.driver.update(name, { consent: true })).toMatchObject({ kind: 'updated', restarted: false });
        expect(d.calls.filter((a) => a[0] === 'start' || a[0] === 'stop')).toEqual([]);
        expect(d.containers.get(name)?.State.Status).toBe('created');
    });

    it('a failed pull leaves the original container running and does not rename, stop or remove anything', async () => {
        const d = dockerFixture({ failPull: true });
        await expect(d.driver.update(name, { consent: true })).rejects.toThrow('registry unavailable');
        expect(d.calls.filter((a) => ['stop', 'rename', 'rm', 'create'].includes(a[0]!))).toEqual([]);
        expect(d.containers.get(name)?.State.Status).toBe('running');
    });

    for (const failure of ['failCreate', 'failStart'] as const) {
        it(`${failure}: restores the original name and running container without deleting its volume`, async () => {
            const d = dockerFixture({ [failure]: true });
            await expect(d.driver.update(name, { consent: true })).rejects.toThrow(/refused/);
            expect(d.containers.size).toBe(1);
            expect(d.containers.get(name)).toMatchObject({ Id: 'original-id', State: { Status: 'running' } });
            expect(d.calls.filter((a) => a[0] === 'volume' || a.includes('-v'))).toEqual([]);
        });
    }

    it('restores in-memory workspace credentials before committing the replacement, and rolls back if that fails', async () => {
        const d = dockerFixture(); let restored = 0;
        await expect(d.driver.update(name, { consent: true, afterStart: async () => { restored++; if (restored === 1) throw new Error('ACL restore refused'); } })).rejects.toThrow('ACL restore refused');
        expect(restored).toBe(2);
        expect(d.containers.get(name)?.Id).toBe('original-id');
        expect(d.containers.get(name)?.State.Status).toBe('running');
    });

    it('preserves every published surface and read-only config bind mount', async () => {
        const d = dockerFixture();
        Object.assign(d.source.HostConfig.PortBindings, { '8025/tcp': [{ HostIp: '127.0.0.1', HostPort: '45124' }] });
        d.source.Mounts.push({ Type: 'bind', Name: '', Source: '/runtime/apps.toml', Destination: '/etc/apps.toml', RW: false });
        await d.driver.update(name, { consent: true });
        const create = d.calls.find((a) => a[0] === 'create')!;
        expect(create).toContain('127.0.0.1:45124:8025/tcp');
        expect(create).toContain('type=bind,source=/runtime/apps.toml,target=/etc/apps.toml,readonly');
    });

    it('does not override a stop made while the image was downloading', async () => {
        const d = dockerFixture({ onPull: () => { d.source.State.Status = 'exited'; } });
        await expect(d.driver.update(name, { consent: true })).rejects.toThrow(/changed.*try again/i);
        expect(d.containers.get(name)).toMatchObject({ Id: 'original-id', State: { Status: 'exited' } });
        expect(d.calls.filter((a) => ['stop', 'start', 'rename', 'create', 'rm'].includes(a[0]!))).toEqual([]);
    });

    it('rejects a concurrent update instead of interleaving two replacements', async () => {
        let pulled!: () => void; let resume!: () => void;
        const started = new Promise<void>((r) => { pulled = r; });
        const waiting = new Promise<void>((r) => { resume = r; });
        let pulls = 0;
        const d = dockerFixture({ onPull: async () => { if (++pulls === 1) { pulled(); await waiting; } } });
        const first = d.driver.update(name, { consent: true });
        await started;
        try { await expect(d.driver.update(name, { consent: true })).rejects.toThrow(/already.*updat/i); }
        finally { resume(); await first; }
        expect(d.calls.filter((a) => a[0] === 'pull')).toHaveLength(1);
    });

    it('preserves resource limits instead of silently removing them', async () => {
        const d = dockerFixture();
        Object.assign(d.source.HostConfig, { Memory: 268435456, NanoCpus: 1000000000, PidsLimit: 128 });
        await d.driver.update(name, { consent: true });
        const create = d.calls.find((a) => a[0] === 'create')!;
        expect(create[create.indexOf('--memory') + 1]).toBe('268435456');
        expect(create[create.indexOf('--cpus') + 1]).toBe('1');
        expect(create[create.indexOf('--pids-limit') + 1]).toBe('128');
    });

    it('preserves log rotation so recreation does not remove the existing disk limit', async () => {
        const d = dockerFixture();
        Object.assign(d.source.HostConfig, { LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } } });
        await d.driver.update(name, { consent: true });
        const create = d.calls.find((a) => a[0] === 'create')!;
        expect(create[create.indexOf('--log-driver') + 1]).toBe('json-file');
        expect(create).toContain('max-size=10m');
        expect(create).toContain('max-file=3');
    });

    it('a rename that took effect before timing out never loses the original container', async () => {
        const d = dockerFixture({ cutRename: true });
        await expect(d.driver.update(name, { consent: true })).rejects.toThrow(/rename timed out/);
        expect(d.containers.get(name)).toMatchObject({ Id: 'original-id', State: { Status: 'running' } });
        expect(d.containers.size).toBe(1);
    });

    it('does not delete an unrelated container that claims the name during recreation', async () => {
        const d = dockerFixture({ occupyName: true });
        await expect(d.driver.update(name, { consent: true })).rejects.toThrow(/original.*kept/i);
        expect(d.containers.get(name)?.Id).toBe('foreign-id');
        expect([...d.containers.values()].some((i) => i.Id === 'original-id')).toBe(true);
        expect(d.calls.filter((a) => a[0] === 'rm')).toEqual([]);
    });
});

const instance: ServiceInstance = { id: 'existing', engine: 'postgres', version: '17', scope: { kind: 'dedicated', workspaceId: 'project' }, publishedPort: 45123, credentials: { user: 'owner', password: 'kept-secret', database: 'existing' }, active: true, containerName: name, volume: 'legacy-volume', image: original().Config.Image, adopted: 'v1' };

async function composed(body: (s: Awaited<ReturnType<typeof composeServices>>, d: ReturnType<typeof dockerFixture>) => Promise<void>, saved: ServiceInstance = instance, options: Parameters<typeof dockerFixture>[0] = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'genie-service-update-'));
    const d = dockerFixture(options);
    const s = await composeServices({ userData: dir, caddyBin: null, frontDoorPort: 0, docker: d.run, v1Settings: () => null,
        pty: { open: () => ({ id: 'p', pid: 1, shell: 'sh', scrollback: '' }), write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {} },
        workspaces: () => [{ id: 'project', path: dir }, { id: 'other', path: join(dir, 'other') }],
    });
    try {
        await s.engineReconcile;
        await s.engines.adoptFromV1({ instances: [saved], record: { at: 'before', sawV1: true, sawDocker: true } });
        await body(s, d);
    } finally { await s.shutdown(); await rm(dir, { recursive: true, force: true }); }
}

describe('service update through the UI and MCP', () => {
    it('redacts registry-held credentials from Docker/restore errors even if the image uses a secret file', async () => composed(async (s, d) => {
        d.source.Config.Env = ['POSTGRES_USER=owner'];
        const preview = await handleFeatureAction(s, { kind: 'services.update', serviceId: instance.id });
        try {
            await handleFeatureAction(s, { kind: 'services.update', serviceId: instance.id, consent: true, confirmed: true }, { toolStatuses: null, knowledgeQuery: '', serviceUpdating: preview.services?.updating });
            throw new Error('expected update failure');
        } catch (error) {
            expect((error as Error).message).toContain('********');
            expect((error as Error).message).not.toContain('kept-secret');
        }
    }, instance, { failCreate: true, failCreateText: 'Docker refused credential kept-secret' }));

    it('UI asks with image and dependents first; an unconfirmed request makes no change; confirmation preserves the registry and env', async () => composed(async (s, d) => {
        const state: FeatureState = { toolStatuses: null, knowledgeQuery: '' };
        const before = structuredClone(s.engines.list());
        const env = s.engines.envFor('project');
        const first = await handleFeatureAction(s, { kind: 'services.update', serviceId: instance.id }, state);
        expect(first.services?.updating).toMatchObject({ serviceId: instance.id, image: original().Config.Image });
        expect(first.services?.updating?.dependents.join(' ')).toContain('project');
        expect(d.calls.filter((a) => ['pull', 'stop', 'rename', 'create', 'rm'].includes(a[0]!))).toEqual([]);
        const html = renderToStaticMarkup(createElement(HostingSurface, { data: first, tab: 'services', workspaces: [{ id: 'project', path: '/project' }], onAction: () => {}, onNavigate: () => {} }));
        expect(html).toContain('data-service-update="existing"');
        expect(html).toContain('registry.example/team/postgres:17');
        expect(html).toContain('Update and interrupt');
        const after = await handleFeatureAction(s, { kind: 'services.update', serviceId: instance.id, consent: true, confirmed: true }, { ...state, serviceUpdating: first.services?.updating });
        expect(after.services?.updating).toBeNull();
        expect(d.calls.filter((a) => a[0] === 'pull')).toHaveLength(1);
        expect(s.engines.list()).toEqual(before);
        expect(s.engines.envFor('project')).toEqual(env);
    }));

    it('UI confirmation without a pending preview cannot bypass the person’s image/dependency review', async () => composed(async (s, d) => {
        const r = await handleFeatureAction(s, { kind: 'services.update', serviceId: instance.id, consent: true, confirmed: true });
        expect(r.services?.updating?.image).toBe(original().Config.Image);
        expect(d.calls.filter((a) => a[0] === 'pull')).toEqual([]);
    }));

    for (const change of ['image', 'dependents'] as const) {
        it(`requires a fresh confirmation if ${change} change after the preview`, async () => composed(async (s, d) => {
            const preview = await handleFeatureAction(s, { kind: 'services.update', serviceId: instance.id });
            if (change === 'image') d.source.Config.Image = 'registry.example/team/postgres:18';
            else s.supervisor.start({ id: 'worker', workspaceId: 'project', name: 'New queue worker', command: 'worker', cwd: '/project', restart: 'never' });
            const r = await handleFeatureAction(s, { kind: 'services.update', serviceId: instance.id, consent: true, confirmed: true }, { toolStatuses: null, knowledgeQuery: '', serviceUpdating: preview.services?.updating });
            expect(r.services?.updating).toBeTruthy();
            expect(d.calls.filter((a) => a[0] === 'pull')).toEqual([]);
            if (change === 'image') expect(r.services?.updating?.image).toBe('registry.example/team/postgres:18');
            else expect(r.services?.updating?.dependents.join(' ')).toContain('New queue worker');
        }));
    }

    it('a custom engine without a database kind still names the workspace receiving its env', async () => composed(async (s) => {
        const r = await handleFeatureAction(s, { kind: 'services.update', serviceId: instance.id });
        expect(r.services?.updating?.dependents).toContain('workspace project');
    }, { ...instance, engine: 'custom', version: 'worker', internalPort: 5432, env: { WORKER_ENDPOINT: 'configured' } }));

    for (const verdict of ['allowed', 'denied'] as const) {
        it(`MCP ${verdict}: person approval names the image and affected workspace before any pull`, async () => composed(async (s, d) => {
            const approvals: string[] = [];
            const reg = hostingTools({ services: s,
                resolveCaller: () => ({ agentId: mintAgentId(), agentName: 'atlas', workspaceId: 'project', workspacePath: '/project' }),
                approve: async (_caller, action, detail) => {
                    approvals.push(`${action}: ${detail}`);
                    expect(d.calls.filter((a) => a[0] === 'pull')).toHaveLength(0);
                    return verdict;
                },
            }).find((r) => r.definition.name === 'services')!;
            const r = await reg.handler({ action: 'update', id: instance.id, terminalId: 't' }, { server: 'genie', tool: 'services', headers: {} });
            expect(approvals).toHaveLength(1);
            expect(approvals[0]).toContain('services.update');
            expect(approvals[0]).toContain(original().Config.Image);
            expect(approvals[0]).toContain('project');
            expect(d.calls.filter((a) => a[0] === 'pull')).toHaveLength(verdict === 'allowed' ? 1 : 0);
            expect(r.isError).toBe(verdict === 'denied');
            expect(r.text).not.toContain('kept-secret');
        }));
    }

    it('MCP refuses another workspace’s engine without requesting approval or touching Docker', async () => composed(async (s, d) => {
        let asks = 0;
        const reg = hostingTools({ services: s,
            resolveCaller: () => ({ agentId: mintAgentId(), agentName: 'atlas', workspaceId: 'other', workspacePath: '/other' }),
            approve: async () => { asks++; return 'allowed'; },
        }).find((r) => r.definition.name === 'services')!;
        const mark = d.calls.length;
        const r = await reg.handler({ action: 'update', id: instance.id, terminalId: 't' }, { server: 'genie', tool: 'services', headers: {} });
        expect(r.isError).toBe(true);
        expect(r.text).toContain('not one of this workspace');
        expect(asks).toBe(0);
        expect(d.calls.slice(mark)).toEqual([]);
    }));
});
