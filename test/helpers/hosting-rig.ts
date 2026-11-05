import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { ProcessTree } from '../../src/core/process-tree.js';
import { memoryPair } from '../../src/core/line-transport.js';
import type { PrivilegedStep } from '../../src/main/elevate.js';
import { composeHosting, type HostingOptions, type HostingStack } from '../../src/main/hosting-compose.js';
import { HostingService, WindowElevation } from '../../src/main/hosting-host.js';
import { ProcessSupervisor } from '../../src/main/process-supervisor.js';
import type { DockerRunner } from '../../src/main/service-driver.js';
import { SessionEngineClient } from '../../src/main/session-engine-client.js';
import { SessionEngineServer } from '../../src/main/session-engine-server.js';
import { SessionHost } from '../../src/main/session-host.js';
import type { PtyOpened, PtyPort } from '../../src/main/terminal-host.js';

/**
 * genie-host's hosting, for a test: a real composeHosting stack under a supervisor on a fake pty, behind HostingService on
 * a real SessionEngineServer, and windows that connect to it over a memory pair (P5a). Docker, the hosts file, the trust
 * store and the front door's ports are fakes; nothing privileged runs and no browser opens.
 */

export const TOKEN = 'hosting-token';
export const tick = async (n = 10) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 2)); };

function fakePty(): PtyPort {
    let n = 0;
    return {
        open(o) { n += 1; return { id: `term_${n}`, pid: 4000 + n, shell: o.command ?? '', scrollback: '' } satisfies PtyOpened; },
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
        onData: () => () => {}, onExit: () => () => {},
    };
}

export interface HostingRig {
    readonly stack: HostingStack;
    readonly supervisor: ProcessSupervisor;
    readonly server: SessionEngineServer;
    readonly ws: string;
    readonly elevationsAsked: Array<readonly PrivilegedStep[]>;
    /** A window: a LOCAL one by default (the host's own endpoint), or `local: false` for any other transport. */
    window(options?: { local?: boolean; client?: ConstructorParameters<typeof SessionEngineClient>[0] }): Promise<{ client: SessionEngineClient; replica: ReturnType<SessionEngineClient['hosting']>; close: () => void }>;
    close(): Promise<void>;
}

export async function hostingRig(options: { docker?: DockerRunner; workspaces?: (ws: string) => Array<{ id: string; path: string }>; hosting?: Partial<HostingOptions>; server?: Partial<ConstructorParameters<typeof SessionEngineServer>[0]> } = {}): Promise<HostingRig> {
    const home = mkdtempSync(join(tmpdir(), 'hosting-rig-'));
    const ws = mkdtempSync(join(tmpdir(), 'hosting-rig-ws-'));
    writeFileSync(join(ws, 'project.json'), `${JSON.stringify({ name: 'shop' }, null, 2)}\n`);
    const supervisor = new ProcessSupervisor(fakePty(), { now: () => 1_000, schedule: () => () => {} });
    let server: SessionEngineServer | null = null;
    const elevation = new WindowElevation({ connected: () => server?.windowConnected() ?? false, ask: (steps) => server!.elevate(steps), now: () => 7 });
    const workspaces = options.workspaces?.(ws) ?? [{ id: 'ws', path: ws }];
    const stack = await composeHosting({
        userData: home,
        supervisor,
        settings: { onChange: () => () => {} },
        appEnv: () => ({}),
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
        stack, supervisor, server: theServer, ws, elevationsAsked,
        window: async (w = {}) => {
            const [h, t] = memoryPair();
            theServer.accept(h, { local: w.local ?? true });
            const client = new SessionEngineClient({ elevate: async (steps) => { elevationsAsked.push(steps); return { ok: true }; }, ...w.client });
            expect(await client.connect(t, TOKEN)).toMatchObject({ ok: true });
            return { client, replica: client.hosting(), close: () => t.close() };
        },
        close: async () => {
            await stack.shutdown();
            await rm(home, { recursive: true, force: true });
            await rm(ws, { recursive: true, force: true });
        },
    };
}
