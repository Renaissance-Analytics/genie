import type { AgentId } from '../core/identity.js';
import { SIGN_IN_METHODS, type RemoteMethod } from '../core/remote-protocol.js';
import type { FeatureAction, FeatureData } from '../renderer/features.js';
import { agentDetailFor } from './agent-detail.js';
import { ActivityFeeds, activityOfWorkspace } from './activity-feeds.js';
import { agentOpsApi, agentOpsPorts, type AgentOpsWiring } from './agent-ops-api.js';
import { restartAgent, retryPausedAgents, SettingApplier } from './agent-ops-host.js';
import { wireInboxChatUpdates } from './agent-push.js';
import type { InboxStore } from './inbox-store.js';
import { agentShells } from '../core/agent-shells.js';
import type { Finished } from './attention-store.js';
import { answerDeck, type DeckAnswerPorts } from './deck-answer.js';
import { workspaceLifecycleApi, workspaceLifecyclePorts, type CloneOfferOps, type WorkspaceLifecycleWiring } from './workspace-lifecycle-api.js';
import { workspaceSettingsOps } from './workspace-reads-api.js';
import { workspaceTynnApi } from './workspace-tynn-api.js';
import { readTynnBoardChanges } from './tynn-board-client.js';
import type { BoardScope } from '../core/tynn-board.js';
import { readTynnIssueChanges } from './tynn-issues-client.js';
import type { HostLocalPorts } from './host-local-ports.js';
import type { HostOwnerOps } from './host-owner-ops.js';
import { buildHostApi, type HostApiDeps, type LocalOwnerDeps } from './host-api.js';
import { createAgent, type AgentCreatePorts } from './agent-create-host.js';
import { nodeAgentConfigFs } from './agent-config-host.js';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { InboxMessage } from './inbox-store.js';
import type { Registry } from './registry.js';
import type { HostApi } from './remote-host.js';
import type { SessionHost } from './session-host.js';
import { startForWork, startForYourMessage } from './start-on-demand.js';
import type { SettingsStore } from './settings-store.js';
import { WORKSPACE_SAVE_UNAVAILABLE, type WorkspaceSaveOps } from './workspace-save-host.js';

/**
 * THE PHONE'S METHODS, ANSWERED BY GENIE-HOST WITH EVERY WINDOW CLOSED (Tynn #551, host split P5d.2).
 *
 * genie-host runs the SAME host API a window does (host-api.ts `buildHostApi`), over what genie-host owns: a registry on
 * its own registry store, its session host, its attention, inbox and approval stores, the workspaces' files. So what a
 * phone asks is parsed, gated and answered exactly as a window would; the agent detail and the Deck answer are the
 * window's own builders (agent-detail.ts, deck-answer.ts). Its events (the snapshot, an agent's detail, coalesced as the
 * window's) come from the same code.
 *
 * The remote host uses this while no window is connected, plus the five workspace read/settings methods and their
 * change signal even with a window (remote-access-host.ts, Tynn #666). Other families still prefer a connected window.
 */
export const PHONE_METHODS: ReadonlySet<RemoteMethod> = new Set<RemoteMethod>([
    'snapshot', 'agentDetail', 'prompt', 'answerApproval', 'agents.restart', 'resumeLimit', 'features.act',
    'files.children', 'files.open', 'files.readMedia', 'files.upload',
]);

/**
 * A PILOT'S AGENT OPERATIONS (Tynn #553, P5d.5a): the same set, on the same terms: only while no window is connected,
 * after the remote host's own owner, read-only and workspace checks. Later families of P5d.5 join {@link HOST_ALONE_METHODS}.
 */
export const PILOT_AGENT_METHODS: ReadonlySet<RemoteMethod> = new Set<RemoteMethod>([
    'agents.restart', 'agents.previewDelete', 'agents.delete', 'agents.switchDriver', 'agents.setBudget', 'agents.setAppWakeCap', 'agents.setMode', 'agents.setAccessScope',
    'agents.setAccessAgents', 'agents.setAutoApprove', 'agents.setManageTabs', 'agents.setDrivePages', 'agents.setMcpServer', 'agents.setIssueWatch', 'agents.setPermissions',
    'agents.setModel', 'agents.models', 'agents.diagnose', 'agents.toolOutput', 'agents.attachment',
    // What someone is typing (Tynn #730): with no window open, a Pilot and a guest still see each other's.
    'agents.typing',
]);

/** The Dashboard's lanes and rate limits (Tynn #553, P5d.5b). */
export const HOST_FEED_METHODS: ReadonlySet<RemoteMethod> = new Set<RemoteMethod>(['activity', 'headroom']);

/** A workspace's terminals (Tynn #553 P5d.5c; opening and listing since Tynn #898 step 2d-2). */
export const HOST_TERMINAL_METHODS: ReadonlySet<RemoteMethod> = new Set<RemoteMethod>(['terminals.open', 'terminals.list', 'terminals.attach', 'terminals.write', 'terminals.resize', 'terminals.close']);

/** Adding an agent and sending one a file (Tynn #898 step 2d-2): the last methods a window had to answer. */
export const HOST_AGENT_WRITE_METHODS: ReadonlySet<RemoteMethod> = new Set<RemoteMethod>(['addAgent', 'inbox.sendFile']);

/** A workspace's settings and repo reads, always the host's (Tynn #666). Changing repos keeps its existing fallback. */
export const HOST_WORKSPACE_READ_METHODS: ReadonlySet<RemoteMethod> = new Set<RemoteMethod>(['workspaces.settings', 'workspaces.setSetting', 'workspaces.resetSetting', 'workspaces.listRepos', 'workspaces.commitsSince']);

/** Adding, sleeping and changing a workspace (Tynn #553, P5d.5e). The Tynn tab stays the window's for now. */
export const HOST_WORKSPACE_LIFECYCLE_METHODS: ReadonlySet<RemoteMethod> = new Set<RemoteMethod>([
    'workspaces.previewAdd', 'workspaces.confirmAdd', 'workspaces.create', 'workspaces.previewAddFromGit', 'workspaces.confirmAddFromGit', 'workspaces.readSource',
    'workspaces.stageFromGit', 'workspaces.registerExisting', 'workspaces.buildEnvelope', 'workspaces.discardStaged', 'workspaces.githubRepos', 'workspaces.tynnProjects',
    'workspaces.tynnOwnerOptions', 'workspaces.createTynnProject', 'workspaces.importedAgents', 'workspaces.adoptAgent', 'workspaces.previewAddFromTynn', 'workspaces.confirmAddFromTynn',
    'workspaces.hibernate', 'workspaces.wake', 'workspaces.remove', 'workspaces.addRepo', 'workspaces.removeRepo', 'workspaces.removeRepoLock', 'workspaces.locateRepo', 'workspaces.relocate',
    'workspaces.setGoverns', 'workspaces.setDefaultAgent', 'workspaces.setColor', 'workspaces.setMcpServer',
    'workspaces.savePreview', 'workspaces.save', 'workspaces.cloneOffers', 'workspaces.applyOffer',
]);

/** The Tynn tab, read and changed (Tynn #553, P5d.5f); its live view's change reads too (Tynn #898 step 2d-3a). */
export const HOST_TYNN_TAB_METHODS: ReadonlySet<RemoteMethod> = new Set<RemoteMethod>(['workspaces.tynnBoard', 'workspaces.tynnPage', 'workspaces.tynnIssues', 'workspaces.tynnBoardAction', 'workspaces.tynnIssueAction', 'workspaces.tynnPageAction']);

/**
 * THE LAST A WINDOW ANSWERED (Tynn #898 step 2d-2b): opening, stopping and interrupting an agent, a queued draft's action,
 * the host's folders, the update actions and the share links. genie-host's session host, disk, updater and Tynn account.
 */
export const HOST_LAST_METHODS: ReadonlySet<RemoteMethod> = new Set<RemoteMethod>([
    'openAgent', 'stopAgent', 'cancelTurn', 'stopToolCall', 'resolvePrompt', 'host.listDir', 'host.mkdir', 'host.home',
    'updates.check', 'updates.download', 'updates.install', 'updates.forceDrain',
    'tynnNetwork.shares.list', 'tynnNetwork.shares.mint', 'tynnNetwork.shares.revoke',
    // The crash report (Tynn #897, 2c-2): built from genie-host's own safe mode, crash state, registry and identity.
    'crashReport.draft', 'crashReport.send',
    // A provider's program (Tynn #897, 2c-3): written to genie-host's own choice file.
    'providers.chooseProgram',
    // The throwaway shell (Tynn #897, 2c-4): opened on genie-host's terminal host, in the caller's window.
    'terminals.scratch',
    // A question's files and visuals, from genie-host's own Deck; a file opened on its own screen (Tynn #912, 2f-1).
    'questions.files', 'questions.file', 'questions.visuals', 'files.openExternal', 'files.reveal',
    // A remote window's transport to another machine, owned by the calling connection (Tynn #941, 2f-2).
    'deviceLink.open', 'deviceLink.openRelay', 'deviceLink.send', 'deviceLink.close', 'deviceLink.openBrowser',
    // What an older Genie sealed, into genie-host's own keychain; Tynn asked again (Tynn #959, 2g-3b).
    'keychain.adoptLegacy', 'tynn.recheck', 'approvals.gate', 'window.view',
    // A write to genie-host's registry, by main's window registry (Tynn #1007, 2g-4e).
    'registry.write',
]);

/** Every method genie-host answers itself, for every remote client: since step 2d-2b no remote method needs a window. */
export const HOST_ALONE_METHODS: ReadonlySet<RemoteMethod> = new Set<RemoteMethod>([...PHONE_METHODS, ...PILOT_AGENT_METHODS, ...HOST_FEED_METHODS, ...HOST_TERMINAL_METHODS, ...HOST_AGENT_WRITE_METHODS, ...HOST_WORKSPACE_READ_METHODS, ...HOST_WORKSPACE_LIFECYCLE_METHODS, ...HOST_TYNN_TAB_METHODS, ...HOST_LAST_METHODS,
    // The sign-ins (Tynn #896): the provider's own login, started by genie-host for whoever asked.
    ...SIGN_IN_METHODS]);

/** genie-host's session host, as this API drives it. */
export type HostAloneEngine = Pick<SessionHost,
    'probe' | 'start' | 'stop' | 'ended' | 'deliverOwed' | 'cancel' | 'stopToolCall' | 'resumeLimit' | 'prompt' | 'promptWith' | 'resolvePrompt' | 'answerApproval'
    | 'subscribe' | 'needsNewDriver' | 'notice' | 'ledgerFor' | 'historyPending' | 'turnsFor' | 'recentStderrFor' | 'rowsFor' | 'refusals'
    | 'modelState' | 'switchModel' | 'settleParked' | 'historyRows' | 'toolOutput' | 'forgetShown' | 'attachment' | 'pausedAgents'>;

export interface HostAlonePorts {
    readonly hostName: string;
    /** A registry over genie-host's own registry store: the snapshot, the records, the restarts' writes. */
    readonly registry: Registry;
    readonly engine: () => HostAloneEngine | null;
    readonly cwdFor: HostApiDeps['cwdFor'];
    /** Why a start would be refused (an asleep workspace, the agent cap), as Start always obeys. */
    readonly startRefusal: AgentOpsWiring['startRefusal'];
    /** Each provider's model list, asked of its CLI once and kept. */
    readonly models: AgentOpsWiring['models'];
    readonly providerInstalled: AgentOpsWiring['providerInstalled'];
    /** What the provider's status call last said (Tynn #698). Absent = not measured here, so nothing is claimed. */
    readonly signedIn?: AgentOpsWiring['signedIn'];
    /** The host's lifecycle log, for the agents' operations: a changed setting is one line (Tynn #1053). */
    readonly lifecycleLog?: ((line: string) => void) | undefined;
    /** The sign-ins (Tynn #896, host-sign-ins.ts): the provider's own login for whoever asked. Absent = this host cannot. */
    readonly signIns?: HostApiDeps['signIns'];
    /** The banner's crash report (Tynn #897, 2c-2). Absent = this host cannot send one. */
    readonly crashReports?: HostApiDeps['crashReports'];
    /** A provider's program (Tynn #897, 2c-3). Absent = this host cannot keep one. */
    readonly providerPrograms?: HostApiDeps['providerPrograms'];
    /** The throwaway shell (Tynn #897, 2c-4). Absent = this host cannot open one. */
    readonly scratchTerminals?: HostApiDeps['scratchTerminals'];
    /** A question's files and visuals (Tynn #912, 2f-1). Absent = this host cannot read them. */
    readonly questions?: HostApiDeps['questions'];
    /** A file opened on this host's own screen (Tynn #912, 2f-1). Absent = it cannot. */
    readonly hostShell?: HostApiDeps['hostShell'];
    /** A window's transport to another machine (Tynn #941, 2f-2). Absent = this Genie connects to none. */
    readonly deviceLinkProtocol?: HostApiDeps['deviceLinkProtocol'];
    /** What this host runs, for this machine's tray and quit (Tynn #953, 2g-2). Absent = nothing said. */
    readonly hostSummary?: HostApiDeps['hostSummary'];
    readonly remoteWatch?: HostApiDeps['remoteWatch'];
    readonly settingsWatch?: HostApiDeps['settingsWatch'];
    /** What an older Genie sealed, adopted into this host's keychain (Tynn #959, 2g-3b). Absent = refused. */
    readonly legacySecrets?: HostApiDeps['legacySecrets'];
    readonly approvalsGate?: HostApiDeps['approvalsGate'];
    readonly windowView?: HostApiDeps['windowView'];
    /** genie-host's registry and its writes, for main's window registry (Tynn #1007, 2g-4e). Absent = refused. */
    readonly registryFiles?: HostApiDeps['registryFiles'];
    /** Ask Tynn again whether this host is signed in (Tynn #959, 2g-3b). Absent = refused. */
    readonly tynnRecheck?: HostApiDeps['tynnRecheck'];
    readonly attention: DeckAnswerPorts['attention'] & { finished(): readonly Finished[] };
    readonly approvals: DeckAnswerPorts['approvals'];
    /** The host's own Deck: an answer is resolved against it, never against the copy a client sent (Tynn #861). */
    readonly deckItems: DeckAnswerPorts['deckItems'];
    readonly inbox: DeckAnswerPorts['inbox'] & { involving(id: AgentId, limit: number): readonly InboxMessage[] } & Partial<Pick<InboxStore, 'onMessagesChanged'>>;
    /** An approval's note, delivered to the agent as your message. */
    readonly deliverToAgent: (agentId: string, text: string) => boolean | Promise<boolean>;
    readonly files: NonNullable<HostApiDeps['files']>;
    /** Each provider's latest rate-limit reading, kept by genie-host whether or not a window is open. */
    readonly headroom: NonNullable<HostApiDeps['headroom']>;
    /** The host's terminals: opened in a workspace, listed, joined and typed into (Tynn #553, #898). */
    readonly terminals: HostApiDeps['terminals'];
    /** A workspace's environment from the hosting engines, which its terminals open with (Tynn #898). */
    readonly serviceEnvFor: HostApiDeps['serviceEnvFor'];
    /** A file sent to an agent: its bytes to genie-host's inbox, addressed on its roster (Tynn #898). */
    readonly uploads: HostApiDeps['uploads'];
    /** What adding an agent needs beyond the registry and the disk: its workspace's sacred name from Tynn (Tynn #898). */
    readonly agentCreate?: Pick<AgentCreatePorts, 'sacredName'>;
    /** What is known of this agent's Take Over TUI: its Observed row. */
    readonly takeOver: NonNullable<Parameters<typeof agentDetailFor>[0]['takeOver']>;
    /** genie-host's own settings store. */
    readonly settings: (Parameters<typeof workspaceSettingsOps>[0] extends () => infer S ? S : never) & Pick<SettingsStore, 'onChange'>;
    /** What genie-host holds for a workspace's lifecycle: its supervisor, engines, trust, accounts. */
    readonly workspaceLifecycle: Omit<WorkspaceLifecycleWiring, 'registry' | 'engine' | 'finished'>;
    /** A message's file that is not an image or text, saved into the agent's workspace here (Tynn #829). Absent = refused. */
    readonly saveUploads?: NonNullable<HostApiDeps['saveUploads']>;
    /** A workspace's colour, written to its project.json. */
    readonly colors: { set(path: string, color: string): Promise<{ ok: true } | { ok: false; reason: string }> };
    /** Save to repo (Tynn #756), over this host's registry, disk and git. Absent: refused in words. */
    readonly workspaceSave?: WorkspaceSaveOps;
    /** The offers a clone's repo brings (Tynn #756): genie-host's watcher. Absent: refused in words. */
    readonly cloneOffers?: CloneOfferOps;
    /** genie-host's Tynn account, as the Tynn tab reaches it, and its page reader. */
    readonly tynnTab: { board: Parameters<typeof workspaceTynnApi>[0]; readPage: Parameters<typeof workspaceTynnApi>[1] };
    readonly updates?: HostApiDeps['updates'];
    /** genie-host's share links (Tynn #839, #898 step 2d-2b): over its Tynn account, a revoke re-checks its relay sessions. */
    readonly shares?: LocalOwnerDeps['tynnNetwork']['shares'];
    /**
     * GENIE-HOST'S OWNER OPERATIONS (Tynn #898 step 2d-3b; host-owner-ops.ts): the Apps and scripts card, the remembered
     * device hosts, "Your workstations" and a role change, over its app door, device link, Tynn account and relay role.
     * Absent = refused in words, as before.
     */
    readonly owner?: HostOwnerOps;
    readonly schedule?: HostApiDeps['schedule'];
    /** The owned feature aggregator (Tynn #720), supplied when its measured contributors are composed. */
    readonly features?: HostApiDeps['features'];
    /**
     * GENIE-HOST'S OWN LOCAL PORTS (Tynn #898 step 2d-3a; host-local-ports.ts): the file and Repository panels, chat drafts,
     * the ArtBoard, the window's own terminals, the Marketplace and the GApp book; and its watches (step 2d-3b,
     * host-local-watches.ts): the file panel's and the live Tynn tab's. Absent = those families are refused.
     */
    readonly local?: Partial<HostLocalPorts> & Pick<HostApiDeps, 'filesWatch' | 'tynnWatch'>;
}

/** No share links on this host: each answers in the shares API's own shape (Tynn #898 step 2e-3). */
const NO_SHARE_LINKS: LocalOwnerDeps['tynnNetwork']['shares'] = {
    list: async () => ({ ok: false, reason: 'this host cannot share links' }),
    mint: async () => ({ ok: false, reason: 'this host cannot share links' }),
    revoke: async () => ({ ok: false, reason: 'this host cannot share links' }),
};
const cannot = (what: string) => (): never => { throw new Error(`this host cannot ${what}`); };
/** No owner port: the Apps and scripts card's keys are refused in words, method by method. */
const NO_APP_KEYS: LocalOwnerDeps['appInbox'] = {
    state: cannot('manage app keys'), workspaceExists: cannot('manage app keys'), createKey: cannot('manage app keys'),
    scriptKeys: cannot('manage app keys'), revokeKey: cannot('manage app keys'), rotate: cannot('manage app keys'),
    revokeSource: cannot('manage app keys'), allowSource: cannot('manage app keys'), restartSource: cannot('manage app keys'),
};
/** No owner port: its Tynn account and relay role are refused in words; the share links are what is given. */
const NO_TYNN_NETWORK: Omit<LocalOwnerDeps['tynnNetwork'], 'shares'> = {
    hasAccount: cannot('reach its Tynn network'), signedIn: cannot('reach its Tynn network'), role: cannot('reach its Tynn network'),
    workstations: cannot('reach its Tynn network'), setRole: cannot('reach its Tynn network'), rereadRole: cannot('reach its Tynn network'),
};

export function hostAloneApi(ports: HostAlonePorts): HostApi {
    const { hostName, registry } = ports;
    /*
     * WHAT GENIE-HOST LACKS IS ABSENT (Tynn #898 step 2e-3). There is no Proxy inventing members: an optional member that is
     * missing is missing, so host-api's own check answers ("this host cannot preview adding a folder", `deviceLink?.hosts()`
     * answering none), and the compiler holds every required one. A whole family with no port (the owner's operations
     * without an owner port) is refused by each method in words: "this host cannot …". Nothing here sends anyone to a
     * window, because every client is served by genie-host and no window could cure it.
     */
    const engine = (): HostAloneEngine => {
        const e = ports.engine();
        if (!e) throw new Error(`Genie’s agents on ${hostName} are still starting; try again in a moment`);
        return e;
    };
    const agentOps = agentOpsPorts({
        registry: () => registry,
        engine,
        models: ports.models,
        cwdFor: ports.cwdFor,
        startRefusal: ports.startRefusal,
        finished: () => ports.attention.finished(),
        providerInstalled: ports.providerInstalled,
        signedIn: ports.signedIn ?? (() => true),
        applyOnStart: (id) => settingApplier.requested(id),
        ...(ports.lifecycleLog ? { log: ports.lifecycleLog } : {}),
    });
    // A model change waiting for its agent to be free applies the moment it is, with or without a window.
    const settingApplier = new SettingApplier(agentOps, (id) => agentShells(ports.engine()?.rowsFor(id) ?? []).count);
    ports.engine()?.subscribe((id) => settingApplier.changed(id as AgentId));
    const activityFeeds = new ActivityFeeds({
        host: {
            // Built whether or not a window is connected (Tynn #898): every remote client reads genie-host's feeds.
            subscribe: (listener) => ports.engine()?.subscribe((id) => listener(id)) ?? (() => {}),
            ledgerFor: (id) => ports.engine()?.ledgerFor(id) ?? [],
            probe: (id) => ports.engine()?.probe(id) ?? null,
        },
        ...(ports.schedule ? { schedule: (fn: () => void, ms: number) => { ports.schedule!(ms, fn); } } : {}),
    });
    const lifecycleWiring: WorkspaceLifecycleWiring = { ...ports.workspaceLifecycle, registry: () => registry, engine: ports.engine, finished: () => ports.attention.finished() };
    const lifecycle = workspaceLifecyclePorts(lifecycleWiring);
    const setColor = async (id: string, color: string) => {
        const workspace = registry.workspace(id);
        return workspace ? ports.colors.set(workspace.path, color) : { ok: false as const, reason: 'name a workspace' };
    };
    const startOnDemand = (record: Parameters<HostApiDeps['cwdFor']>[0]) => startForWork({
        probe: (id) => ports.engine()?.probe(id) ?? null,
        start: (r, cwd) => engine().start(r, cwd),
        cwdFor: ports.cwdFor,
        startRefusal: ports.startRefusal,
    }, record);
    const agentCreate: AgentCreatePorts = {
        workspace: (id) => registry.workspace(id) ?? null,
        agentsOf: (id) => registry.agentsOf(id),
        exists: async (path) => existsSync(path),
        mkdirp: async (dir) => { await mkdir(dir, { recursive: true }); },
        ...nodeAgentConfigFs(),
        register: async (input) => { const record = await registry.register(input); return { id: record.id, name: record.name }; },
        ...(ports.agentCreate?.sacredName ? { sacredName: ports.agentCreate.sacredName } : {}),
    };
    const deps: HostApiDeps = {
        ...(ports.schedule ? { schedule: ports.schedule } : {}),
        snapshot: () => registry.snapshot(),
        subscribeSnapshot: (listener) => registry.subscribe(listener),
        subscribeAgentRecords: (listener) => registry.subscribeAgentRecords(listener),
        find: (id) => registry.find(id as AgentId),
        detailFor: (id) => agentDetailFor({ registry, engine: ports.engine(), cwdFor: ports.cwdFor, takeOver: ports.takeOver, mail: (agentId, limit) => ports.inbox.involving(agentId, limit), ...(ports.signedIn ? { providerSignedIn: ports.signedIn } : {}) }, id as AgentId),
        cwdFor: ports.cwdFor,
        startForWork: startOnDemand,
        ...(ports.saveUploads ? { saveUploads: ports.saveUploads } : {}),
        ...(ports.signIns ? { signIns: ports.signIns } : {}),
        ...(ports.crashReports ? { crashReports: ports.crashReports } : {}),
        ...(ports.providerPrograms ? { providerPrograms: ports.providerPrograms } : {}),
        ...(ports.scratchTerminals ? { scratchTerminals: ports.scratchTerminals } : {}),
        ...(ports.questions ? { questions: ports.questions } : {}),
        ...(ports.hostShell ? { hostShell: ports.hostShell } : {}),
        ...(ports.deviceLinkProtocol ? { deviceLinkProtocol: ports.deviceLinkProtocol } : {}),
        ...(ports.hostSummary ? { hostSummary: ports.hostSummary } : {}),
        ...(ports.remoteWatch ? { remoteWatch: ports.remoteWatch } : {}),
        ...(ports.settingsWatch ? { settingsWatch: ports.settingsWatch } : {}),
        ...(ports.legacySecrets ? { legacySecrets: ports.legacySecrets } : {}),
        ...(ports.approvalsGate ? { approvalsGate: ports.approvalsGate } : {}),
        ...(ports.windowView ? { windowView: ports.windowView } : {}),
        ...(ports.registryFiles ? { registryFiles: ports.registryFiles } : {}),
        ...(ports.tynnRecheck ? { tynnRecheck: ports.tynnRecheck } : {}),
        startForYourMessage: (record) => startForYourMessage({
            startForWork: startOnDemand,
            needsNewDriver: (id) => ports.engine()?.needsNewDriver(id) ?? false,
            restart: (id) => restartAgent(agentOps, id, 'graceful'),
            notice: (id, message) => ports.engine()?.notice(id, message) ?? false,
        }, record),
        host: {
            start: (record, cwd) => engine().start(record, cwd),
            stop: (id) => engine().stop(id),
            cancel: (id, intent) => engine().cancel(id, 'you', intent),
            stopToolCall: (id, toolCallId) => engine().stopToolCall(id, toolCallId, 'you'),
            resumeLimit: (provider, accountId) => engine().resumeLimit(provider, accountId),
            prompt: (id, text, by) => engine().prompt(id, text, by),
            promptWith: (id, text, attachments, by) => engine().promptWith(id, text, attachments, by),
            resolvePrompt: (id, promptId, action) => engine().resolvePrompt(id, promptId, action),
            answerApproval: (id, optionId, note) => engine().answerApproval(id, optionId, note ?? ''),
            subscribe: (listener) => ports.engine()?.subscribe(listener) ?? (() => {}),
        },
        // ADDING AN AGENT, here (Tynn #898): the same creation a window ran, over genie-host's registry and the disk.
        registerAgent: (workspaceId, input) => createAgent(agentCreate, workspaceId, input),
        // TRY AGAIN for a paused account (step 2d-4a): genie-host's session host says which agents the provider stopped.
        retryPausedAccount: (provider) => {
            void retryPausedAgents({
                paused: (p) => ports.engine()?.pausedAgents(p) ?? [],
                restart: (id) => restartAgent(agentOps, id, 'graceful'),
                prompt: (id, text) => { void ports.engine()?.prompt(id as AgentId, text, 'genie'); },
                touch: () => registry.touch(),
            }, provider).catch(() => {});
        },
        // A chat follows its mail (step 2d-4a): an arrival or a read receipt refreshes its participants for their watchers.
        ...(ports.inbox.onMessagesChanged ? { subscribeAgentChat: (listener: (agentId: string) => void) => wireInboxChatUpdates({ onMessagesChanged: (l) => ports.inbox.onMessagesChanged!(l) }, listener) } : {}),
        terminals: ports.terminals,
        uploads: ports.uploads,
        files: ports.files,
        serviceEnvFor: (workspaceId) => ports.serviceEnvFor(workspaceId),
        ...(ports.local ?? {}),
        workspaceOps: {
            onSettingsChanged: (listener) => ports.settings.onChange((_key, _value, id) => { if (id) listener(id); }),
            ...workspaceSettingsOps(() => ports.settings),
            ...workspaceLifecycleApi(lifecycle, lifecycleWiring, () => registry.touch(), setColor, ports.workspaceSave ?? WORKSPACE_SAVE_UNAVAILABLE, ports.cloneOffers),
            ...workspaceTynnApi(() => ports.tynnTab.board(), (id, page, query) => ports.tynnTab.readPage(id, page, query)),
            // The live tab's reads (P4 family 12): what changed since a cursor, from genie-host's Tynn account (step 2d-3a).
            tynnBoardChanges: async (id, scope, cursor, ids) => readTynnBoardChanges(await ports.tynnTab.board(), id, (scope ?? {}) as BoardScope, cursor, ids),
            tynnIssueChanges: async (id, filters, cursor, ids) => readTynnIssueChanges(await ports.tynnTab.board(), id, filters ?? {}, cursor, ids),
        },
        agentOps: agentOpsApi(agentOps, () => registry.touch(), () => ports.engine()),
        features: ports.features ?? {
            // Optional subscription hooks must really be absent, not synthesized as throwing window methods.
            // Production supplies HostFeatures; this legacy Deck-only fallback owns no feature change source.
            snapshot: async () => { throw new Error('this host cannot read its features'); },
            // The Deck's answer only (the phone's Deck, deck-answer.ts); the phone reads nothing back from it.
            act: async (action: FeatureAction) => {
                if (action.kind !== 'deck.answer' && action.kind !== 'deck.answerForm') throw new Error(`this host cannot run ${action.kind}`);
                await answerDeck(action, { deckItems: ports.deckItems, attention: ports.attention, approvals: ports.approvals, inbox: ports.inbox, deliverToAgent: ports.deliverToAgent });
                return {} as FeatureData;
            },
        },
        activity: { feeds: (workspaceId) => activityOfWorkspace(activityFeeds, registry.listAgents(), workspaceId), subscribe: (listener) => activityFeeds.subscribe(listener) },
        headroom: ports.headroom,
        updates: ports.updates ?? null,
        // THE OWNER'S OPERATIONS (step 2d-3b): genie-host's own, with its share links. With no owner port, only the share links.
        ...(ports.owner
            ? { localOwner: { ...ports.owner, tynnNetwork: { ...ports.owner.tynnNetwork, shares: ports.shares ?? NO_SHARE_LINKS } } }
            : ports.shares ? { localOwner: { appInbox: NO_APP_KEYS, tynnNetwork: { ...NO_TYNN_NETWORK, shares: ports.shares } } } : {}),
    };
    return { ...buildHostApi(deps), ...(ports.features ? { ownsFeatures: true } : {}) };
}
