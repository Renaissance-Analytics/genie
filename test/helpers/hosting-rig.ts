import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { CallContext } from '../../src/core/remote-protocol.js';
import type { ProcessTree } from '../../src/core/process-tree.js';
import { BROWSER_LINK_LABEL } from '../../src/core/engine-protocol.js';
import { memoryPair } from '../../src/core/line-transport.js';
import type { PrivilegedStep } from '../../src/main/elevate.js';
import { AttentionStore } from '../../src/main/attention-store.js';
import type { WorkspaceRef } from '../../src/main/envelope-sites-host.js';
import { HostFeatures } from '../../src/main/features-host.js';
import { FlowStore } from '../../src/main/flow-store.js';
import { composeHosting, type HostingOptions, type HostingStack } from '../../src/main/hosting-compose.js';
import { WindowElevation } from '../../src/main/hosting-host.js';
import { InboxStore } from '../../src/main/inbox-store.js';
import { KnowledgeStore } from '../../src/main/knowledge-store.js';
import { ProcessBook } from '../../src/main/process-book.js';
import { ProcessSupervisor } from '../../src/main/process-supervisor.js';
import { SettingsStore } from '../../src/main/settings-store.js';
import type { DockerRunner } from '../../src/main/service-driver.js';
import { SessionEngineClient } from '../../src/main/session-engine-client.js';
import { SessionEngineServer } from '../../src/main/session-engine-server.js';
import { SessionHost } from '../../src/main/session-host.js';
import type { ClientTransport } from '../../src/core/remote-protocol.js';
import type { PtyOpened, PtyPort, PtySpawnOptions } from '../../src/main/terminal-host.js';
import type { FeatureAction, FeatureData } from '../../src/renderer/features.js';

/**
 * genie-host's hosting, for a test: a real composeHosting stack under a supervisor on a fake pty, whose elevations are asked
 * of the windows of a real SessionEngineServer, which connect to it over a memory pair (P5a). What a window reads of the
 * hosting and does to it goes over the protocol since 2g-4d E2b (Tynn #955): `features()` is genie-host's HostFeatures over
 * this same stack — what features.snapshot and features.act answer. Docker, the hosts file, the trust store and the front
 * door's ports are fakes; nothing privileged runs and no browser opens.
 */

export const TOKEN = 'hosting-token';
export const tick = async (n = 10) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 2)); };

function fakePty(opened: PtySpawnOptions[]): PtyPort {
    let n = 0;
    return {
        open(o) { n += 1; opened.push(o); return { id: `term_${n}`, pid: 4000 + n, shell: o.command ?? '', scrollback: '' } satisfies PtyOpened; },
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
        onData: () => () => {}, onExit: () => () => {},
    };
}

/** genie-host's features over the rig's hosting, as a local window's features.snapshot and features.act reach them. */
export interface RigFeatures {
    snapshot(): Promise<FeatureData>;
    act(action: FeatureAction): Promise<FeatureData>;
}

/** A local window's protocol connection, as genie-host admits it (protocol-tunnels.ts: this machine's own window). */
const WINDOW_CONTEXT: CallContext = Object.freeze({ connectionId: 'hosting-rig-window', origin: 'local-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'this Genie window' });

export interface HostingRig {
    readonly stack: HostingStack;
    readonly supervisor: ProcessSupervisor;
    readonly server: SessionEngineServer;
    readonly ws: string;
    /** Genie's home for this host: a NEXT host on the same home is the same machine after a restart. */
    readonly home: string;
    readonly elevationsAsked: Array<readonly PrivilegedStep[]>;
    /** Every process the host's supervisor opened, with its env. */
    readonly opened: PtySpawnOptions[];
    /** A window: a LOCAL one by default (the host's own endpoint), or `local: false` for any other transport. */
    window(options?: { local?: boolean; client?: ConstructorParameters<typeof SessionEngineClient>[0]; /** The Genie browser's process: it says so, and answers no elevation. */ browser?: boolean }): Promise<{ client: SessionEngineClient; close: () => void; /** Every frame this window received. */ frames: string[] }>;
    /** genie-host's HostFeatures over this hosting (made on first use): what a window's Hosting and Services tabs read and do. */
    features(): Promise<RigFeatures>;
    close(): Promise<void>;
}

export async function hostingRig(options: { appEnv?: (source: { readonly kind: 'site' | 'process'; readonly id: string; readonly name: string; readonly workspaceId: string }) => Readonly<Record<string, string>>; home?: string; docker?: DockerRunner; workspaces?: (ws: string) => WorkspaceRef[]; hosting?: Partial<HostingOptions>; server?: Partial<ConstructorParameters<typeof SessionEngineServer>[0]> } = {}): Promise<HostingRig> {
    const home = options.home ?? mkdtempSync(join(tmpdir(), 'hosting-rig-'));
    const ws = mkdtempSync(join(tmpdir(), 'hosting-rig-ws-'));
    writeFileSync(join(ws, 'project.json'), `${JSON.stringify({ name: 'shop' }, null, 2)}\n`);
    const opened: PtySpawnOptions[] = [];
    const supervisor = new ProcessSupervisor(fakePty(opened), { now: () => 1_000, schedule: () => () => {} });
    let server: SessionEngineServer | null = null;
    const elevation = new WindowElevation({ connected: () => server?.windowConnected() ?? false, ask: (steps) => server!.elevate(steps), now: () => 7 });
    const workspaces = options.workspaces?.(ws) ?? [{ id: 'ws', path: ws }];
    const stack = await composeHosting({
        userData: home,
        supervisor,
        settings: { onChange: () => () => {} },
        appEnv: options.appEnv ?? (() => ({})),
        caddyBin: '/opt/genie/runtime/caddy',
        frontDoorPort: 0,
        docker: options.docker ?? (async () => ({ stdout: '', exitCode: 1 })),
        hostsIo: { read: async () => '', write: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }, stage: async () => ({ command: 'cp', args: [] }) },
        elevate: (steps) => elevation.run(steps),
        hostsDebounceMs: 1,
        frontDoorPorts: { probe: async () => 'free', holder: async () => null },
        trustStore: { has: async () => false },
        gitIgnored: async () => 'ignored',
        workspaces: () => workspaces,
        ...options.hosting,
    });
    server = new SessionEngineServer({ token: TOKEN, build: 't', ...options.server });
    const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
    server.attach(new SessionHost({ userData: home, driverFor: () => null, processTree: noProcessTree, ...server.hostOptions() }));
    const elevationsAsked: Array<readonly PrivilegedStep[]> = [];
    const theServer = server;
    let made: Promise<{ features: RigFeatures; close: () => Promise<void> }> | null = null;
    const makeFeatures = async () => {
        const settings = await SettingsStore.open(home);
        const knowledge = KnowledgeStore.open(home);
        const inbox = await InboxStore.open(home);
        const flows = await FlowStore.open(home);
        const attention = await AttentionStore.open(home, inbox);
        const book = await ProcessBook.open(home, { supervisor, envFor: () => ({}), asleep: () => false });
        const service = new HostFeatures({
            settings, knowledge, flows, inbox, attention, roster: () => [], resolveAddress: () => ({ kind: 'none' }) as never,
            mailRefusal: () => null, workspaceIds: () => workspaces.map((w) => w.id), runFlow: async () => {}, refreshPlugins: async () => {}, applyRemote: async () => {},
            hosting: { api: stack, supervisor, processes: book, processScheduler: { runNow: async () => {} } as never, workspaceVisible: () => true, engineStatusWaitMs: 5 },
        });
        return {
            features: { snapshot: () => service.snapshot(WINDOW_CONTEXT), act: (action: FeatureAction) => service.act(action, WINDOW_CONTEXT) },
            close: async () => { service.close(); knowledge.close(); },
        };
    };
    return {
        stack, supervisor, server: theServer, ws, home, elevationsAsked, opened,
        window: async (w = {}) => {
            const [h, raw] = memoryPair();
            theServer.accept(h, { local: w.local ?? true });
            const frames: string[] = [];
            const t: ClientTransport = { send: (m) => raw.send(m), onMessage: (l) => raw.onMessage((m) => { frames.push(m); l(m); }), onClose: (l) => raw.onClose(l), close: () => raw.close() };
            const client = new SessionEngineClient(w.browser ? { label: BROWSER_LINK_LABEL, ...w.client } : { elevate: async (steps) => { elevationsAsked.push(steps); return { ok: true }; }, ...w.client });
            expect(await client.connect(t, TOKEN)).toMatchObject({ ok: true });
            return { client, close: () => t.close(), frames };
        },
        features: async () => (await (made ??= makeFeatures())).features,
        close: async () => {
            if (made) await (await made).close();
            await stack.shutdown();
            await rm(home, { recursive: true, force: true });
            await rm(ws, { recursive: true, force: true });
        },
    };
}
