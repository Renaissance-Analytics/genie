import type { AppSourceKind } from '../core/app-inbox.js';
import type { WorkstationRole } from '../core/workstation-role.js';
import type { AppInboxCardState } from '../renderer/components/AppInboxCard.js';
import type { AppInboxDump } from './app-inbox-host.js';
import type { LocalOwnerDeps } from './host-api.js';
import { HOST_LOCAL_OWNER } from './host-local-watches.js';
import { thisMachineWorkstationIds } from './this-machine.js';
import { connectableWorkstations, setWorkstationRole } from './tynn-network.js';

/**
 * THE OWNER'S OPERATIONS, ANSWERED BY GENIE-HOST (Tynn #898 step 2d-3b): a workspace's Apps and scripts card, the device
 * hosts this machine remembers, "Your workstations" and a workstation's role change. Until now only window main answered
 * them, over replicas of these same parts; genie-host owns the parts (its app door, its device link, its Tynn account and
 * relay role), so it answers from them directly. At 2d-4 the window is served here.
 */

type TynnRequest = (path: string, init: { method: 'GET' | 'POST' | 'PUT'; body?: unknown }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** What a workspace's Apps and scripts card is read from: the door's view of its keys (main: the replica). */
export interface AppInboxView {
    url(): string | null;
    sources(workspaceId: string): AppInboxCardState['sources'];
    revokedSources(workspaceId: string): AppInboxCardState['revoked'];
    scriptKeys(workspaceId: string): AppInboxCardState['scriptKeys'];
}

/** The card's state: the door's URL, the workspace's switch (`app_inbox`), its sources, revoked sources and script keys. */
export function appInboxCardState(view: AppInboxView, enabled: boolean, workspaceId: string): AppInboxCardState {
    return { url: view.url(), enabled, sources: view.sources(workspaceId), revoked: view.revokedSources(workspaceId), scriptKeys: view.scriptKeys(workspaceId) };
}

/** genie-host's door's dump, read as the card reads a view. */
export function appInboxViewOfDump(dump: AppInboxDump): AppInboxView {
    const of = (id: string) => dump.workspaces[id];
    return {
        url: () => dump.url,
        sources: (id) => [...(of(id)?.sources ?? [])],
        revokedSources: (id) => [...(of(id)?.revoked ?? [])],
        scriptKeys: (id) => [...(of(id)?.scriptKeys ?? [])],
    };
}

export interface AppSourceRestartPorts {
    /** The workspace's sites start again with their new environment; the ids that did. */
    readonly serviceEnvChanged: (workspaceId: string) => readonly string[];
    /** The kept processes, once their book is open. */
    readonly processes: () => { status(id: string): { readonly state: string } | null; restart(id: string): Promise<unknown> } | null;
}

/** Rotate / Revoke / Allow restart the source so it starts with its new credential, or none; a stopped one at its next start. */
export async function restartAppSource(ports: AppSourceRestartPorts, workspaceId: string, kind: AppSourceKind, id: string): Promise<string> {
    if (kind === 'site') return ports.serviceEnvChanged(workspaceId).includes(id) ? 'restarted with it' : 'its next start uses it';
    const book = kind === 'process' ? ports.processes() : null;
    if (book) {
        const state = book.status(id)?.state;
        if (state === 'running' || state === 'restarting') { await book.restart(id); return 'restarted with it'; }
    }
    return 'its next start uses it';
}

export interface HostOwnerSources {
    readonly appInbox: {
        readonly door: { dump(): AppInboxDump; call(method: string, args: readonly unknown[]): Promise<unknown> };
        readonly enabled: (workspaceId: string) => boolean;
        readonly workspaceExists: (workspaceId: string) => boolean;
        readonly restart: AppSourceRestartPorts;
    };
    /** genie-host's device link (DeviceLinkService): its remembered hosts are the machine's, whoever asks. */
    readonly deviceLink: { call(owner: string, method: string, args: readonly unknown[]): Promise<unknown> };
    readonly tynn: {
        readonly account: () => { request: TynnRequest; host(): string; status(): { signedIn: boolean } } | null;
        readonly role: () => WorkstationRole | null;
        readonly readRole: () => Promise<void>;
        /** This launch's registration of this machine; null = not registered. */
        readonly registered: () => string | null;
        /** The identity genie-host stored for that Tynn. */
        readonly stored: (host: string) => Promise<string | null>;
        /** Genie 1's settings, from the database the window located; null = not known here. */
        readonly v1Settings: () => Readonly<Record<string, string>> | null;
    };
}

export type HostOwnerOps = Omit<LocalOwnerDeps, 'tynnNetwork'> & { readonly tynnNetwork: Omit<LocalOwnerDeps['tynnNetwork'], 'shares'> };

export function hostOwnerOps(sources: HostOwnerSources): HostOwnerOps {
    const { door } = sources.appInbox;
    const state = (workspaceId: string) => appInboxCardState(appInboxViewOfDump(door.dump()), sources.appInbox.enabled(workspaceId), workspaceId);
    const device = (method: string, args: readonly unknown[]) => sources.deviceLink.call(HOST_LOCAL_OWNER, method, args);
    const tynn = sources.tynn;
    const account = () => {
        const a = tynn.account();
        if (!a) throw new Error('this Genie has no Tynn account');
        return a;
    };
    /** Every Tynn identity this machine holds (this-machine.ts): "Your workstations" lists none of them. */
    const thisMachine = async (host: string) => thisMachineWorkstationIds({ registered: tynn.registered(), stored: await tynn.stored(host).catch(() => null), v1Settings: tynn.v1Settings() });
    return {
        appInbox: {
            state,
            workspaceExists: sources.appInbox.workspaceExists,
            createKey: async (workspaceId, name) => (await door.call('createScriptKey', [workspaceId, name])) as { id: string; token: string },
            scriptKeys: (workspaceId) => appInboxViewOfDump(door.dump()).scriptKeys(workspaceId),
            revokeKey: (keyId) => door.call('revokeScriptKey', [keyId]),
            rotate: (kind, id) => { void door.call('rotate', [kind, id]).catch(() => {}); },
            revokeSource: (source) => door.call('revokeSource', [source]),
            allowSource: (kind, id) => door.call('allowSource', [kind, id]),
            restartSource: (workspaceId, kind, id) => restartAppSource(sources.appInbox.restart, workspaceId, kind, id),
        },
        deviceLink: {
            hosts: async () => (await device('hosts', [])) as string[],
            forget: async (url) => (await device('forget', [url])) === true,
            adopt: async (url, token) => (await device('adopt', [url, token])) === true,
        },
        tynnNetwork: {
            hasAccount: () => tynn.account() !== null,
            signedIn: () => tynn.account()?.status().signedIn === true,
            role: () => tynn.role(),
            host: () => tynn.account()?.host() ?? null,
            workstations: async () => {
                const a = account();
                return connectableWorkstations((path, init) => a.request(path, init), await thisMachine(a.host()));
            },
            // Tynn decides a role change with a fresh authenticator code (genie#1278 W6).
            setRole: (workstationId, role, code) => { const a = account(); return setWorkstationRole((path, init) => a.request(path, init), workstationId, role, code); },
            rereadRole: () => { void tynn.readRole().catch(() => {}); },
        },
    };
}
