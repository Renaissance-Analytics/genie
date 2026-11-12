import type { LocalFramePort } from '../core/local-frame.js';
import { bindTerminalViews, watchTerminal } from './local-terminal-client.js';
import type { GenieBridge, LocalOwnerBridge } from './bridge.js';
import { localTransport } from './local-transport.js';
import { connectRemote, type RemoteClient } from './remote-bridge.js';
import type { LocalFilesBridge } from './local-files-client.js';

export type WorkspaceProtocolKey = 'listRepos' | 'addRepo' | 'removeRepo' | 'removeRepoLock' | 'locateRepo' | 'commitsSince'
    | 'settings' | 'setSetting' | 'resetSetting' | 'setGoverns' | 'setDefaultAgent' | 'setColor' | 'setMcpServer' | 'onSettingsChanged'
    | 'previewAdd' | 'confirmAdd' | 'create' | 'previewAddFromGit' | 'confirmAddFromGit' | 'readSource'
    | 'stageFromGit' | 'registerExisting' | 'buildEnvelope' | 'discardStaged' | 'githubRepos' | 'tynnProjects'
    | 'tynnOwnerOptions' | 'createTynnProject' | 'importedAgents' | 'adoptAgent' | 'previewAddFromTynn' | 'confirmAddFromTynn'
    // P4 family 12 (Tynn #561): the Tynn tab.
    | 'tynnBoard' | 'tynnBoardAction' | 'tynnPage' | 'tynnPageAction' | 'tynnBoardChanges' | 'tynnBoardWatch'
    | 'tynnIssues' | 'tynnIssueAction' | 'tynnIssueChanges' | 'tynnIssuesWatch' | 'tynnFeaturesWatch'
    // P4 family 10 (Tynn #559): the workspace lifecycle.
    | 'hibernate' | 'wake' | 'remove';
type Workspaces = GenieBridge['workspaces'];
type Agents = GenieBridge['agents'];
type HostFamily = Required<Pick<GenieBridge, 'updates' | 'activity' | 'onHeadroom' | 'accountRetry' | 'marketplace' | 'gapps'>>;
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
/** How long after a drop the link is tried again. The last repeats: it never gives up. */
const RECONNECT_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000] as const;
/** How long a change made during a drop waits for the link before it says so. */
const DROP_WAIT_MS = 15_000;
const LINK_DOWN = 'Genie isn’t answering this window yet. Try that again in a moment.';
/** Another connection in this window took the link. Taking it back would fight it forever, so this needs the person. */
const REPLACED = 'this window opened a replacement protocol connection';

/** One session per pageBridge. Only moved calls wait for it; unmoved preload methods remain available. */
export function localSession(port: LocalFramePort | undefined): { control: LocalProtocolControl; features: Pick<GenieBridge['features'], 'snapshot' | 'subscribe' | 'soundData' | 'act' | 'picked'>; agentCommands: Pick<GenieBridge, 'openAgent' | 'stopAgent' | 'resumeLimit' | 'cancelTurn' | 'prompt' | 'resolvePrompt' | 'answerApproval' | 'addAgent'>; host: NonNullable<GenieBridge['host']>; terminals: GenieBridge['terminals']; workspaces: Pick<Workspaces, WorkspaceProtocolKey>; agents: Agents; owner: LocalOwnerBridge; files: LocalFilesBridge; repo: NonNullable<GenieBridge['repo']>; chatDrafts: NonNullable<GenieBridge['chatDrafts']>; artboard: NonNullable<GenieBridge['artboard']> } & HostFamily {
    let state: LocalProtocolState = { phase: 'starting', reason: null, revision: 0 };
    let wasReady = false;
    const everReady = () => wasReady;
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
        if (next.phase === 'ready') wasReady = true;
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
    /** One connection, up and subscribed. Otherwise released, and the reason. */
    const connect = async (revise: boolean): Promise<Connected> => {
        const transport = localTransport(port!);
        const attempt = connectRemote(transport, { kind: 'local' }, 'this window');
        client = attempt;
        const result = await attempt.ready;
        if (!result.ok) { release(); return result; }
        offSettings = attempt.bridge.workspaces.onSettingsChanged!((id) => { for (const listener of settingsListeners) listener(id); });
        offState = attempt.onState((next) => { if (!next.connected && client === attempt) dropped(transport.closeReason()); });
        for (const entry of subscriptions) entry.off = entry.start(attempt.bridge);
        update({ phase: 'ready', reason: null, revision: state.revision + (revise ? 1 : 0) });
        return result;
    };
    /** THE LINK WENT (Tynn #590): every later call waits for it, and it is tried until it comes back. */
    const reconnect = async (): Promise<Connected> => {
        for (let attempt = 0; ; attempt++) {
            await new Promise<void>((resolve) => setTimeout(resolve, RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)]));
            try {
                const result = await connect(true);
                if (result.ok) return result;
            } catch { release(); /* tried again after the next wait */ }
        }
    };
    const dropped = (reason: string | null): void => {
        if (reason === REPLACED) { fail(reason); ready = Promise.resolve({ ok: false, reason }); return; }
        release();
        update({ ...state, phase: 'starting', reason: null });
        ready = reconnect();
    };
    const start = async (manual: boolean): Promise<Connected> => {
        update({ ...state, phase: 'starting', reason: null });
        if (!port) return fail('This Genie window has no local protocol connection.');
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
            try {
                const result = await connect(manual);
                if (result.ok) return result;
                if (result.reason !== STARTING || attempt === ATTEMPTS - 1) return fail(result.reason);
            } catch (error) {
                return fail(error instanceof Error ? error.message : String(error));
            }
            await new Promise<void>((resolve) => setTimeout(resolve, BACKOFF_MS));
        }
        return fail(STARTING);
    };
    let ready: Promise<Connected> = start(false);
    /** The link, or why it isn't here: a drop is waited out for {@link DROP_WAIT_MS}, startup for as long as it takes. */
    const linked = (): Promise<Connected> => {
        if (state.phase === 'ready' || !everReady()) return ready;
        let timer: ReturnType<typeof setTimeout>;
        const waited = new Promise<Connected>((resolve) => { timer = setTimeout(() => resolve({ ok: false, reason: LINK_DOWN }), DROP_WAIT_MS); });
        return Promise.race([ready, waited]).finally(() => clearTimeout(timer));
    };
    const requestBridge = async <T>(call: (bridge: GenieBridge) => Promise<T>): Promise<T | Refusal> => {
        if (state.phase === 'failed') return { ok: false, reason: state.reason! };
        const result = await linked();
        if (!result.ok) return result;
        if (!client || state.phase !== 'ready') return { ok: false, reason: state.reason ?? LINK_DOWN };
        return call(client.bridge);
    };
    const request = <T>(call: (ws: Workspaces) => Promise<T>) => requestBridge((bridge) => call(bridge.workspaces));
    const requestAgent = <T>(call: (agents: Agents) => Promise<T>) => requestBridge((bridge) => call(bridge.agents));
    // Reads/actions that rejected over IPC must also reject on startup or connection failure.
    // Checking connection state separately avoids mistaking an actual host value for a refusal.
    const read = async <T>(call: (bridge: GenieBridge) => Promise<T>): Promise<T> => {
        if (state.phase === 'failed') throw new Error(state.reason!);
        const result = await linked();
        if (!result.ok) throw new Error(result.reason);
        if (!client || state.phase !== 'ready') throw new Error(state.reason ?? LINK_DOWN);
        return call(client.bridge);
    };
    // The same admitted local client, with the same read/rejection and recovery semantics as the other moved families.
    const ownerRead = <T>(call: (owner: LocalOwnerBridge) => Promise<T>): Promise<T> => read(() => call(client!.localOwner!));
    const terminals: GenieBridge['terminals'] = {
        open: (id, options) => read(b => b.terminals.open(id, options)),
        write: (id, text) => read(async b => { await b.terminals.write(id, text); }),
        resize: (id, cols, rows) => read(async b => { await b.terminals.resize(id, cols, rows); }),
        close: id => read(async b => { await b.terminals.close(id); }),
        list: id => read(b => b.terminals.list(id)), attach: (id, terminal) => read(b => b.terminals.attach(id, terminal)),
        onData: listener => subscribe(b => b.terminals.onData(listener)),
        onExit: listener => subscribe(b => b.terminals.onExit(listener)),
    };
    bindTerminalViews(terminals, (workspaceId, id, observer) => {
        let alive = true;
        const off = subscribe(b => watchTerminal(b.terminals, workspaceId, id, observer));
        void read(async () => {}).catch(error => { if (alive) observer.error(error instanceof Error ? error : new Error(String(error))); });
        return () => { alive = false; off(); };
    });
    // P4 family 9b (Tynn #563): a command's caller shows a refusal, so a connection that went is one, never a throw.
    const answered = async <T>(call: (bridge: GenieBridge) => Promise<T>): Promise<T | { ok: false; reason: string }> => {
        try { return await read(call); } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
    };
    const agentCommands: Pick<GenieBridge, 'openAgent' | 'stopAgent' | 'resumeLimit' | 'cancelTurn' | 'prompt' | 'resolvePrompt' | 'answerApproval' | 'addAgent'> = {
        openAgent: (id) => { void read(async (b) => { b.openAgent(id); }).catch(() => {}); },
        stopAgent: (id) => { void read(async (b) => { b.stopAgent(id); }).catch(() => {}); },
        resumeLimit: (id) => answered((b) => b.resumeLimit(id)),
        cancelTurn: (id, intent) => answered((b) => b.cancelTurn(id, intent)),
        prompt: (id, text, attachments) => answered((b) => b.prompt(id, text, attachments)),
        resolvePrompt: (id, promptId, action) => answered((b) => b.resolvePrompt(id, promptId, action)) as never,
        answerApproval: (id, optionId, note) => answered((b) => b.answerApproval(id, optionId, note)),
        addAgent: (workspaceId, input) => answered((b) => b.addAgent(workspaceId, input)),
    };
    return {
        agentCommands,
        terminals,
        gapps: {
            list: () => read(b => b.gapps!.list()),
            review: folder => read(b => b.gapps!.review(folder)),
            install: (folder, options) => read(b => b.gapps!.install(folder, options)),
            setOn: (id, on) => read(b => b.gapps!.setOn(id, on)),
            uninstall: id => read(b => b.gapps!.uninstall(id)),
            open: id => read(b => b.gapps!.open(id)),
            preview: id => read(b => b.gapps!.preview(id)),
            allowPreviewNetwork: (id, allowed) => read(b => b.gapps!.allowPreviewNetwork(id, allowed)),
            onChanged: listener => subscribe(b => b.gapps!.onChanged(listener)),
        },
        marketplace: {
            search: (query, cursor) => read(b => b.marketplace!.search(query, cursor)),
            prepare: (id, version) => read(b => b.marketplace!.prepare(id, version)),
            install: (token, consent) => read(b => b.marketplace!.install(token, consent)),
            discard: token => read(b => b.marketplace!.discard(token)),
        },
        // P4 family 11 (Tynn #560): the feature snapshot, its push and a sound's data.
        features: {
            snapshot: () => read((b) => b.features.snapshot()),
            subscribe: (listener) => subscribe((b) => b.features.subscribe(listener)),
            soundData: (key) => read((b) => b.features.soundData(key)),
            act: (action) => read((b) => b.features.act(action)),
            picked: (paths) => read(async (b) => { await b.features.picked?.(paths); }),
        },
        // P4 family 10 (Tynn #559): the host's folders, for every picker — a failure rejects, as the IPC call did.
        host: {
            listDir: (path) => read((b) => b.host!.listDir(path)),
            mkdir: (parent, name) => read((b) => b.host!.mkdir!(parent, name)),
            home: () => read((b) => b.host!.home!()),
        },
        artboard: { read: id => read(b => b.artboard!.read(id)), review: (id, post, verdict, comment) => read(b => b.artboard!.review(id, post, verdict, comment)) },
        chatDrafts: {
            load: () => read(b => b.chatDrafts!.load()), save: (id, draft) => read(b => b.chatDrafts!.save(id, draft)),
            putFile: bytes => read(b => b.chatDrafts!.putFile(bytes)), readFile: ref => read(b => b.chatDrafts!.readFile(ref)),
            release: refs => read(b => b.chatDrafts!.release(refs)),
        },
        files: {
            subscribe: (id, want, listener) => subscribe(b => b.files.subscribe!(id, want, listener)),
            onChange: listener => subscribe(b => b.files.onChange(listener)),
            tree: id => read(b => b.files.tree(id)), children: (id, dir) => read(b => b.files.children!(id, dir)),
            open: (id, path) => read(b => b.files.open(id, path)), readMedia: (id, path) => read(b => b.files.readMedia!(id, path)),
            lastCommitted: (id, path) => read(b => b.files.lastCommitted!(id, path)), state: id => read(b => b.files.state(id)), gitStatus: id => read(b => b.files.gitStatus!(id)),
            create: (id, path, kind) => read(b => b.files.create!(id, path, kind)), rename: (id, from, to) => read(b => b.files.rename!(id, from, to)),
            duplicate: (id, path) => read(b => b.files.duplicate!(id, path)), trash: (id, path) => read(b => b.files.trash!(id, path)),
            readBytes: (id, plugin, path) => read(b => b.files.readBytes!(id, plugin, path)), write: (id, path, text, expected) => read(b => b.files.write(id, path, text, expected)),
            writeBytes: (id, plugin, path, base64, expected) => read(b => b.files.writeBytes!(id, plugin, path, base64, expected)),
        },
        repo: { call: (op, id, rel, a, b) => read(bridge => bridge.repo!.call(op, id, rel, a, b)) },
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
            setAccessAgents: (id, ids) => requestAgent((agents) => agents.setAccessAgents(id, ids)),
            setAutoApprove: (id, on) => requestAgent((agents) => agents.setAutoApprove(id, on)),
            setManageTabs: (id, on) => requestAgent((agents) => agents.setManageTabs(id, on)),
            setDrivePages: (id, on) => requestAgent((agents) => agents.setDrivePages(id, on)),
            setMcpServer: (id, name, on) => requestAgent((agents) => agents.setMcpServer(id, name, on)),
            setIssueWatch: (id, setting) => requestAgent((agents) => agents.setIssueWatch(id, setting)),
            setPermissions: (id, permissions) => requestAgent((agents) => agents.setPermissions(id, permissions)),
            setModel: (id, model) => requestAgent((agents) => agents.setModel(id, model)),
            models: (id, refresh) => requestAgent((agents) => agents.models!(id, refresh)),
            diagnose: (id) => requestAgent((agents) => agents.diagnose(id)),
            toolOutput: (id, toolCallId) => requestAgent((agents) => agents.toolOutput(id, toolCallId)),
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
            setMcpServer: (id, name, on) => request((ws) => ws.setMcpServer(id, name, on)),
            setColor: (id, color) => request((ws) => ws.setColor!(id, color)),
            onSettingsChanged: (listener) => { settingsListeners.add(listener); return () => { settingsListeners.delete(listener); }; },
            // The Tynn tab (P4 family 12): reads and actions reject on a failed connection, as the IPC calls did.
            tynnBoard: (id, scope) => read((b) => b.workspaces.tynnBoard!(id, scope)),
            tynnBoardAction: (id, input) => read((b) => b.workspaces.tynnBoardAction!(id, input)),
            tynnPage: (id, page, query) => read((b) => b.workspaces.tynnPage!(id, page, query)),
            tynnPageAction: (id, input) => read((b) => b.workspaces.tynnPageAction!(id, input)),
            tynnBoardChanges: (id, scope, cursor, ids) => read((b) => b.workspaces.tynnBoardChanges!(id, scope, cursor, ids)),
            tynnIssues: (id, filters) => read((b) => b.workspaces.tynnIssues!(id, filters)),
            tynnIssueAction: (id, input) => read((b) => b.workspaces.tynnIssueAction!(id, input)),
            tynnIssueChanges: (id, filters, cursor, ids) => read((b) => b.workspaces.tynnIssueChanges!(id, filters, cursor, ids)),
            tynnBoardWatch: (id, listener) => subscribe((b) => b.workspaces.tynnBoardWatch!(id, listener)),
            tynnIssuesWatch: (id, listener) => subscribe((b) => b.workspaces.tynnIssuesWatch!(id, listener)),
            tynnFeaturesWatch: (id, listener) => subscribe((b) => b.workspaces.tynnFeaturesWatch!(id, listener)),
            hibernate: (id) => request((ws) => ws.hibernate(id)),
            wake: (id) => request((ws) => ws.wake(id)),
            remove: (id) => request((ws) => ws.remove(id)),
        },
    };
}
