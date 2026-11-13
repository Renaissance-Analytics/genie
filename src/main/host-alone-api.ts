import type { AgentId } from '../core/identity.js';
import type { RemoteMethod } from '../core/remote-protocol.js';
import type { FeatureAction, FeatureData } from '../renderer/features.js';
import { agentDetailFor } from './agent-detail.js';
import { ActivityFeeds, activityOfWorkspace } from './activity-feeds.js';
import { agentOpsApi, agentOpsPorts, type AgentOpsWiring } from './agent-ops-api.js';
import { restartAgent, SettingApplier } from './agent-ops-host.js';
import { agentShells } from '../core/agent-shells.js';
import type { Finished } from './attention-store.js';
import { answerDeck, type DeckAnswerPorts } from './deck-answer.js';
import { workspaceLifecycleApi, workspaceLifecyclePorts, type WorkspaceLifecycleWiring } from './workspace-lifecycle-api.js';
import { workspaceSettingsOps } from './workspace-reads-api.js';
import { workspaceTynnApi } from './workspace-tynn-api.js';
import { buildHostApi, type HostApiDeps } from './host-api.js';
import type { InboxMessage } from './inbox-store.js';
import type { Registry } from './registry.js';
import type { HostApi } from './remote-host.js';
import type { SessionHost } from './session-host.js';
import { startForWork, startForYourMessage } from './start-on-demand.js';

/**
 * THE PHONE'S METHODS, ANSWERED BY GENIE-HOST WITH EVERY WINDOW CLOSED (Tynn #551, host split P5d.2).
 *
 * genie-host runs the SAME host API a window does (host-api.ts `buildHostApi`), over what genie-host owns: a registry on
 * its own registry store, its session host, its attention, inbox and approval stores, the workspaces' files. So what a
 * phone asks is parsed, gated and answered exactly as a window would; the agent detail and the Deck answer are the
 * window's own builders (agent-detail.ts, deck-answer.ts). Its events (the snapshot, an agent's detail, coalesced as the
 * window's) come from the same code.
 *
 * The remote host uses this only for the phone's methods, and only while no window is connected (remote-access-host.ts):
 * with a window open, the window answers as before. Anything outside the phone's set is refused with what to do.
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
    'agents.restart', 'agents.previewDelete', 'agents.delete', 'agents.switchDriver', 'agents.setBudget', 'agents.setMode', 'agents.setAccessScope',
    'agents.setAccessAgents', 'agents.setAutoApprove', 'agents.setManageTabs', 'agents.setDrivePages', 'agents.setMcpServer', 'agents.setIssueWatch', 'agents.setPermissions',
    'agents.setModel', 'agents.models', 'agents.diagnose', 'agents.toolOutput', 'agents.attachment',
]);

/** The Dashboard's lanes and rate limits (Tynn #553, P5d.5b). */
export const HOST_FEED_METHODS: ReadonlySet<RemoteMethod> = new Set<RemoteMethod>(['activity', 'headroom']);

/** A Pilot's Take Over window's own terminal (Tynn #553, P5d.5c). Opening and listing terminals stay the window's. */
export const HOST_TERMINAL_METHODS: ReadonlySet<RemoteMethod> = new Set<RemoteMethod>(['terminals.attach', 'terminals.write', 'terminals.resize', 'terminals.close']);

/** A workspace's settings and repositories, read (Tynn #553, P5d.5d). Changing the repositories stays the window's. */
export const HOST_WORKSPACE_READ_METHODS: ReadonlySet<RemoteMethod> = new Set<RemoteMethod>(['workspaces.settings', 'workspaces.setSetting', 'workspaces.resetSetting', 'workspaces.listRepos', 'workspaces.commitsSince']);

/** Adding, sleeping and changing a workspace (Tynn #553, P5d.5e). The Tynn tab stays the window's for now. */
export const HOST_WORKSPACE_LIFECYCLE_METHODS: ReadonlySet<RemoteMethod> = new Set<RemoteMethod>([
    'workspaces.previewAdd', 'workspaces.confirmAdd', 'workspaces.create', 'workspaces.previewAddFromGit', 'workspaces.confirmAddFromGit', 'workspaces.readSource',
    'workspaces.stageFromGit', 'workspaces.registerExisting', 'workspaces.buildEnvelope', 'workspaces.discardStaged', 'workspaces.githubRepos', 'workspaces.tynnProjects',
    'workspaces.tynnOwnerOptions', 'workspaces.createTynnProject', 'workspaces.importedAgents', 'workspaces.adoptAgent', 'workspaces.previewAddFromTynn', 'workspaces.confirmAddFromTynn',
    'workspaces.hibernate', 'workspaces.wake', 'workspaces.remove', 'workspaces.addRepo', 'workspaces.removeRepo', 'workspaces.removeRepoLock', 'workspaces.locateRepo',
    'workspaces.setGoverns', 'workspaces.setDefaultAgent', 'workspaces.setColor', 'workspaces.setMcpServer',
]);

/** The Tynn tab, read and changed (Tynn #553, P5d.5f). A live view's change reads stay the local window's. */
export const HOST_TYNN_TAB_METHODS: ReadonlySet<RemoteMethod> = new Set<RemoteMethod>(['workspaces.tynnBoard', 'workspaces.tynnPage', 'workspaces.tynnIssues', 'workspaces.tynnBoardAction', 'workspaces.tynnIssueAction', 'workspaces.tynnPageAction']);

/** Every method genie-host answers itself while no window is connected. */
export const HOST_ALONE_METHODS: ReadonlySet<RemoteMethod> = new Set<RemoteMethod>([...PHONE_METHODS, ...PILOT_AGENT_METHODS, ...HOST_FEED_METHODS, ...HOST_TERMINAL_METHODS, ...HOST_WORKSPACE_READ_METHODS, ...HOST_WORKSPACE_LIFECYCLE_METHODS, ...HOST_TYNN_TAB_METHODS]);

/** genie-host's session host, as this API drives it. */
export type HostAloneEngine = Pick<SessionHost,
    'probe' | 'start' | 'stop' | 'ended' | 'deliverOwed' | 'cancel' | 'resumeLimit' | 'prompt' | 'promptWith' | 'resolvePrompt' | 'answerApproval'
    | 'subscribe' | 'needsNewDriver' | 'notice' | 'ledgerFor' | 'historyPending' | 'turnsFor' | 'recentStderrFor' | 'rowsFor' | 'refusals'
    | 'modelState' | 'switchModel' | 'settleParked' | 'historyRows' | 'toolOutput' | 'forgetShown' | 'attachment'>;

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
    readonly attention: DeckAnswerPorts['attention'] & { finished(): readonly Finished[] };
    readonly approvals: DeckAnswerPorts['approvals'];
    readonly inbox: DeckAnswerPorts['inbox'] & { involving(id: AgentId, limit: number): readonly InboxMessage[] };
    /** An approval's note, delivered to the agent as your message. */
    readonly deliverToAgent: (agentId: string, text: string) => boolean | Promise<boolean>;
    readonly files: NonNullable<HostApiDeps['files']>;
    /** A window is connected: it answers, so genie-host builds no activity feed nobody it serves will read. */
    readonly windowConnected: () => boolean;
    /** Each provider's latest rate-limit reading, kept by genie-host whether or not a window is open. */
    readonly headroom: NonNullable<HostApiDeps['headroom']>;
    /** The host's terminals, as a Take Over window on a Pilot reads and types into its own. */
    readonly terminals: Pick<HostApiDeps['terminals'], 'attach' | 'write' | 'resize' | 'close' | 'list' | 'onData' | 'onExit'>;
    /** What is known of this agent's Take Over TUI: its Observed row. */
    readonly takeOver: NonNullable<Parameters<typeof agentDetailFor>[0]['takeOver']>;
    /** genie-host's own settings store. */
    readonly settings: Parameters<typeof workspaceSettingsOps>[0] extends () => infer S ? S : never;
    /** What genie-host holds for a workspace's lifecycle: its supervisor, engines, trust, accounts. */
    readonly workspaceLifecycle: Omit<WorkspaceLifecycleWiring, 'registry' | 'engine' | 'finished'>;
    /** A workspace's colour, written to its project.json. */
    readonly colors: { set(path: string, color: string): Promise<{ ok: true } | { ok: false; reason: string }> };
    /** genie-host's Tynn account, as the Tynn tab reaches it, and its page reader. */
    readonly tynnTab: { board: Parameters<typeof workspaceTynnApi>[0]; readPage: Parameters<typeof workspaceTynnApi>[1] };
    readonly updates?: HostApiDeps['updates'];
    readonly schedule?: HostApiDeps['schedule'];
}

export function hostAloneApi(ports: HostAlonePorts): HostApi {
    const { hostName, registry } = ports;
    const needsWindow = (what: string) => `${hostName} answers ${what} only while a Genie window is open there: open Genie on ${hostName}`;
    /** A dependency only a window has: every member refuses, except the subscriptions given (which the events wire up). */
    const windowOnly = <T extends object>(what: string, given: Partial<T> = {}): T => new Proxy(given, {
        // A given method keeps its object (beta.61 blocker): genie-host's terminals are a class with private state, and a
        // method called on the proxy instead read `#dataListeners` from it and threw, so a Pilot's hello heard nothing.
        get: (target, key) => {
            if (!(key in target)) return typeof key === 'string' ? () => { throw new Error(needsWindow(`${what}.${key}`)); } : undefined;
            const value = (target as Record<string | symbol, unknown>)[key];
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
    }) as T;
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
    });
    // A model change waiting for its agent to be free applies the moment it is, with or without a window.
    const settingApplier = new SettingApplier(agentOps, (id) => agentShells(ports.engine()?.rowsFor(id) ?? []).count);
    ports.engine()?.subscribe((id) => settingApplier.changed(id as AgentId));
    const activityFeeds = new ActivityFeeds({
        host: {
            subscribe: (listener) => ports.engine()?.subscribe((id) => { if (!ports.windowConnected()) listener(id); }) ?? (() => {}),
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
    const deps: HostApiDeps = {
        ...(ports.schedule ? { schedule: ports.schedule } : {}),
        snapshot: () => registry.snapshot(),
        subscribeSnapshot: (listener) => registry.subscribe(listener),
        subscribeAgentRecords: (listener) => registry.subscribeAgentRecords(listener),
        find: (id) => registry.find(id as AgentId),
        detailFor: (id) => agentDetailFor({ registry, engine: ports.engine(), cwdFor: ports.cwdFor, takeOver: ports.takeOver, mail: (agentId, limit) => ports.inbox.involving(agentId, limit), ...(ports.signedIn ? { providerSignedIn: ports.signedIn } : {}) }, id as AgentId),
        cwdFor: ports.cwdFor,
        startForWork: startOnDemand,
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
            resumeLimit: (provider) => engine().resumeLimit(provider),
            prompt: (id, text, by) => engine().prompt(id, text, by),
            promptWith: (id, text, attachments, by) => engine().promptWith(id, text, attachments, by),
            resolvePrompt: (id, promptId, action) => engine().resolvePrompt(id, promptId, action),
            answerApproval: (id, optionId, note) => engine().answerApproval(id, optionId, note ?? ''),
            subscribe: (listener) => ports.engine()?.subscribe(listener) ?? (() => {}),
        },
        registerAgent: async () => { throw new Error(needsWindow('a new agent')); },
        terminals: windowOnly<HostApiDeps['terminals']>('terminals', ports.terminals),
        uploads: windowOnly<HostApiDeps['uploads']>('inbox.sendFile'),
        files: ports.files,
        serviceEnvFor: () => ({}),
        // Its settings-changed subscription is wired with the events: a no-op here, nothing else of it answers.
        workspaceOps: windowOnly<HostApiDeps['workspaceOps']>('workspaces', {
            onSettingsChanged: () => () => {},
            ...workspaceSettingsOps(() => ports.settings),
            ...workspaceLifecycleApi(lifecycle, lifecycleWiring, () => registry.touch(), setColor),
            ...workspaceTynnApi(() => ports.tynnTab.board(), (id, page, query) => ports.tynnTab.readPage(id, page, query)),
        }),
        agentOps: agentOpsApi(agentOps, () => registry.touch(), () => ports.engine()),
        features: windowOnly<HostApiDeps['features']>('features', {
            // The Deck's answer only (the phone's Deck, deck-answer.ts); the phone reads nothing back from it.
            act: async (action: FeatureAction) => {
                if (action.kind !== 'deck.answer' && action.kind !== 'deck.answerForm') throw new Error(needsWindow(`features.act ${action.kind}`));
                await answerDeck(action, { attention: ports.attention, approvals: ports.approvals, inbox: ports.inbox, deliverToAgent: ports.deliverToAgent });
                return {} as FeatureData;
            },
            onChange: () => () => {},
        }),
        activity: { feeds: (workspaceId) => activityOfWorkspace(activityFeeds, registry.listAgents(), workspaceId), subscribe: (listener) => activityFeeds.subscribe(listener) },
        headroom: ports.headroom,
        updates: ports.updates ?? null,
    };
    return buildHostApi(deps);
}
