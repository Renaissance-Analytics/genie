import type { LocalFramePort } from '../core/local-frame.js';
import type { GenieBridge } from './bridge.js';
import { localTransport } from './local-transport.js';
import { connectRemote, type RemoteClient } from './remote-bridge.js';

export type WorkspaceProtocolKey = 'listRepos' | 'addRepo' | 'removeRepo' | 'removeRepoLock' | 'locateRepo' | 'commitsSince'
    | 'settings' | 'setSetting' | 'resetSetting' | 'setGoverns' | 'setDefaultAgent' | 'setColor' | 'onSettingsChanged'
    | 'previewAdd' | 'confirmAdd' | 'create' | 'previewAddFromGit' | 'confirmAddFromGit' | 'readSource'
    | 'stageFromGit' | 'registerExisting' | 'buildEnvelope' | 'discardStaged' | 'githubRepos' | 'tynnProjects'
    | 'tynnOwnerOptions' | 'createTynnProject' | 'importedAgents' | 'adoptAgent' | 'previewAddFromTynn' | 'confirmAddFromTynn';
type Workspaces = GenieBridge['workspaces'];
type Agents = GenieBridge['agents'];
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
export function localSession(port: LocalFramePort | undefined): { control: LocalProtocolControl; workspaces: Pick<Workspaces, WorkspaceProtocolKey>; agents: Agents } {
    let state: LocalProtocolState = { phase: 'starting', reason: null, revision: 0 };
    const listeners = new Set<() => void>();
    const settingsListeners = new Set<(id: string) => void>();
    let client: RemoteClient | null = null;
    let offState = () => {};
    let offSettings = () => {};
    const update = (next: LocalProtocolState) => {
        state = next;
        for (const listener of listeners) listener();
    };
    const release = () => {
        offSettings(); offSettings = () => {};
        offState(); offState = () => {};
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
    return {
        control: {
            state: () => state,
            onState: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            retry: () => { if (state.phase === 'failed') ready = start(true); },
        },
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
