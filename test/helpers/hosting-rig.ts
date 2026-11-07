import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { ProcessTree } from '../../src/core/process-tree.js';
import { BROWSER_LINK_LABEL } from '../../src/core/engine-protocol.js';
import { memoryPair } from '../../src/core/line-transport.js';
import type { PrivilegedStep } from '../../src/main/elevate.js';
import { composeHosting, type HostingOptions, type HostingStack } from '../../src/main/hosting-compose.js';
import { HostingService, WindowElevation } from '../../src/main/hosting-host.js';
import { ProcessSupervisor } from '../../src/main/process-supervisor.js';
import type { DockerRunner } from '../../src/main/service-driver.js';
import { SessionEngineClient } from '../../src/main/session-engine-client.js';
import { SessionEngineServer } from '../../src/main/session-engine-server.js';
import { SessionHost } from '../../src/main/session-host.js';
import type { ClientTransport } from '../../src/core/remote-protocol.js';
import type { PtyOpened, PtyPort, PtySpawnOptions } from '../../src/main/terminal-host.js';

/**
 * genie-host's hosting, for a test: a real composeHosting stack under a supervisor on a fake pty, behind HostingService on
 * a real SessionEngineServer, and windows that connect to it over a memory pair (P5a). Docker, the hosts file, the trust
 * store and the front door's ports are fakes; nothing privileged runs and no browser opens.
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
    window(options?: { local?: boolean; client?: ConstructorParameters<typeof SessionEngineClient>[0]; /** The Genie browser's process: it says so, and answers no elevation. */ browser?: boolean }): Promise<{ client: SessionEngineClient; replica: ReturnType<SessionEngineClient['hosting']>; close: () => void; /** Every frame this window received. */ frames: string[] }>;
    close(): Promise<void>;
}

export async function hostingRig(options: { appEnv?: (source: { readonly kind: 'site' | 'process'; readonly id: string; readonly name: string; readonly workspaceId: string }) => Readonly<Record<string, string>>; home?: string; docker?: DockerRunner; workspaces?: (ws: string) => Array<{ id: string; path: string }>; hosting?: Partial<HostingOptions>; server?: Partial<ConstructorParameters<typeof SessionEngineServer>[0]> } = {}): Promise<HostingRig> {
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
    const service = new HostingService(stack, { workspaces: () => workspaces.map((w) => w.id), elevation, onChange: (l) => supervisor.onChange(() => l()) });
    server = new SessionEngineServer({ token: TOKEN, build: 't', hosting: service, ...options.server });
    const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
    server.attach(new SessionHost({ userData: home, driverFor: () => null, processTree: noProcessTree, ...server.hostOptions() }));
    const elevationsAsked: Array<readonly PrivilegedStep[]> = [];
    const theServer = server;
    return {
        stack, supervisor, server: theServer, ws, home, elevationsAsked, opened,
        window: async (w = {}) => {
            const [h, raw] = memoryPair();
            theServer.accept(h, { local: w.local ?? true });
            const frames: string[] = [];
            const t: ClientTransport = { send: (m) => raw.send(m), onMessage: (l) => raw.onMessage((m) => { frames.push(m); l(m); }), onClose: (l) => raw.onClose(l), close: () => raw.close() };
            const client = new SessionEngineClient(w.browser ? { label: BROWSER_LINK_LABEL, ...w.client } : { elevate: async (steps) => { elevationsAsked.push(steps); return { ok: true }; }, ...w.client });
            expect(await client.connect(t, TOKEN)).toMatchObject({ ok: true });
            return { client, replica: client.hosting(), close: () => t.close(), frames };
        },
        close: async () => {
            await stack.shutdown();
            await rm(home, { recursive: true, force: true });
            await rm(ws, { recursive: true, force: true });
        },
    };
}
