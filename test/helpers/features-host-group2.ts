import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { SiteForm } from '../../src/core/forms.js';
import { LOCAL_EVENTS, type CallContext, type RemoteMethod } from '../../src/core/remote-protocol.js';
import { AttentionStore } from '../../src/main/attention-store.js';
import { HostFeatures } from '../../src/main/features-host.js';
import { FlowStore } from '../../src/main/flow-store.js';
import { hostAloneApi, type HostAlonePorts } from '../../src/main/host-alone-api.js';
import { composeHosting } from '../../src/main/hosting-compose.js';
import { InboxStore } from '../../src/main/inbox-store.js';
import { KnowledgeStore } from '../../src/main/knowledge-store.js';
import { ProcessBook } from '../../src/main/process-book.js';
import { ProcessScheduler } from '../../src/main/process-scheduler.js';
import { ProcessSupervisor } from '../../src/main/process-supervisor.js';
import { Registry } from '../../src/main/registry.js';
import { hostRemoteApi } from '../../src/main/remote-access-host.js';
import { SettingsStore } from '../../src/main/settings-store.js';
import { Store } from '../../src/main/store.js';
import type { DockerRunner } from '../../src/main/service-driver.js';
import type { PtyPort } from '../../src/main/terminal-host.js';
import type { FeatureData } from '../../src/renderer/features.js';

export const groupTwoContext: CallContext = Object.freeze({ connectionId: 'group-two-owner', origin: 'relay', profile: 'desktop',
    isOwner: true, workspaceId: null, readonly: false, label: 'fixture owner' });
export const serviceForm = { workspaceId: 'work', engine: 'postgres', major: '17', scope: 'dedicated' as const };
export const siteForm: SiteForm = { name: 'fixture', mode: 'proxy', devServer: null, hostPort: 43123, root: null, spa: false };
export const settleFeatures = async () => { for (let i = 0; i < 16; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

/** Real host composition/book/supervisor over inert OS ports, with real temporary files. No window composition. */
export async function groupTwoFixture() {
    const dir = await mkdtemp(join(tmpdir(), 'genie-features-group-two-')), workspace = join(dir, 'work');
    await mkdir(workspace);
    await writeFile(join(workspace, 'project.json'), JSON.stringify({ name: 'work', repos: [] }));
    await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { dev: 'fixture-server --port {port}' } }));
    const settings = await SettingsStore.open(dir), knowledge = KnowledgeStore.open(dir), inbox = await InboxStore.open(dir);
    const flows = await FlowStore.open(dir), attention = await AttentionStore.open(dir, inbox);
    const opened: Array<Parameters<PtyPort['open']>[0] & { id: string }> = [];
    const output = new Set<(id: string, data: string) => void>(), exited = new Set<(id: string, code: number) => void>();
    const live = new Set<string>(); let terminal = 0;
    const pty: PtyPort = {
        open: input => { const id = `fixture-pty-${++terminal}`; opened.push({ ...input, id }); live.add(id);
            return { id, pid: 4000 + terminal, shell: input.command ?? 'fixture-shell', scrollback: '' }; },
        write: () => true, resize: () => true, scrollback: () => '',
        kill: id => { const had = live.delete(id); if (had) for (const listener of exited) listener(id, 0); return had; },
        onData: listener => { output.add(listener); return () => { output.delete(listener); }; },
        onExit: listener => { exited.add(listener); return () => { exited.delete(listener); }; },
    };
    const supervisor = new ProcessSupervisor(pty);
    const dockerCalls: Array<readonly string[]> = [], images = new Set<string>(), containers = new Map<string, string>();
    const docker = { down: false };
    const runDocker: DockerRunner = async args => {
        dockerCalls.push(args);
        if (docker.down) return { stdout: 'fixture Docker daemon is unavailable', exitCode: 1 };
        const [command, sub] = args;
        if (command === 'image' && sub === 'inspect') return { stdout: images.has(args[2]!) ? '[{}]' : '', exitCode: images.has(args[2]!) ? 0 : 1 };
        if (command === 'pull') { images.add(args[1]!); return { stdout: '', exitCode: 0 }; }
        if (command === 'container' && sub === 'inspect') { const status = containers.get(args[2]!);
            return { stdout: status ? JSON.stringify([{ State: { Status: status, StartedAt: 'fixture' } }]) : '', exitCode: status ? 0 : 1 }; }
        if (command === 'create') containers.set(args[2]!, 'created');
        if (command === 'start') containers.set(args[1]!, 'running');
        if (command === 'stop') containers.set(args[1]!, 'exited');
        if (command === 'rm') containers.delete(args[2]!);
        if (command === 'logs') return { stdout: 'fixture engine output\n', exitCode: 0 };
        return { stdout: '', exitCode: 0 };
    };
    const frontChanges = new Set<() => void>(); let linked = true;
    const hosting = await composeHosting({ userData: dir, supervisor, settings, appEnv: () => ({}),
        caddyBin: null, noCaddyReason: 'fixture host has no bundled Caddy', problems: ['fixture hosting input is missing'],
        frontDoorPort: 0, docker: runDocker, portFree: async () => true, engineAnswers: async () => true,
        workspaces: () => [{ id: 'work', path: workspace }], gitIgnored: async () => 'ignored',
        trustWatchFolders: false, trustWatchEveryMs: 3_600_000, trustStore: { has: async () => false },
        elevate: async () => ({ ok: false, failed: null, error: 'fixture has no elevation window' }),
        liveStatusLink: { up: () => linked, onChange: listener => { frontChanges.add(listener); return () => { frontChanges.delete(listener); }; } },
    });
    await hosting.engineReconcile;
    const book = await ProcessBook.open(dir, { supervisor, envFor: () => ({ FIXTURE_SERVICE: 'owned' }), asleep: () => false });
    const scheduler = new ProcessScheduler({ book, supervisor, envFor: () => ({ FIXTURE_SERVICE: 'owned' }), asleep: () => false,
        nudge: () => false, now: () => Date.UTC(2026, 0, 1), schedule: () => () => {} });
    const registry = new Registry(new Store(dir)); await registry.load({ name: 'fixture-host', healthy: true });
    await registry.addWorkspace({ id: 'work', path: workspace });
    const visible = new Set(['work']);
    // Spies are ports from construction onward, so an adapter may bind them once. They call the real host methods.
    const hostingCalls = { engineStatuses: vi.fn(() => hosting.engineStatuses()), syncHosts: vi.fn(() => hosting.syncHosts()),
        retryFrontDoor: vi.fn(() => hosting.retryFrontDoor()) };
    const hostingApi = new Proxy(hosting, { get: (target, key) => key === 'engineStatuses' ? hostingCalls.engineStatuses
        : key === 'syncHosts' ? hostingCalls.syncHosts : key === 'retryFrontDoor' ? hostingCalls.retryFrontDoor : Reflect.get(target, key, target) });
    const service = new HostFeatures({ settings, knowledge, flows, inbox, attention, roster: () => [], resolveAddress: () => ({ kind: 'none' }),
        mailRefusal: () => null, workspaceIds: () => ['work'], runFlow: async () => {}, refreshPlugins: async () => {}, applyRemote: async () => {},
        hosting: { api: hostingApi, supervisor, processes: book, processScheduler: scheduler, workspaceVisible: id => visible.has(id), engineStatusWaitMs: 5 },
    });
    let windows = 0;
    const invokeWindow = vi.fn(async (method: RemoteMethod) => ({ windowAnswered: method }));
    const alone = hostAloneApi({ hostName: 'fixture-host', registry, settings, engine: () => null, cwdFor: () => workspace,
        startRefusal: () => null, models: { get: async () => ({ models: [] }) }, providerInstalled: () => true,
        windowConnected: () => windows > 0, attention, approvals: { resolve: () => true }, inbox, deliverToAgent: async () => true,
        terminals: { attach: () => null, write: () => true, resize: () => true, close: () => true, list: () => [], onData: () => () => {}, onExit: () => () => {} },
        takeOver: () => null, headroom: { view: () => ({}), subscribe: () => () => {} },
        files: { children: async () => null, open: async () => ({ ok: false }), readBytes: async () => ({ ok: false }), upload: async () => ({ ok: false }) },
        features: service,
    } as unknown as HostAlonePorts);
    const api = hostRemoteApi({ hostName: 'fixture-host', own: {}, alone, window: { connected: () => windows > 0, invoke: invokeWindow } });
    const offs: Array<() => void> = [];
    const outcome = (method: RemoteMethod, args: unknown[] = []) => api.invoke(method, args, groupTwoContext)
        .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }));
    const seedEngine = async (major = '17', scope: 'shared' | 'dedicated' = 'dedicated') => {
        const result = await hosting.engines.add({ engine: 'postgres', major,
            scope: scope === 'shared' ? { kind: 'shared' } : { kind: 'dedicated', workspaceId: 'work' }, workspaceId: 'work', consent: true });
        if (result.kind === 'needs-consent') throw new Error('fixture engine did not accept consent');
        return result.instance;
    };
    const seedSite = () => hosting.envelopeSites.create({ name: 'fixture', workspaceId: 'work', repoPath: workspace, serve: { mode: 'proxy' }, hostPort: 43123 });
    const seedProcess = (name = 'fixture queue') => book.create({ workspaceId: 'work', workspacePath: workspace, name, command: 'fixture-worker', restart: 'never' });
    const print = (data: string, id = opened.at(-1)!.id) => { for (const listener of output) listener(id, data); };
    const changes = () => {
        const snapshots: FeatureData[] = [], revisions: unknown[] = [];
        const off = api.onEvent((channel, data) => { if (channel === 'features') snapshots.push(data as FeatureData); if (channel === LOCAL_EVENTS.features) revisions.push(data); });
        offs.push(off); return { snapshots, revisions, off };
    };
    const close = async () => {
        for (const off of offs.splice(0)) off(); service.close(); scheduler.stop();
        for (const row of supervisor.list()) supervisor.stop(row.id);
        await scheduler.settled(); await hosting.shutdown(); knowledge.close();
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    };
    return { dir, workspace, service, api, outcome, settings, hosting, hostingCalls, supervisor, book, scheduler, docker, dockerCalls, opened, print,
        seedEngine, seedSite, seedProcess, changes, visible, close, invokeWindow, windows: (count: number) => { windows = count; },
        frontChanged: () => { linked = !linked; for (const listener of frontChanges) listener(); },
        envelope: async () => JSON.parse(await readFile(join(workspace, 'project.json'), 'utf8')) as Record<string, unknown>,
        bookFile: async () => JSON.parse(await readFile(join(dir, 'runtime', 'processes.json'), 'utf8')) as { processes: Array<{ id: string; wanted: boolean }> },
    };
}

export type GroupTwoFixture = Awaited<ReturnType<typeof groupTwoFixture>>;
