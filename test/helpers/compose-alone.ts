import type { OwnAgentStores } from '../../src/main/agent-stores-api.js';
import { openAgentStores } from '../../src/main/agent-stores-open.js';
import { ApprovalQueue } from '../../src/main/approval-queue.js';
import { composeWith, type ComposeAlone, type ComposedServices, type ComposeInput } from '../../src/main/compose.js';
import { startFlowsEngine } from '../../src/main/flows-engine.js';
import { FlowStore } from '../../src/main/flow-store.js';
import { composeHosting } from '../../src/main/hosting-compose.js';
import type { ServerTransport } from '../../src/core/remote-protocol.js';
import { ProcessSupervisor } from '../../src/main/process-supervisor.js';
import { hostRemoteApi, RemoteAccessHost, RemoteAccessService } from '../../src/main/remote-access-host.js';
import { RemoteAccessReplica } from '../../src/main/remote-access-replica.js';
import { SettingsStore } from '../../src/main/settings-store.js';
import type { PtyPort } from '../../src/main/terminal-host.js';

/**
 * GENIE-HOST'S REMOTE ACCESS, AS A TEST THAT COMPOSES ALONE READS IT (Tynn #898 step 2d-4b2). A client serves no remote
 * connection; the window reads and drives genie-host's remote access through its replica. Here the replica calls a real
 * RemoteAccessService over a real RemoteAccessHost, opened under the test's own folder on first use only, so a test that
 * never touches remote access opens nothing. `close` waits for its private writes (call it before the folder goes).
 */
export function remoteAccessAlone(home: string, now: () => number = Date.now, host: { readonly hostName: string; readonly transport: ServerTransport } = { hostName: 'test-host', transport: { onConnection: () => () => {} } }): { replica: RemoteAccessReplica; access(): Promise<RemoteAccessHost>; close(): Promise<void> } {
    let opening: Promise<{ access: RemoteAccessHost; service: RemoteAccessService }> | null = null;
    const replica: RemoteAccessReplica = new RemoteAccessReplica(host.hostName, async (method, args) => (await open()).service.call('test-window', method, args));
    const open = () => opening ??= RemoteAccessHost.open({
        home, hostName: host.hostName, now,
        transport: host.transport,
        api: hostRemoteApi({ hostName: host.hostName, own: {} }),
    }).then((access) => ({
        access,
        service: new RemoteAccessService(access, {
            switch: { apply: async () => {}, restart: async () => {}, stop: async () => {} },
            send: (_owner, event) => replica.deliver(event),
        }),
    }));
    return {
        replica,
        access: async () => (await open()).access,
        close: async () => { if (opening) await (await opening).access.close(); },
    };
}

/**
 * A TEST THAT COMPOSES ALONE: the stores agents write to, the flows, the supervisor and a real hosting stack, opened here
 * for the test. The app never does this; the window composes against genie-host's (composeWindowServices, Tynn #584,
 * #594). Remote access is genie-host's always: a test that drives it hands in its own replica (`remoteAccess`); any other
 * gets `remoteAccessAlone`, closed when the services shut down. `remoteHost` names that host and where its connections
 * come from (a test that pairs a device or admits a Pilot): it is opened at once and read, as main reads it at link-up.
 */
export async function composeServices(input: Omit<ComposeInput, 'alone' | 'remoteAccess'> & { /** The pty engine of the supervisor this test runs itself; `processPty` when it is another (the spawn host's). compose reads neither (Tynn #1043). */ readonly pty: PtyPort; readonly processPty?: PtyPort; readonly remoteAccess?: ComposeInput['remoteAccess']; readonly remoteHost?: { readonly hostName: string; readonly transport: ServerTransport } }): Promise<ComposedServices<OwnAgentStores>> {
    const now = input.now ?? Date.now;
    const iso = () => new Date(now()).toISOString();
    const alone: ComposeAlone = {
        openSettings: () => SettingsStore.open(input.userData, iso),
        openStores: (limits) => openAgentStores(input.userData, iso, input.inboxSession, limits),
        openFlows: () => FlowStore.open(input.userData, now),
        startFlows: startFlowsEngine,
        supervisor: () => new ProcessSupervisor(input.processPty ?? input.pty, { now, schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } }, input.pidAlive ? { pidAlive: input.pidAlive } : {}),
        approvals: (options) => new ApprovalQueue(options),
    };
    const own = input.remoteAccess ? null : remoteAccessAlone(input.userData, now, input.remoteHost);
    if (own && input.remoteHost) await own.replica.refresh();
    const services = (await composeWith({ ...input, remoteAccess: input.remoteAccess ?? own!.replica, buildOwnHosting: composeHosting, alone })) as ComposedServices<OwnAgentStores>;
    if (!own) return services;
    const shutdown = services.shutdown.bind(services);
    return Object.assign(services, { shutdown: async () => { try { await shutdown(); } finally { await own.close(); } } });
}
