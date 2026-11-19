import type { AppSourceKind } from '../core/app-inbox.js';
import type { WorkstationRole } from '../core/workstation-role.js';
import type { AppInboxCardState } from '../renderer/components/AppInboxCard.js';
import type { AppInboxDump } from './app-inbox-host.js';
import type { LocalOwnerDeps } from './host-api.js';

/** RED STUB (Tynn #898 step 2d-3b): the shapes only; every function says it is not built. */
const NOT_BUILT = '2d-3b: not built';

type TynnRequest = (path: string, init: { method: 'GET' | 'POST' | 'PUT'; body?: unknown }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** What a workspace's Apps and scripts card is read from: the door's view of its keys. */
export interface AppInboxView {
    url(): string | null;
    sources(workspaceId: string): AppInboxCardState['sources'];
    revokedSources(workspaceId: string): AppInboxCardState['revoked'];
    scriptKeys(workspaceId: string): AppInboxCardState['scriptKeys'];
}

export function appInboxCardState(_view: AppInboxView, _enabled: boolean, _workspaceId: string): AppInboxCardState {
    throw new Error(NOT_BUILT);
}

export function appInboxViewOfDump(_dump: AppInboxDump): AppInboxView {
    throw new Error(NOT_BUILT);
}

export interface AppSourceRestartPorts {
    /** The workspace's sites start again with their new environment; the ids that did. */
    readonly serviceEnvChanged: (workspaceId: string) => readonly string[];
    /** The kept processes, once their book is open. */
    readonly processes: () => { status(id: string): { readonly state: string } | null; restart(id: string): Promise<unknown> } | null;
}

export async function restartAppSource(_ports: AppSourceRestartPorts, _workspaceId: string, _kind: AppSourceKind, _id: string): Promise<string> {
    throw new Error(NOT_BUILT);
}

export interface HostOwnerSources {
    readonly appInbox: {
        readonly door: { dump(): AppInboxDump; call(method: string, args: readonly unknown[]): Promise<unknown> };
        readonly enabled: (workspaceId: string) => boolean;
        readonly workspaceExists: (workspaceId: string) => boolean;
        readonly restart: AppSourceRestartPorts;
    };
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

export function hostOwnerOps(_sources: HostOwnerSources): HostOwnerOps {
    throw new Error(NOT_BUILT);
}
