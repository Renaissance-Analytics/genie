import type { LocalFramePort } from '../core/local-frame.js';
import type { GenieBridge, LocalOwnerBridge } from './bridge.js';
import { localTransport } from './local-transport.js';
import { connectRemote, type RemoteClient } from './remote-bridge.js';

export type WorkspaceProtocolKey = 'listRepos' | 'addRepo' | 'removeRepo' | 'removeRepoLock' | 'locateRepo' | 'commitsSince'
    | 'settings' | 'setSetting' | 'resetSetting' | 'setGoverns' | 'setDefaultAgent' | 'setColor' | 'onSettingsChanged'
    | 'previewAdd' | 'confirmAdd' | 'create' | 'previewAddFromGit' | 'confirmAddFromGit' | 'readSource'
    | 'stageFromGit' | 'registerExisting' | 'buildEnvelope' | 'discardStaged' | 'githubRepos' | 'tynnProjects'
    | 'tynnOwnerOptions' | 'createTynnProject' | 'importedAgents' | 'adoptAgent' | 'previewAddFromTynn' | 'confirmAddFromTynn';
type Workspaces = GenieBridge['workspaces'];
type Agents = GenieBridge['agents'];
type HostFamily = Required<Pick<GenieBridge, 'updates' | 'activity' | 'onHeadroom' | 'accountRetry'>>;
type Refusal = { ok: false; reason: string };
type Connected = { ok: true } | Refusal;

export interface LocalProtocolState {
    readonly phase: 'starting' | 'ready' | 'failed';
    readonly reason: string | null;
    /** Successful manual recovery refreshes moved reads without replacing the shared bridge. */
    readonly revision: number;
}
export interface LocalProtocolControl {
    state(): LocalProtocolState;
    onState(listener: () => void): () => void;
    retry(): void;
}

const STARTING = 'Genie is still starting';
const ATTEMPTS = 5;
const BACKOFF_MS = 250;

/** One session per pageBridge. Only moved calls wait for it; unmoved preload methods remain available. */
export function localSession(port: LocalFramePort | undefined): { control: LocalProtocolControl; workspaces: Pick<Workspaces, WorkspaceProtocolKey>; agents: Agents; owner: LocalOwnerBridge } & HostFamily {
    let state: LocalProtocolState = { phase: 'starting', reason: null, revision: 0 };
    const listeners = new Set<() => void>();
    const settingsListeners = new Set<(id: string) => void>();
    let client: RemoteClient | null = null;
    let offState = () => {};
    let offSettings = () => {};
    const subscriptions = new Set<{ start: (bridge: GenieBridge) => () => void; off: () => void }>();
    const subscribe = (start: (bridge: GenieBridge) => () => void): (() => void) => {
        const entry = { start, off: () => {} };
        subscriptions.add(entry);
        if (client && state.phase === 'ready') entry.off = start(client.bridge);
        return () => { entry.off(); entry.off = () => {}; subscriptions.delete(entry); };
    };
    const update = (next: LocalProtocolState) => {
        state = next;
        for (const listener of listeners) listener();
    };
    const release = () => {
        offSettings(); offSettings = () => {};
        offState(); offState = () => {};
        for (const entry of subscriptions) { entry.off(); entry.off = () => {}; }
        const previous = client;
        client = null;
        previous?.close();
    };
    const fail = (reason: string): Refusal => {
        release();
        update({ ...state, phase: 'failed', reason });
        return { ok: false, reason };
    };
    const start = async (manual: boolean): Promise<Connected> => {
        update({ ...state, phase: 'starting', reason: null });
        if (!port) return fail('This Genie window has no local protocol connection.');
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
            try {
                client = connectRemote(localTransport(port), { kind: 'local' }, 'this window');
                const result = await client.ready;
                if (result.ok) {
                    const connected = client;
                    offSettings = connected.bridge.workspaces.onSettingsChanged!((id) => { for (const listener of settingsListeners) listener(id); });
                    offState = connected.onState((next) => {
                        if (!next.connected && client === connected) fail('The connection to Genie closed. Retry to reconnect.');
                    });
                    for (const entry of subscriptions) entry.off = entry.start(connected.bridge);
                    update({ phase: 'ready', reason: null, revision: state.revision + (manual ? 1 : 0) });
                    return result;
                }
                release();
                if (result.reason !== STARTING || attempt === ATTEMPTS - 1) return fail(result.reason);
            } catch (error) {
                return fail(error instanceof Error ? error.message : String(error));
            }
            await new Promise<void>((resolve) => setTimeout(resolve, BACKOFF_MS));
        }
        return fail(STARTING);
    };
    let ready = start(false);
    const requestBridge = async <T>(call: (bridge: GenieBridge) => Promise<T>): Promise<T | Refusal> => {
        if (state.phase === 'failed') return { ok: false, reason: state.reason! };
        const result = await ready;
        if (!result.ok) return result;
        if (!client || state.phase !== 'ready') return { ok: false, reason: state.reason ?? 'The connection to Genie closed. Retry to reconnect.' };
        return call(client.bridge);
    };
    const request = <T>(call: (ws: Workspaces) => Promise<T>) => requestBridge((bridge) => call(bridge.workspaces));
    const requestAgent = <T>(call: (agents: Agents) => Promise<T>) => requestBridge((bridge) => call(bridge.agents));
    // Reads/actions that rejected over IPC must also reject on startup or connection failure.
    // Checking connection state separately avoids mistaking an actual host value for a refusal.
    const read = async <T>(call: (bridge: GenieBridge) => Promise<T>): Promise<T> => {
        if (state.phase === 'failed') throw new Error(state.reason!);
        const result = await ready;
        if (!result.ok) throw new Error(result.reason);
        if (!client || state.phase !== 'ready') throw new Error(state.reason ?? 'The connection to Genie closed. Retry to reconnect.');
        return call(client.bridge);
    };
    // The same admitted local client, with the same read/rejection and recovery semantics as the other moved families.
    const ownerRead = <T>(call: (owner: LocalOwnerBridge) => Promise<T>): Promise<T> => read(() => call(client!.localOwner!));
    return {
        owner: {
            appInbox: {
                state: (id) => ownerRead(b => b.appInbox.state(id)),
                createKey: (id, name) => ownerRead(b => b.appInbox.createKey(id, name)),
                revokeKey: (id, key) => ownerRead(b => b.appInbox.revokeKey(id, key)),
                source: (id, op, kind, source) => ownerRead(b => b.appInbox.source(id, op, kind, source)),
            },
            deviceLink: {
                hosts: () => ownerRead(b => b.deviceLink.hosts()),
                forget: (url) => ownerRead(b => b.deviceLink.forget(url)),
                adopt: (url, token) => ownerRead(b => b.deviceLink.adopt(url, token)),
            },
            tynnNetwork: {
                workstations: () => ownerRead(b => b.tynnNetwork.workstations()),
                setRole: (id, role, code) => ownerRead(b => b.tynnNetwork.setRole!(id, role, code)),
                shares: {
                    list: (id) => ownerRead(b => b.tynnNetwork.shares!.list(id)),
                    mint: (input) => ownerRead(b => b.tynnNetwork.shares!.mint(input)),
                    revoke: (id) => ownerRead(b => b.tynnNetwork.shares!.revoke(id)),
                },
            },
        },
        control: {
            state: () => state,
            onState: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            retry: () => { if (state.phase === 'failed') ready = start(true); },
        },
        updates: {
            state: () => read((bridge) => bridge.updates.state()),
            check: () => read((bridge) => bridge.updates.check()),
            download: () => read((bridge) => bridge.updates.download()),
            install: () => read((bridge) => bridge.updates.install()),
            notes: () => read((bridge) => bridge.updates.notes!()),
            subscribe: (listener) => subscribe((bridge) => bridge.updates.subscribe(listener)),
        },
        activity: {
            feeds: (id) => read((bridge) => bridge.activity!.feeds(id)),
            subscribe: (listener) => subscribe((bridge) => bridge.activity!.subscribe(listener)),
        },
        onHeadroom: (listener) => subscribe((bridge) => bridge.onHeadroom!(listener)),
        accountRetry: (id) => requestBridge((bridge) => bridge.accountRetry!(id)),
        agents: {
            restart: (id, kind) => requestAgent((agents) => agents.restart(id, kind)),
            previewDelete: (id, outcome, also) => requestAgent((agents) => agents.previewDelete(id, outcome, also)),
            delete: (id, outcome, also, handoff) => requestAgent((agents) => agents.delete(id, outcome, also, handoff)),
            switchDriver: (id, to) => requestAgent((agents) => agents.switchDriver(id, to)),
            setBudget: (id, usd) => requestAgent((agents) => agents.setBudget(id, usd)),
            setMode: (id, mode) => requestAgent((agents) => agents.setMode(id, mode)),
            setAccessScope: (id, scope) => requestAgent((agents) => agents.setAccessScope(id, scope)),
            setAutoApprove: (id, on) => requestAgent((agents) => agents.setAutoApprove(id, on)),
            setManageTabs: (id, on) => requestAgent((agents) => agents.setManageTabs(id, on)),
            setDrivePages: (id, on) => requestAgent((agents) => agents.setDrivePages(id, on)),
            setIssueWatch: (id, setting) => requestAgent((agents) => agents.setIssueWatch(id, setting)),
            setPermissions: (id, permissions) => requestAgent((agents) => agents.setPermissions(id, permissions)),
            setModel: (id, model) => requestAgent((agents) => agents.setModel(id, model)),
            models: (id, refresh) => requestAgent((agents) => agents.models!(id, refresh)),
            diagnose: (id) => requestAgent((agents) => agents.diagnose(id)),
        },
        workspaces: {
            previewAdd: (path) => request((ws) => ws.previewAdd(path)),
            confirmAdd: (path) => request((ws) => ws.confirmAdd(path)),
            create: (name, parent, remote, project) => request((ws) => ws.create!(name, parent, remote, project)),
            previewAddFromGit: (url, parent) => request((ws) => ws.previewAddFromGit(url, parent)),
            confirmAddFromGit: (url, parent) => request((ws) => ws.confirmAddFromGit(url, parent)),
            readSource: (path) => request((ws) => ws.readSource!(path)),
            stageFromGit: (url) => request((ws) => ws.stageFromGit!(url)),
            registerExisting: (path) => request((ws) => ws.registerExisting!(path)),
            buildEnvelope: (plan, remote) => request((ws) => ws.buildEnvelope!(plan, remote)),
            discardStaged: (path) => request((ws) => ws.discardStaged!(path)),
            githubRepos: async () => {
                const result = await request((ws) => ws.githubRepos!());
                // The repository picker renders RepoListing, including during local startup failure.
                if (result !== null && 'ok' in result) return { status: 'failed', message: result.reason };
                return result;
            },
            tynnProjects: () => request((ws) => ws.tynnProjects()),
            tynnOwnerOptions: () => request((ws) => ws.tynnOwnerOptions!()),
            createTynnProject: (input) => request((ws) => ws.createTynnProject!(input)),
            importedAgents: (id) => request((ws) => ws.importedAgents!(id)),
            adoptAgent: (id, name) => request((ws) => ws.adoptAgent!(id, name)),
            previewAddFromTynn: (project, parent) => request((ws) => ws.previewAddFromTynn(project, parent)),
            confirmAddFromTynn: (parent, project) => request((ws) => ws.confirmAddFromTynn(parent, project)),
            listRepos: (id) => request((ws) => ws.listRepos(id)),
            addRepo: (id, input) => request((ws) => ws.addRepo(id, input)),
            removeRepo: (id, slug) => request((ws) => ws.removeRepo(id, slug)),
            removeRepoLock: (id, slug) => request((ws) => ws.removeRepoLock(id, slug)),
            locateRepo: (id, slug, path) => request((ws) => ws.locateRepo(id, slug, path)),
            commitsSince: (id, since) => request((ws) => ws.commitsSince(id, since)),
            settings: (id) => request((ws) => ws.settings(id)),
            setSetting: (id, key, value) => request((ws) => ws.setSetting(id, key, value)),
            resetSetting: (id, key) => request((ws) => ws.resetSetting(id, key)),
            setGoverns: (id, children) => request((ws) => ws.setGoverns(id, children)),
            setDefaultAgent: (id, agentId) => request((ws) => ws.setDefaultAgent(id, agentId)),
            setColor: (id, color) => request((ws) => ws.setColor!(id, color)),
            onSettingsChanged: (listener) => { settingsListeners.add(listener); return () => { settingsListeners.delete(listener); }; },
        },
    };
}
