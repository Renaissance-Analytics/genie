import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction, type FeaturePorts, type FeatureState } from '../src/main/feature-ipc.js';
import { ProcessBook } from '../src/main/process-book.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * BACKGROUND PROCESSES THE PERSON KEEPS (§6.6) — Hosting → Processes, main-side.
 *
 * Genie 1 kept 54 background-process specs on the owner's machine (terminal_specs type 'process',
 * 37 of them autostart) and brought them back on every launch. Genie 2's supervisor ran only site
 * processes and the front door: there was no way to add a process of your own, and nothing it ran
 * was remembered past a restart. The contract here:
 *
 * - `hosting.createProcess` starts it under the supervisor, in the workspace (or a folder inside it),
 *   with the workspace's service env, and the snapshot lists it as one the person keeps (`durable`).
 * - It is written down: a second Genie on the same home brings it back RUNNING, with the env as it is
 *   NOW (not as it was when the process was added).
 * - A stop is durable: what the person stopped stays stopped through a restart, listed as `stopped`
 *   (not vanished), until they start it again. Remove forgets it.
 * - A folder outside the workspace is refused with the reason, and nothing starts.
 * - A hibernated workspace starts nothing: the restore leaves its process stopped and says why.
 */

const opened: Array<{ command?: string | undefined; cwd: string; env?: Readonly<Record<string, string>> | undefined }> = [];
let n = 0;
const live = new Set<string>();
const pty: PtyPort = {
    open: (o) => { const id = `term_${++n}`; live.add(id); opened.push({ command: o.command, cwd: o.cwd, env: o.env }); return { id, pid: 4000 + n, shell: o.command ?? 'sh', scrollback: '' }; },
    write: () => true,
    resize: () => true,
    kill: (id) => live.delete(id),
    scrollback: () => '',
    onData: () => () => {},
    onExit: () => () => {},
};
const docker: DockerRunner = async () => ({ stdout: '', exitCode: 1 });

let dir: string;
let services: ComposedServices;
let ports: FeaturePorts;
let serviceEnv: Record<string, string>;
let asleep: Set<string>;
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });
const WS = { workspaceId: 'tynn', workspacePath: join('/w', 'tynn') };
const queue = { kind: 'hosting.createProcess' as const, ...WS, name: 'queue', command: 'php artisan queue:work', folder: 'repos/app', restart: 'on-failure' as const };

async function boot(): Promise<void> {
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker });
    const book = await ProcessBook.open(dir, { supervisor: services.supervisor, envFor: () => ({ ...serviceEnv }), asleep: (id) => asleep.has(id) });
    ports = { processes: book };
}

/** Quit and launch again on the same home — what an app restart is, minus Electron. */
async function relaunch(): Promise<void> {
    await services.shutdown();
    await boot();
    ports.processes!.restore();
}

const mine = async (name = 'queue') => (await featureSnapshot(services, state(), ports)).hosting!.processes.filter((p) => p.name === name);

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-processes-'));
    opened.length = 0;
    live.clear();
    serviceEnv = { DB_HOST: '127.0.0.1' };
    asleep = new Set();
    await boot();
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('adding a background process', () => {
    it('hosting.createProcess starts it under the supervisor, in the folder inside the workspace, with the service env; the snapshot lists it as kept', async () => {
        const snap = await handleFeatureAction(services, queue, state(), ports);
        const rows = snap.hosting!.processes.filter((p) => p.name === 'queue');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ workspaceId: 'tynn', state: 'running', durable: true, command: 'php artisan queue:work' });
        expect(opened).toEqual([{ command: 'php artisan queue:work', cwd: join('/w', 'tynn', 'repos', 'app'), env: { DB_HOST: '127.0.0.1' } }]);
    });

    it('it is written down under the runtime directory, with no agent field and the person’s intent', async () => {
        await handleFeatureAction(services, queue, state(), ports);
        const file = JSON.parse(await readFile(join(dir, 'runtime', 'processes.json'), 'utf8')) as { processes: Array<Record<string, unknown>> };
        expect(file.processes).toHaveLength(1);
        expect(file.processes[0]).toMatchObject({ workspaceId: 'tynn', name: 'queue', command: 'php artisan queue:work', cwd: join('/w', 'tynn', 'repos', 'app'), restart: 'on-failure', wanted: true });
        expect(Object.keys(file.processes[0]!).some((k) => /agent/i.test(k))).toBe(false);
    });

    it('a folder outside the workspace is refused with the reason, and nothing starts or is kept', async () => {
        await expect(handleFeatureAction(services, { ...queue, folder: '../other' }, state(), ports)).rejects.toThrow(/inside the workspace/);
        await expect(handleFeatureAction(services, { ...queue, folder: join('/', 'etc') }, state(), ports)).rejects.toThrow(/inside the workspace/);
        expect(opened).toHaveLength(0);
        expect(await mine()).toHaveLength(0);
    });

    it('a process with no name or no command is refused, naming what is missing', async () => {
        await expect(handleFeatureAction(services, { ...queue, name: '  ' }, state(), ports)).rejects.toThrow(/name/);
        await expect(handleFeatureAction(services, { ...queue, command: '' }, state(), ports)).rejects.toThrow(/command/);
        expect(opened).toHaveLength(0);
    });
});

describe('across a restart', () => {
    it('a second Genie on the same home brings it back RUNNING, with the service env as it is now', async () => {
        await handleFeatureAction(services, queue, state(), ports);
        serviceEnv = { DB_HOST: '127.0.0.1', REDIS_URL: 'redis://127.0.0.1:54399' };
        opened.length = 0;
        await relaunch();
        const rows = await mine();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ state: 'running', durable: true });
        expect(opened).toEqual([{ command: 'php artisan queue:work', cwd: join('/w', 'tynn', 'repos', 'app'), env: { DB_HOST: '127.0.0.1', REDIS_URL: 'redis://127.0.0.1:54399' } }]);
    });

    it('a stop is durable: stopped by the person, it stays stopped (and listed) through a restart; Start brings it back', async () => {
        const created = await handleFeatureAction(services, queue, state(), ports);
        const id = created.hosting!.processes.find((p) => p.name === 'queue')!.id;
        await handleFeatureAction(services, { kind: 'hosting.stopProcess', processId: id }, state(), ports);
        opened.length = 0;
        await relaunch();
        expect(opened).toHaveLength(0);
        expect(await mine()).toEqual([expect.objectContaining({ id, state: 'stopped', durable: true })]);
        const started = await handleFeatureAction(services, { kind: 'hosting.startProcess', processId: id }, state(), ports);
        expect(started.hosting!.processes.find((p) => p.id === id)).toMatchObject({ state: 'running' });
        opened.length = 0;
        await relaunch();
        expect(opened).toHaveLength(1);
    });

    it('Genie’s own quit-time stop is not the person’s stop: shutting down does not un-want what they kept', async () => {
        await handleFeatureAction(services, queue, state(), ports);
        await services.shutdown();
        const file = JSON.parse(await readFile(join(dir, 'runtime', 'processes.json'), 'utf8')) as { processes: Array<{ wanted: boolean }> };
        expect(file.processes.map((p) => p.wanted)).toEqual([true]);
        await boot();
    });

    it('remove forgets it: gone from the list and not brought back', async () => {
        const created = await handleFeatureAction(services, queue, state(), ports);
        const id = created.hosting!.processes.find((p) => p.name === 'queue')!.id;
        const after = await handleFeatureAction(services, { kind: 'hosting.removeProcess', processId: id }, state(), ports);
        expect(after.hosting!.processes.filter((p) => p.id === id)).toHaveLength(0);
        opened.length = 0;
        await relaunch();
        expect(opened).toHaveLength(0);
        expect(await mine()).toHaveLength(0);
    });

    it('a hibernated workspace starts nothing: the restore leaves its process stopped and says why', async () => {
        await handleFeatureAction(services, queue, state(), ports);
        asleep.add('tynn');
        opened.length = 0;
        await relaunch();
        expect(opened).toHaveLength(0);
        const rows = await mine();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.state).toBe('stopped');
        expect(rows[0]!.reason).toMatch(/hibernat/);
    });
});
