import type { ActivityFeed } from '../core/activity-feed.js';
import type { NativeTerminalPort } from './local-terminal-native.js';
import { isLocalTerminalMethod, decodeTerminalNativeArguments } from '../core/local-terminals.js';
import type { Headroom } from '../core/headroom.js';
import { isAcpProvider } from '../core/engine.js';
import { homedir } from 'node:os';
import { listHostDir, makeHostDir } from './host-fs.js';
import { Coalescer, realSchedule } from '../core/coalesce.js';
import { AGENT_PUSH_INTERVAL_MS } from './agent-push.js';
import type { BudgetDecision, DeletePlan, SwitchDecision } from '../core/agent-ops.js';
import type { AgentPermissions, AgentRecord } from '../core/identity.js';
import { cancelIntent, type CancelIntent, type CancelOutcome } from '../core/session.js';
import type { Diagnosis, FolderKind } from '../core/workspace-model.js';
import { LOCAL_EVENTS, RESTRICTED_CALL_CONTEXT, TYPING_EVENT, type CallContext, type RemoteMethod } from '../core/remote-protocol.js';
import { TYPING_MAX_CHARS, type TypingEvent } from '../core/typing-mirror.js';
import type { AgentDetail, GenieSnapshot, UpdateState } from '../renderer/bridge.js';
import type { FeatureAction, FeatureData } from '../renderer/features.js';
import type { HostApi } from './remote-host.js';
import type { PtyOpened, TerminalOptions } from './terminal-host.js';
import type { StartForWork as StartForWorkAnswer } from './start-on-demand.js';
import { attachmentKind, type Attachment } from '../core/prompt-content.js';
import type { BytesResult, FileOpResult, OpenResult } from './files-host.js';
import type { TreeNode } from '../core/files-panel.js';
import { droneRefusal, type WorkstationRole } from '../core/workstation-role.js';
import { decideConnectLink } from '../core/connect-link.js';
import type { AppSourceKind } from '../core/app-inbox.js';
import type { AppInboxCardState } from '../renderer/components/AppInboxCard.js';
import type { RoleChange, TynnWorkstationList, TynnNetworkBridge } from '../renderer/relay-transport.js';
import { isLocalFilesMethod } from '../core/local-files.js';
import { invokeLocalFiles, type LocalFilesDeps } from './local-files-api.js';
import type { FilesWatchPort } from './local-files-watches.js';
import { isLocalDraftMethod } from '../core/local-drafts.js';
import { invokeLocalDrafts, type LocalDraftsStore } from './local-drafts-api.js';
import { isLocalArtboardMethod } from '../core/local-artboard.js';
import type { ToolOutputReply } from '../core/tool-row-bound.js';
import type { AttachmentReply } from '../core/thread-store.js';
import { invokeLocalArtboard, type LocalArtboardPort } from './local-artboard-api.js';
import { isMarketplaceMethod, type MarketplaceApi } from '../core/marketplace.js';
import { isGappMethod, type GAppsApi } from '../core/gapps.js';
import { isPromptAction } from '../core/prompt-delivery.js';
import { answerAccounts, isAccountsMethod, type AccountsPort } from './accounts-protocol.js';
import { readGateRequest } from './approvals-gate-protocol.js';
import { readWindowView } from './host-window-view.js';
import { answerRegistryWrite } from './registry-protocol.js';

/** Business ports for the own window's keys, device memory and Tynn session. No outgoing channel or window port. */
export interface LocalOwnerDeps {
    appInbox: {
        state(workspaceId: string): AppInboxCardState;
        workspaceExists(workspaceId: string): boolean;
        createKey(workspaceId: string, name: string): Promise<{ id: string; token: string }>;
        scriptKeys(workspaceId: string): readonly { id: string }[];
        revokeKey(keyId: string): Promise<unknown>;
        rotate(kind: AppSourceKind, id: string): void;
        revokeSource(source: { kind: AppSourceKind; id: string; workspaceId: string }): Promise<unknown>;
        allowSource(kind: AppSourceKind, id: string): Promise<unknown>;
        restartSource(workspaceId: string, kind: AppSourceKind, id: string): Promise<string>;
    };
    deviceLink?: {
        hosts(): Promise<string[]>;
        forget(url: string): Promise<boolean>;
        adopt(url: string, token: string): Promise<boolean>;
    };
    tynnNetwork: {
        hasAccount(): boolean;
        signedIn(): boolean;
        role(): WorkstationRole | null;
        workstations(): Promise<TynnWorkstationList>;
        /** The Tynn this host is signed in to (Tynn #896, 2b-4); absent or null = none known. */
        host?(): string | null;
        setRole(workstationId: string, role: WorkstationRole, code: string): Promise<RoleChange>;
        rereadRole(): void;
        shares: NonNullable<TynnNetworkBridge['shares']>;
    };
}

/**
 * THE HOST API (§6.8) — what a remote connection may perform on THIS Genie: one `invoke` over the
 * 22 bridge methods and one event stream, built from the same parts the IPC handlers in main.ts use.
 * The parts are PORTS so this is a table under test; main.ts hands in the real registry, session
 * host, terminal host, feature IPC and updater. Host-only methods throw with where to do them — the
 * RemoteHost refuses them before they get here; this is the backstop.
 */

export interface HostApiDeps {
    /** The roster should be read again: an agent was restarted (Tynn #563). */
    rosterChanged?(): void;
    marketplace?: () => MarketplaceApi | null;
    /** The GApp book; `context` is the caller RemoteHost admitted, whose window opens an app (Tynn #898 step 2d-4b). */
    gapps?: (context?: CallContext) => GAppsApi | null;
    /** The GApp book changed: a signal; the window reads the list (Tynn #596). */
    gappsChanged?: { subscribe(listener: () => void): () => void };
    localTerminals?: NativeTerminalPort;
    artboard?: LocalArtboardPort;
    chatDrafts?: LocalDraftsStore;
    filesWatch?: FilesWatchPort;
    /** Following the Tynn tab (P4 family 12, Tynn #561): one view per watch; its signals, by kind and workspace. */
    tynnWatch?: import('../core/local-tynn-watch.js').TynnWatchPort;
    localFiles?: LocalFilesDeps;
    localOwner?: LocalOwnerDeps;
    /** The timer and clock the agent events are coalesced on (core/coalesce.ts). Default: the real ones. */
    schedule?: (ms: number, fn: () => void) => () => void;
    now?: () => number;
    snapshot(): GenieSnapshot;
    subscribeSnapshot(listener: (snapshot: GenieSnapshot) => void): () => void;
    /** Which agent's RECORD changed (a saved setting) — its detail is pushed, as for a session event. */
    subscribeAgentRecords(listener: (agentId: string) => void): () => void;
    /** Inbox messages and receipts change the participants' chats without changing their session or saved record. */
    subscribeAgentChat?(listener: (agentId: string) => void): () => void;
    find(agentId: string): AgentRecord | null;
    detailFor(agentId: string): AgentDetail | null;
    cwdFor(record: AgentRecord): string;
    /**
     * START ON FIRST MESSAGE (q_04ce323c; main/start-on-demand.ts): a message to an agent that is not running starts it
     * first, under the same refusals as Start. Absent = a message to a stopped agent is refused, as before.
     */
    /** May answer later: the agent engine in genie-host answers its start asynchronously (main/start-on-demand.ts). */
    startForWork?(record: AgentRecord): StartForWorkAnswer | Promise<StartForWorkAnswer>;
    /**
     * THE PERSON'S MESSAGE (main/start-on-demand.ts `startForYourMessage`): `startForWork`, and a new driver on the same
     * conversation when the run's own stopped itself (prism-acp 0.37.0). Absent = `startForWork`.
     */
    startForYourMessage?(record: AgentRecord): Promise<StartForWorkAnswer>;
    host: {
        prompt(agentId: AgentRecord['id'], text: string, by?: string | null): boolean | Promise<boolean>;
        start(record: AgentRecord, cwd: string): ({ ok: true } | { ok: false; reason: string }) | Promise<{ ok: true } | { ok: false; reason: string }>;
        stop(agentId: AgentRecord['id']): boolean | Promise<boolean>;
        resolvePrompt?(agentId: AgentRecord['id'], id: string, action: import('../core/prompt-delivery.js').PromptAction): Promise<{ ok: true } | { ok: false; reason: string }>;
        answerApproval(agentId: AgentRecord['id'], optionId: string, note?: string): ({ ok: true } | { ok: false; reason: string }) | Promise<{ ok: true } | { ok: false; reason: string }>;
        /** `Stop this turn`: the current turn ends, the agent keeps running (`SessionHost.cancel`). Never `stop`. */
        cancel(agentId: AgentRecord['id'], intent?: CancelIntent): CancelOutcome | Promise<CancelOutcome>;
        /** `Stop this call` (Tynn #855): one running call's processes end, the turn goes on (`SessionHost.stopToolCall`). Absent = refused. */
        stopToolCall?(agentId: AgentRecord['id'], toolCallId: string): Promise<{ ok: true; ended: number } | { ok: false; reason: string }>;
        /** `Resume now`: the login held for its rate limit opens (Tynn #794) — one account's when named (Tynn #478). */
        resumeLimit(provider: string, accountId?: string): void;
        /** Your message WITH files — the chat composer's attach (`SessionHost.promptWith`); absent = files are refused. */
        promptWith?(agentId: AgentRecord['id'], text: string, attachments: readonly Attachment[], by: string | null): ({ ok: true } | { ok: false; reason: string | null }) | Promise<{ ok: true } | { ok: false; reason: string | null }>;
        subscribe(listener: (agentId: string) => void): () => void;
    };
    /**
     * A MESSAGE'S FILES THAT ARE NOT AN IMAGE OR TEXT, SAVED HERE (Tynn #829): into the agent's workspace on THIS host
     * (main/chat-uploads.ts `saveChatUploads`), each then naming where it went. Absent = such a file is refused, said.
     */
    saveUploads?(record: AgentRecord, files: readonly Attachment[]): Promise<{ ok: true; files: Attachment[] } | { ok: false; reason: string }>;
    /** The New agent form, created on this host (main/agent-create-host.ts): its AGENT.md written, then registered. */
    registerAgent(workspaceId: string, input: { name: string; purpose: string; provider: string }): Promise<{ ok: true; id: string; name: string } | { ok: false; reason: string }>;
    /**
     * TAKE OVER FROM ANOTHER MACHINE (Tynn #529 part A): the TUI started here with NO window here (main/take-over-host.ts
     * `window: false`); the person's machine opens its own window on it. `ended`: that window closed. Absent = Take over
     * is refused with where to do it, as before.
     */
    /**
     * SIGN-INS (Tynn #896): the provider's own login, started on this host for the caller, whose window shows it
     * (host-sign-ins.ts). Absent = this host cannot start one, said in words.
     */
    signIns?: import('./host-sign-ins.js').HostSignIns;
    /** The banner's crash report (Tynn #897, 2c-2), built by genie-host. Absent = this host cannot send one, said in words. */
    crashReports?: { draft(): { text: string }; send(text: string, notes: string): Promise<unknown> };
    /** A provider's program (Tynn #577; #897 2c-3), kept by genie-host (host-provider-programs.ts). Absent = said in words. */
    providerPrograms?: import('./host-provider-programs.js').HostProviderPrograms;
    /** The throwaway shell (Tynn #897, 2c-4), opened by genie-host in the caller's window (scratch-terminal.ts). Absent = said in words. */
    scratchTerminals?: { open(workspaceId: string | null, context?: CallContext): import('./scratch-terminal.js').ScratchAnswer };
    /** A question's files and visuals, read from this host's own Deck (host-question-reads.ts; Tynn #912, 2f-1). Absent = none. */
    questions?: import('./host-question-reads.js').HostQuestionReads;
    /** A file opened, or shown, on this host's own screen for a client on another machine (host-shell.ts; Tynn #912, 2f-1). */
    hostShell?: import('./host-shell.js').HostShell;
    /** What this host runs, as this machine's tray and quit read it, said when it changes (core/host-summary.ts; Tynn #953). */
    hostSummary?: { now(): import('../core/host-summary.js').HostSummary; subscribe(listener: (summary: import('../core/host-summary.js').HostSummary) => void): () => void };
    /** Who is at this machine, as main's own client's notifications read it, said when it changes (core/remote-watch.ts; Tynn #997). */
    remoteWatch?: { now(): import('../core/remote-watch.js').RemoteWatchView; subscribe(listener: (view: import('../core/remote-watch.js').RemoteWatchView) => void): () => void };
    /** genie-host's settings, as main's own client reads them, said when they change (settings-watch.ts; Tynn #998). */
    settingsWatch?: { now(): import('./settings-watch.js').SettingsWatchView; subscribe(listener: (view: import('./settings-watch.js').SettingsWatchView) => void): () => void };
    /** A window's transport to another machine, owned by its connection (device-link-protocol.ts; Tynn #941, 2f-2). */
    deviceLinkProtocol?: Pick<import('./device-link-protocol.js').DeviceLinkProtocol, 'call' | 'dropOwner'>;
    /** What an older Genie sealed, adopted into this host's keychain (host-legacy-adopt.ts; Tynn #959, 2g-3b). Absent = refused. */
    legacySecrets?: { adopt(request: unknown): Promise<unknown> };
    /** A window-run tool's approval, from this host's one queue, tied to the agent's call by its forwarded id (Tynn #1006). */
    /** What this machine's window says of the person: whether they are at the computer (host-window-view.ts; Tynn #1044). */
    windowView?: { userActive(active: boolean): void };
    approvalsGate?: (caller: import('./mcp-tools.js').Caller, action: string, detail: string, forwardedCallId: string | null) => Promise<'allowed' | 'denied' | 'expired'>;
    /** genie-host's registry, read and written by main's window registry (registry-protocol.ts; Tynn #1007). Absent = refused. */
    registryFiles?: import('./registry-protocol.js').RegistryFiles;
    /** Ask Tynn again whether this host is signed in (Tynn #959, 2g-3b). Absent = refused. */
    tynnRecheck?: () => Promise<void>;
    takeOver?: {
        start(agentId: string): Promise<{ ok: true; terminalId: string; started?: boolean } | { ok: false; reason: string }>;
        ended(terminalId: string): void;
    };
    terminals: {
        open(options: TerminalOptions): PtyOpened;
        /** `open`, answered once the pid and shell are known (a pty made under genie-host). Absent = `open`'s answer is it. */
        openReady?(options: TerminalOptions): Promise<PtyOpened>;
        write(id: string, data: string): boolean;
        resize(id: string, cols: number, rows: number): boolean;
        close(id: string): boolean;
        list(): readonly { id: string; pid: number; shell: string; workspaceId: string }[];
        attach(id: string): { id: string; pid: number; shell: string; workspaceId: string; scrollback: string } | null;
        onData(listener: (id: string, data: string) => void): () => void;
        onExit(listener: (id: string, exitCode: number) => void): () => void;
    };
    /** A phone's upload (§6.8): the bytes land in a temp file for exactly as long as the inbox copies them. */
    uploads: {
        sendFile(to: string, text: string, name: string, bytes: Uint8Array): Promise<{ ok: true; messageId: string } | { ok: false; reason: string }>;
    };
    /**
     * THE PHONE'S FILES (genie#1346): the files host the panel uses (main/files-host.ts) — confined to the workspace, under
     * its size cap — and an upload into a folder of it. Absent = the phone's file browser is told this host has none.
     */
    files?: {
        children(workspaceId: string, dir: string): Promise<readonly TreeNode[] | null>;
        open(workspaceId: string, path: string): Promise<OpenResult>;
        readBytes(workspaceId: string, path: string): Promise<BytesResult>;
        upload(workspaceId: string, dir: string, name: string, bytes: Uint8Array): Promise<FileOpResult>;
    };
    serviceEnvFor(workspaceId: string): Record<string, string>;
    workspaceOps: {
        /** The plan for adding the folder picked in the window (Tynn #835) — nothing is written. */
        previewAdd?(path: string): Promise<unknown>;
        /** The parent folder is picked in the window too (Tynn #835). */
        previewAddFromGit?(url: string, parent: string): Promise<unknown>;
        tynnProjects?(): Promise<unknown>;
        /** Creating a Tynn project from the optional link (Add workspace parity item 5); optional, refused where absent. */
        tynnOwnerOptions?(): Promise<unknown>;
        createTynnProject?(input: unknown): Promise<unknown>;
        /** "It came with agents" (Add workspace parity item 6); optional, refused where absent. */
        importedAgents?(workspaceId: string): Promise<unknown>;
        adoptAgent?(workspaceId: string, name: string): Promise<unknown>;
        previewAddFromTynn?(projectId: string, parent: string): Promise<unknown>;
        locateRepo?(workspaceId: string, slug: string, path: string): Promise<unknown>;
        confirmAdd(path: string): Promise<unknown>;
        /**
         * `remote`: the window's None / GitHub / Paste URL choice, unparsed (main parses it; Add workspace parity 11).
         * `tynnProjectId`: the optional Tynn link (parity 5), looked up in Tynn's own list on the host.
         */
        create(name: string, parent: string, remote?: unknown, tynnProjectId?: string): Promise<unknown>;
        confirmAddFromGit(url: string, parent: string): Promise<unknown>;
        /** The Open existing / Import from Git wizard (Add workspace parity item 7); optional, refused where absent. */
        readSource?(path: string): Promise<unknown>;
        stageFromGit?(url: string): Promise<unknown>;
        registerExisting?(path: string): Promise<unknown>;
        buildEnvelope?(plan: unknown, remote?: unknown): Promise<unknown>;
        discardStaged?(path: string): Promise<unknown>;
        /** Import from Git's browser: the repositories this host's GitHub sign-in reaches (Add workspace parity item 8). */
        githubRepos?(): Promise<unknown>;
        confirmAddFromTynn(parent: string, projectId: string): Promise<unknown>;
        hibernate(workspaceId: string): Promise<unknown>;
        wake(workspaceId: string): Promise<unknown>;
        remove(workspaceId: string): Promise<unknown>;
        listRepos(workspaceId: string): Promise<unknown>;
        /** The Tynn tab (genie#1295): the workspace's Tynn board at a scope, and one action on it. Optional: refused where absent. */
        tynnBoard?(workspaceId: string, scope: unknown): Promise<unknown>;
        tynnBoardAction?(workspaceId: string, input: unknown): Promise<unknown>;
        /** The tab's other pages (WIP, …), read whole. Optional: refused where absent. */
        tynnPage?(workspaceId: string, page: unknown, query: unknown): Promise<unknown>;
        /** The Tynn tab's Issues (genie#1295 I1): the workspace's issue queue under filters, and one action on it. */
        tynnIssues?(workspaceId: string, filters: unknown): Promise<unknown>;
        tynnIssueAction?(workspaceId: string, input: unknown): Promise<unknown>;
        /** One write on a page of the tab (the Home's Details save, genie#1295 H1). Optional: refused where absent. */
        tynnPageAction?(workspaceId: string, input: unknown): Promise<unknown>;
        /** What changed on the board / the issue queue since a cursor (P4 family 12): the live tab's reads. */
        tynnBoardChanges?(workspaceId: string, scope: unknown, cursor: string, ids: readonly string[]): Promise<unknown>;
        tynnIssueChanges?(workspaceId: string, filters: unknown, cursor: string, ids: readonly string[]): Promise<unknown>;
        addRepo(workspaceId: string, input: { name: string; path: string }): Promise<unknown>;
        removeRepo(workspaceId: string, slug: string): Promise<unknown>;
        /** Optional: a host without it answers the call with a refusal rather than failing to build its deps. */
        removeRepoLock?(workspaceId: string, slug: string): Promise<unknown>;
        /** Optional for the same reason: a host without it answers with a refusal. */
        commitsSince?(workspaceId: string, sinceMs: number): Promise<unknown>;
        settings(workspaceId: string): Promise<unknown> | unknown;
        setSetting(workspaceId: string, key: string, value: unknown): Promise<unknown>;
        resetSetting(workspaceId: string, key: string): Promise<unknown>;
        onSettingsChanged?(listener: (workspaceId: string) => void): () => void;
        setGoverns(workspaceId: string, childIds: readonly string[]): Promise<unknown>;
        setDefaultAgent(workspaceId: string, agentId: string | null): Promise<unknown>;
        /** One MCP server on or off as this workspace's default (Tynn #628); checked by the registry, which refuses in words. */
        setMcpServer(workspaceId: string, name: unknown, on: unknown): Promise<unknown>;
        /** A workspace's colour (genie#1300). Optional: a host without it refuses. */
        setColor?(workspaceId: string, color: string): Promise<unknown>;
        /** Save to repo (Tynn #756): the preview, then the save with the person's choices. Optional: a host without them refuses. */
        savePreview?(workspaceId: unknown): Promise<unknown>;
        save?(workspaceId: unknown, choices: unknown): Promise<unknown>;
        /** The offers a clone's repo brings (Tynn #756): listed, and one applied. Optional: a host without them refuses. */
        cloneOffers?(workspaceId: unknown): Promise<unknown>;
        applyOffer?(workspaceId: unknown, offerId: unknown): Promise<unknown>;
    };
    agentOps: {
        /** THE ONE RESTART (genie#1238): `restartAgent` — 'graceful' from every state, delivering what is owed. */
        restart(agentId: string, kind: 'graceful' | 'fresh'): Promise<{ ok: true; kind: 'graceful' | 'fresh'; discarded?: string | null } | { ok: false; reason: string }>;
        previewDelete(agentId: string, outcome: 'unmount' | 'delete', alsoRemoveFrom: readonly string[]): Promise<{ ok: true; plan: DeletePlan } | { ok: false; reason: string }>;
        /** `handoff`: ask a running agent for a handoff first (bounded wait); see agent-ops-host `deleteAgent`. */
        delete(agentId: string, outcome: 'unmount' | 'delete', alsoRemoveFrom: readonly string[], handoff: boolean): Promise<{ ok: true; plan: DeletePlan } | { ok: false; reason: string }>;
        switchDriver(agentId: string, to: string): Promise<SwitchDecision>;
        setBudget(agentId: string, dailyLimitUsd: number | null): Promise<{ ok: true; decision: BudgetDecision } | { ok: false; reason: string }>;
        /** Its app wake cap (Tynn #1053): a whole number of wakes an hour, or `unlimited`; checked by the operation, which refuses in words. */
        setAppWakeCap(agentId: string, cap: unknown): Promise<unknown>;
        setMode(agentId: string, mode: 'automated' | 'manual'): Promise<unknown>;
        setAccessScope(agentId: string, scope: 'none' | 'self' | 'all'): Promise<unknown>;
        /** Chosen agents who may message it (Tynn #526); `null` turns the choice off. */
        setAccessAgents(agentId: string, ids: readonly string[] | null): Promise<unknown>;
        setAutoApprove(agentId: string, on: boolean): Promise<unknown>;
        setManageTabs(agentId: string, on: boolean): Promise<unknown>;
        setDrivePages(agentId: string, on: boolean): Promise<unknown>;
        /** One MCP server on or off for this agent (Tynn #628); checked by the operation itself, which refuses in words. */
        setMcpServer(agentId: string, name: unknown, on: unknown): Promise<unknown>;
        setIssueWatch(agentId: string, setting: unknown): Promise<unknown>;
        setPermissions(agentId: string, permissions: AgentPermissions): Promise<unknown>;
        setModel(agentId: string, model: string | null): Promise<unknown>;
        /** The provider's models for the agent's picker; `refresh` asks the provider again. */
        models(agentId: string, refresh: boolean): Promise<unknown>;
        diagnose(agentId: string): Promise<{ ok: true; diagnosis: Diagnosis } | { ok: false; reason: string }>;
        /** A tool row's whole output, from the host's store, bounded (Tynn story #386). Absent = previews only. */
        toolOutput?(agentId: string, toolCallId: string): Promise<ToolOutputReply>;
        /** One image a thread kept (Tynn #642), for a sent message's pill. */
        attachment?(agentId: string, attachmentId: string): Promise<AttachmentReply>;
    };
    /** Every agent's activity feed (the Dashboard's lanes, beta.33 item 10): one workspace's, and each as it changes. */
    activity?: {
        feeds(workspaceId: string): Readonly<Record<string, ActivityFeed>>;
        subscribe(listener: (feed: ActivityFeed) => void): () => void;
    };
    /** Buffered provider readings, with the native initial read and subsequent changes. */
    headroom?: {
        view(): Readonly<Record<string, Headroom>>;
        subscribe(listener: (room: Readonly<Record<string, Headroom>>) => void): () => void;
    };
    retryPausedAccount?(provider: string): void;
    /** The host's account book (Tynn #895): the account chips' read, rename/forget and Not now. Absent = no accounts here. */
    accounts?: AccountsPort;
    features: {
        /** The admitted caller, so view state can stay with the connection that requested it (Tynn #720). */
        snapshot(context: CallContext): Promise<FeatureData>;
        act(action: FeatureAction, context: CallContext): Promise<FeatureData>;
        /** An alert's own sound as a data URL, by its setting key; `null` when it cannot be read (P4 family 11). */
        soundData?(key: string): Promise<string | null>;
        /** What the host's own file picker picked, from this machine's window: the only host paths a send may attach (genie#1354). */
        picked?(paths: unknown[], context: CallContext): void | Promise<void>;
        /** Connection teardown, supplied internally by the protocol owner. */
        releaseCaller?(context: CallContext): void;
        onChange?(listener: (data: FeatureData) => void): () => void;
        onInvalidated?(listener: () => void): () => void;
    };
    updates: {
        state(): UpdateState;
        check(): Promise<UpdateState>;
        download(): Promise<boolean>;
        install(): Promise<{ report: string }> | null;
        forceDrain?(): boolean | Promise<boolean>;
        notes?(): Promise<UpdateState | null>;
        /** Abandon a drain in progress (§7.5); `false` when there is none. */
        onChange(listener: (state: UpdateState) => void): () => void;
    } | null;
}

const TYNN_NO_ACTION = { ok: false, state: 'error', reason: 'name a workspace and an action' } as const;
const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));
const num = (v: unknown): number | undefined => (typeof v === 'number' && v > 0 ? Math.floor(v) : undefined);
const named = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** A host with no sign-ins wired (a test's, or one still starting) says so. */
export const SIGN_IN_UNAVAILABLE = 'this host cannot start a sign-in';

export function buildHostApi(deps: HostApiDeps): HostApi {
    const agent = (id: unknown): AgentRecord | null => deps.find(str(id));
    /** The typing relay's listeners: each event stream (onEvent) while it is open (Tynn #730). */
    const typingListeners = new Set<(event: TypingEvent) => void>();
    const owner = (): LocalOwnerDeps => {
        if (!deps.localOwner) throw new Error('this host has no local owner operations');
        return deps.localOwner;
    };

    const invoke = async (method: RemoteMethod, args: unknown[], context: CallContext = RESTRICTED_CALL_CONTEXT): Promise<unknown> => {
        if (isMarketplaceMethod(method)) throw new Error('Marketplace actions require their authenticated local window connection.');
        if (isGappMethod(method)) throw new Error('GApp actions require their authenticated local window connection.');
        if (isLocalTerminalMethod(method)) {
            if (!deps.localTerminals) throw new Error('the local terminal service is not available');
            const name = method.slice('terminals.local'.length).toLowerCase();
            if (!['open', 'write', 'resize', 'close', 'list', 'attach'].includes(name)) throw new Error('terminal stream control requires its authenticated local connection');
            return deps.localTerminals.invoke(name, decodeTerminalNativeArguments(name, args));
        }
        if (isLocalFilesMethod(method)) return invokeLocalFiles(deps.localFiles, method, args);
        if (isLocalDraftMethod(method)) return invokeLocalDrafts(deps.chatDrafts, deps.find, method, args);
        if (isLocalArtboardMethod(method)) return invokeLocalArtboard(deps.artboard, method, args);
        if (isAccountsMethod(method)) return answerAccounts(deps.accounts, method, args, context);
        switch (method) {
            case 'appInbox.state':
                return named(args[0]) ? { ok: true, state: owner().appInbox.state(args[0]) } : { ok: false, reason: 'name a workspace' };
            case 'appInbox.createKey': {
                const [workspaceId, name] = args;
                if (!named(workspaceId) || typeof name !== 'string') return { ok: false, reason: 'name a workspace and the key' };
                const inbox = owner().appInbox;
                if (!inbox.workspaceExists(workspaceId)) return { ok: false, reason: `no workspace ${workspaceId}` };
                try {
                    const made = await inbox.createKey(workspaceId, name);
                    return { ok: true, id: made.id, name: name.trim(), token: made.token, state: inbox.state(workspaceId) };
                } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
            }
            case 'appInbox.revokeKey': {
                const [workspaceId, keyId] = args;
                if (!named(workspaceId) || !named(keyId)) return { ok: false, reason: 'name a workspace and the key' };
                const inbox = owner().appInbox;
                if (!inbox.scriptKeys(workspaceId).some(k => k.id === keyId)) return { ok: false, reason: 'that key is not one of this workspace’s' };
                await inbox.revokeKey(keyId);
                return { ok: true, state: inbox.state(workspaceId) };
            }
            case 'appInbox.source': {
                const [workspaceId, op, kind, id] = args;
                if (!named(workspaceId) || (op !== 'rotate' && op !== 'revoke' && op !== 'allow') || (kind !== 'site' && kind !== 'process') || !named(id)) return { ok: false, reason: 'rotate, revoke or allow a site or a process' };
                const inbox = owner().appInbox;
                try {
                    if (op === 'rotate') inbox.rotate(kind, id);
                    else if (op === 'revoke') await inbox.revokeSource({ kind, id, workspaceId });
                    else await inbox.allowSource(kind, id);
                    const after = await inbox.restartSource(workspaceId, kind, id);
                    return { ok: true, text: `${op === 'rotate' ? 'Rotated' : op === 'revoke' ? 'Revoked' : 'Allowed'}: ${after}`, state: inbox.state(workspaceId) };
                } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
            }
            case 'deviceLink.hosts': return (await owner().deviceLink?.hosts()) ?? [];
            case 'deviceLink.forget': return typeof args[0] === 'string' ? (await owner().deviceLink?.forget(args[0])) ?? false : false;
            case 'deviceLink.adopt': return typeof args[0] === 'string' && typeof args[1] === 'string' ? (await owner().deviceLink?.adopt(args[0], args[1])) ?? false : false;
            case 'tynnNetwork.workstations': {
                const network = owner().tynnNetwork;
                if (!network.hasAccount()) return { ok: false, reason: 'this Genie has no Tynn account' };
                const refused = droneRefusal(network.role());
                if (refused) return { ok: false, reason: refused };
                return network.workstations();
            }
            // A pasted share link, decided HERE with the host's Tynn and the role Tynn gave it; the window opens it (2b-4).
            case 'tynnNetwork.classifyLink': {
                const network = owner().tynnNetwork;
                const host = network.hasAccount() && network.signedIn() ? network.host?.() ?? null : null;
                return decideConnectLink(str(args[0]), host, network.role());
            }
            case 'tynnNetwork.setRole': {
                const network = owner().tynnNetwork, [workstationId, role, code] = args;
                const refused = droneRefusal(network.role());
                if (refused) return { ok: false, reason: refused };
                if (typeof workstationId !== 'string' || (role !== 'pilot' && role !== 'drone') || typeof code !== 'string') return { ok: false, reason: 'not a role change' };
                if (!network.signedIn()) return { ok: false, reason: 'Sign in to Tynn to change a workstation’s role' };
                const result = await network.setRole(workstationId, role, code);
                if (result.ok) network.rereadRole();
                return result;
            }
            case 'tynnNetwork.shares.list': return owner().tynnNetwork.shares.list(typeof args[0] === 'string' ? args[0] : null);
            case 'tynnNetwork.shares.mint': {
                const input = (args[0] ?? {}) as { workspaceId?: unknown; capability?: unknown; expiresInDays?: unknown };
                return owner().tynnNetwork.shares.mint({ workspaceId: typeof input.workspaceId === 'string' ? input.workspaceId : null,
                    capability: input.capability === 'readonly' ? 'readonly' : 'control', expiresInDays: typeof input.expiresInDays === 'number' ? input.expiresInDays : 7 });
            }
            case 'tynnNetwork.shares.revoke': return typeof args[0] === 'string' ? owner().tynnNetwork.shares.revoke(args[0]) : { ok: false, reason: 'not a link' };
            case 'snapshot':
                return deps.snapshot();
            case 'agentDetail':
                return deps.detailFor(str(args[0]));
            case 'openAgent': {
                // Opening SHOWS the agent (q_04ce323c): nothing starts. Its first message, or Start, starts it.
                const r = agent(args[0]);
                return r ? { ok: true } : { ok: false, reason: 'unknown agent' };
            }
            case 'stopAgent': {
                const r = agent(args[0]);
                return { ok: r ? await deps.host.stop(r.id) : false };
            }
            case 'resumeLimit': {
                const r = agent(args[0]);
                if (!r) return { ok: false, reason: 'unknown agent' };
                // Every agent of a provider is on its active account (Tynn #751): Resume now opens that account's hold.
                deps.host.resumeLimit(r.provider);
                return { ok: true };
            }
            case 'cancelTurn': {
                const r = agent(args[0]);
                // A remote window's Stop this turn or Interrupt and send: only `interrupt` is an interrupt (Tynn #672 part 3).
                return r ? deps.host.cancel(r.id, cancelIntent(args[1])) : { ok: false, reason: 'unknown agent' };
            }
            case 'stopToolCall': {
                // Stop this call (Tynn #855): the person's, from any window or phone; the call's own processes only.
                const r = agent(args[0]);
                if (!r) return { ok: false, reason: 'unknown agent' };
                if (typeof args[1] !== 'string' || args[1] === '') return { ok: false, reason: 'Stop this call names the call' };
                if (!deps.host.stopToolCall) return { ok: false, reason: 'this host cannot stop one call; Stop the turn instead' };
                return deps.host.stopToolCall(r.id, args[1]);
            }
            case 'prompt': {
                const r = agent(args[0]);
                const text = str(args[1]);
                // With files (a phone's photo, genie#1346): the chat's own attach path, by YOU — never sent without them.
                let attachments: Attachment[] | null = null;
                if (Array.isArray(args[2])) {
                    attachments = attachmentsOf(args[2]);
                    if (!r) return { ok: false, reason: 'unknown agent' };
                    if (attachments === null || attachments.length === 0) return { ok: false, reason: 'an attachment is not a file' };
                    // ANY FILE (Tynn #829): saved into the agent's workspace on THIS host first — one that is not an image
                    // or text goes as its path. A refused save is said, and nothing is started or sent.
                    if (attachments.some((a) => attachmentKind(a) === 'file')) {
                        if (!deps.saveUploads) return { ok: false, reason: `${attachments.find((a) => attachmentKind(a) === 'file')!.name} was not sent: this host cannot save a file that is not an image or text into a workspace` };
                        const saved = await deps.saveUploads(r, attachments);
                        if (!saved.ok) return { ok: false, reason: saved.reason };
                        attachments = saved.files;
                    }
                }
                // THE FIRST MESSAGE STARTS IT (q_04ce323c), as the composer's does; a refused start is said, nothing sent.
                if (r && (deps.startForYourMessage || deps.startForWork) && (text.length > 0 || Array.isArray(args[2]))) {
                    const started = deps.startForYourMessage ? await deps.startForYourMessage(r) : await deps.startForWork!(r);
                    if (!started.ok) return { ok: false, reason: started.reason };
                }
                if (attachments !== null && r) {
                    if (!deps.host.promptWith) return { ok: false, reason: 'this host does not take files in a message' };
                    const sent = await deps.host.promptWith(r.id, text, attachments, 'you');
                    return sent.ok ? { ok: true } : { ok: false, ...(sent.reason ? { reason: sent.reason } : {}) };
                }
                // Text alone goes the composer's way too when the host has it, so a refusal (a slash command the agent
                // does not offer, Tynn #440) comes back with its reason rather than a bare `false`.
                if (r !== null && text.length > 0 && deps.host.promptWith) {
                    const sent = await deps.host.promptWith(r.id, text, [], 'you');
                    return sent.ok ? { ok: true } : { ok: false, ...(sent.reason ? { reason: sent.reason } : {}) };
                }
                return { ok: r !== null && text.length > 0 && (await deps.host.prompt(r.id, text, 'you')) };
            }
            case 'resolvePrompt': {
                const r = agent(args[0]);
                const action = args[2];
                // Withdraw / Edit a queued message (Tynn #843) cross from a Pilot window exactly as Send / Discard do.
                if (!r || typeof args[1] !== 'string' || !isPromptAction(action)) return { ok: false, reason: 'Invalid draft action.' };
                return deps.host.resolvePrompt?.(r.id, args[1], action) ?? { ok: false, reason: 'This host does not support queued drafts.' };
            }
            case 'answerApproval': {
                const r = agent(args[0]);
                // Every refusal names its reason: the card that pressed says it (core/approval-answering.ts).
                if (!r) return { ok: false, reason: 'Genie does not know this agent' };
                if (typeof args[1] !== 'string') return { ok: false, reason: 'no option was chosen' };
                return deps.host.answerApproval(r.id, args[1], typeof args[2] === 'string' ? args[2] : '');
            }
            case 'addAgent': {
                if (typeof args[0] !== 'string') return { ok: false, reason: 'no workspace named' };
                const raw = (typeof args[1] === 'object' && args[1] !== null ? args[1] : {}) as Record<string, unknown>;
                const created = await deps.registerAgent(str(args[0]), { name: str(raw['name']), purpose: str(raw['purpose']), provider: str(raw['provider']) });
                return created.ok ? { ok: true, id: created.id } : created;
            }
            case 'agents.restart':
                if (typeof args[0] !== 'string' || (args[1] !== 'graceful' && args[1] !== 'fresh')) return { ok: false, reason: 'a restart names an agent and a kind: graceful or fresh' };
                return deps.agentOps.restart(args[0], args[1]);
            case 'agents.previewDelete':
                if (typeof args[0] !== 'string' || (args[1] !== 'unmount' && args[1] !== 'delete')) return { ok: false, reason: 'a delete names an agent and an outcome: unmount or delete' };
                return deps.agentOps.previewDelete(args[0], args[1], Array.isArray(args[2]) ? args[2].map(String) : []);
            case 'agents.delete':
                if (typeof args[0] !== 'string' || (args[1] !== 'unmount' && args[1] !== 'delete')) return { ok: false, reason: 'a delete names an agent and an outcome: unmount or delete' };
                return deps.agentOps.delete(args[0], args[1], Array.isArray(args[2]) ? args[2].map(String) : [], args[3] === true);
            case 'agents.switchDriver':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'string') return { ok: false, reason: 'a switch names an agent and a provider' };
                return deps.agentOps.switchDriver(args[0], args[1]);
            case 'agents.setBudget':
                if (typeof args[0] !== 'string' || (args[1] !== null && !(typeof args[1] === 'number' && args[1] >= 0))) return { ok: false, reason: 'a budget is a non-negative number of dollars, or null to clear it' };
                return deps.agentOps.setBudget(args[0], args[1] as number | null);
            case 'agents.setAppWakeCap':
                if (typeof args[0] !== 'string') return { ok: false, reason: 'unknown agent' };
                return deps.agentOps.setAppWakeCap(args[0], args[1]);
            case 'agents.setMode':
                if (typeof args[0] !== 'string' || (args[1] !== 'automated' && args[1] !== 'manual')) return { ok: false, reason: 'mode is automated or manual' };
                return deps.agentOps.setMode(args[0], args[1]);
            case 'agents.setAutoApprove':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'boolean') return { ok: false, reason: 'autonomy is on or off' };
                return deps.agentOps.setAutoApprove(args[0], args[1]);
            case 'agents.setManageTabs':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'boolean') return { ok: false, reason: 'managing tabs is on or off' };
                return deps.agentOps.setManageTabs(args[0], args[1]);
            case 'agents.setDrivePages':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'boolean') return { ok: false, reason: 'driving pages is on or off' };
                return deps.agentOps.setDrivePages(args[0], args[1]);
            case 'agents.setMcpServer':
                if (typeof args[0] !== 'string') return { ok: false, reason: 'Name the MCP server, and say on or off.' };
                return deps.agentOps.setMcpServer(args[0], args[1], args[2]);
            case 'agents.setIssueWatch':
                if (typeof args[0] !== 'string') return { ok: false, reason: 'unknown agent' };
                return deps.agentOps.setIssueWatch(args[0], args[1]);
            case 'agents.setAccessScope':
                if (typeof args[0] !== 'string' || (args[1] !== 'none' && args[1] !== 'self' && args[1] !== 'all')) return { ok: false, reason: 'scope is none, self or all' };
                return deps.agentOps.setAccessScope(args[0], args[1]);
            case 'agents.setAccessAgents':
                if (typeof args[0] !== 'string' || !(args[1] === null || (Array.isArray(args[1]) && args[1].length <= 500 && args[1].every((id) => typeof id === 'string')))) return { ok: false, reason: 'chosen agents are a list of agent ids, or null to turn the choice off' };
                return deps.agentOps.setAccessAgents(args[0], args[1] as readonly string[] | null);
            case 'agents.setPermissions':
                if (typeof args[0] !== 'string' || (args[1] !== 'all' && args[1] !== 'edits' && args[1] !== 'ask')) return { ok: false, reason: 'permissions are all, ask or edits' };
                return deps.agentOps.setPermissions(args[0], args[1]);
            case 'agents.setModel':
                if (typeof args[0] !== 'string' || (args[1] !== null && typeof args[1] !== 'string')) return { ok: false, reason: 'a model is a name, or null for the provider default' };
                // Only explicit null clears it. The operation keeps its existing empty-name refusal.
                return deps.agentOps.setModel(args[0], args[1]);
            case 'agents.models':
                if (typeof args[0] !== 'string') return { ok: false, reason: 'unknown agent' };
                // Only an explicit `true` asks the provider again: a refresh starts its CLI.
                return deps.agentOps.models(args[0], args[1] === true);
            case 'agents.diagnose':
                if (typeof args[0] !== 'string') return { ok: false, reason: 'diagnose names an agent' };
                return deps.agentOps.diagnose(args[0]);
            case 'agents.toolOutput':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'string' || args[1] === '') return { ok: false, reason: 'toolOutput names an agent and a tool call' };
                return deps.agentOps.toolOutput ? deps.agentOps.toolOutput(args[0], args[1]) : { ok: false, reason: 'this host keeps no tool outputs' };
            case 'agents.attachment':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'string' || args[1] === '') return { ok: false, reason: 'attachment names an agent and an image' };
                return deps.agentOps.attachment ? deps.agentOps.attachment(args[0], args[1]) : { ok: false, reason: 'this host keeps no images' };
            /*
             * WHAT A COMPOSER HOLDS NOW (Tynn #730): relayed, never kept, to every window on this machine and every remote one
             * (RemoteHost filters a guest to its workspace). Whoever typed is the CALLER, as RemoteHost admitted it: this
             * machine's own window is `null`, anyone else by their connection's label. Nothing the caller says names them.
             */
            case 'agents.typing': {
                const r = agent(args[0]);
                if (!r || typeof args[1] !== 'string' || typeof args[2] !== 'string' || args[2] === '' || args[2].length > 64) return { ok: false, reason: 'typing names an agent, its text and the window' };
                const event: TypingEvent = { agentId: r.id, text: args[1].slice(0, TYPING_MAX_CHARS), source: args[2], label: context.origin === 'local-window' ? null : context.label };
                for (const listener of [...typingListeners]) listener(event);
                return { ok: true };
            }
            case 'workspaces.previewAdd':
                // Preserve the retired native wizard's early refusals before any coercion or disk operation.
                if (typeof args[0] !== 'string' || args[0] === '') return { ok: false, reason: 'no folder picked' };
                if (!deps.workspaceOps.previewAdd) throw new Error('this host cannot preview adding a folder');
                return deps.workspaceOps.previewAdd(args[0]);
            case 'workspaces.previewAddFromGit':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'string' || args[1] === '') return { ok: false, reason: 'give a git URL and a parent folder' };
                if (!deps.workspaceOps.previewAddFromGit) throw new Error('this host cannot preview a clone');
                return deps.workspaceOps.previewAddFromGit(args[0], args[1]);
            case 'workspaces.confirmAddFromGit':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'string') return { ok: false, reason: 'give a git URL and a parent folder' };
                return deps.workspaceOps.confirmAddFromGit(args[0], args[1]);
            case 'workspaces.readSource':
                if (typeof args[0] !== 'string' || args[0] === '') return { ok: false, reason: 'no folder picked' };
                if (!deps.workspaceOps.readSource) throw new Error('this host cannot read a folder to set it up');
                return deps.workspaceOps.readSource(args[0]);
            case 'workspaces.stageFromGit':
                if (typeof args[0] !== 'string' || args[0].trim() === '') return { ok: false, reason: 'give a git URL' };
                if (!deps.workspaceOps.stageFromGit) throw new Error('this host cannot import from git');
                return deps.workspaceOps.stageFromGit(args[0]);
            case 'workspaces.registerExisting':
                if (typeof args[0] !== 'string' || args[0] === '') return { ok: false, reason: 'no folder picked' };
                if (!deps.workspaceOps.registerExisting) throw new Error('this host cannot add an existing workspace');
                return deps.workspaceOps.registerExisting(args[0]);
            case 'workspaces.buildEnvelope':
                if (!deps.workspaceOps.buildEnvelope) throw new Error('this host cannot build a workspace');
                return deps.workspaceOps.buildEnvelope(args[0], args[1]);
            case 'workspaces.discardStaged':
                if (typeof args[0] !== 'string') return { ok: true };
                if (!deps.workspaceOps.discardStaged) throw new Error('this host cannot discard an import');
                return deps.workspaceOps.discardStaged(args[0]);
            case 'workspaces.githubRepos':
                if (!deps.workspaceOps.githubRepos) throw new Error('this host cannot list GitHub repositories');
                return deps.workspaceOps.githubRepos();
            case 'workspaces.locateRepo':
                if (!deps.workspaceOps.locateRepo) throw new Error('this host cannot locate a repo');
                return deps.workspaceOps.locateRepo(str(args[0]), str(args[1]), str(args[2]));
            case 'workspaces.tynnOwnerOptions':
                if (!deps.workspaceOps.tynnOwnerOptions) throw new Error('this host cannot create Tynn projects');
                return deps.workspaceOps.tynnOwnerOptions();
            case 'workspaces.createTynnProject':
                if (!deps.workspaceOps.createTynnProject) throw new Error('this host cannot create Tynn projects');
                return deps.workspaceOps.createTynnProject(args[0]);
            case 'workspaces.importedAgents':
                if (typeof args[0] !== 'string') return { ok: false, reason: 'name a workspace' };
                if (!deps.workspaceOps.importedAgents) throw new Error('this host cannot read a workspace’s agent files');
                return deps.workspaceOps.importedAgents(args[0]);
            case 'workspaces.adoptAgent':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'string' || args[1] === '') return { ok: false, reason: 'name a workspace and an agent' };
                if (!deps.workspaceOps.adoptAgent) throw new Error('this host cannot adopt agents');
                return deps.workspaceOps.adoptAgent(args[0], args[1]);
            case 'workspaces.tynnProjects':
                if (!deps.workspaceOps.tynnProjects) throw new Error('this host cannot list Tynn projects');
                return deps.workspaceOps.tynnProjects();
            case 'workspaces.previewAddFromTynn':
                if (typeof args[0] !== 'string' || args[0] === '' || typeof args[1] !== 'string' || args[1] === '') return { ok: false, reason: 'choose a Tynn project and a parent folder' };
                if (!deps.workspaceOps.previewAddFromTynn) throw new Error('this host cannot preview a Tynn envelope');
                return deps.workspaceOps.previewAddFromTynn(args[0], args[1]);
            case 'workspaces.confirmAddFromTynn':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'string') return { ok: false, reason: 'give a parent folder and a Tynn project' };
                return deps.workspaceOps.confirmAddFromTynn(args[0], args[1]);
            case 'workspaces.create':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'string') return { ok: false, reason: 'give the workspace a name and a folder' };
                return deps.workspaceOps.create(args[0], args[1], args[2], typeof args[3] === 'string' && args[3] !== '' ? args[3] : undefined);
            case 'workspaces.confirmAdd':
                if (typeof args[0] !== 'string') return { ok: false, reason: 'confirmAdd names a folder' };
                return deps.workspaceOps.confirmAdd(args[0]);
            // P4 family 10 (Tynn #559): the window's own calls now come this way; a call that names no workspace is
            // refused in the words the IPC path used, never run on a made-up id.
            case 'workspaces.hibernate':
                return typeof args[0] === 'string' ? deps.workspaceOps.hibernate(args[0]) : { ok: false, reason: 'hibernate names a workspace' };
            case 'workspaces.wake':
                return typeof args[0] === 'string' ? deps.workspaceOps.wake(args[0]) : { ok: false, reason: 'wake names a workspace' };
            case 'workspaces.remove':
                return typeof args[0] === 'string' ? deps.workspaceOps.remove(args[0]) : { ok: false, reason: 'remove names a workspace' };
            // THE TYNN TAB (P4 family 12, Tynn #561): the window's own calls come this way now, with the IPC path's refusals.
            case 'workspaces.tynnBoard':
                if (!deps.workspaceOps.tynnBoard) throw new Error('this host has no Tynn tab');
                return typeof args[0] === 'string' ? deps.workspaceOps.tynnBoard(args[0], args[1] ?? {}) : { ok: false, state: 'error', reason: 'name a workspace' };
            case 'workspaces.tynnPage':
                if (!deps.workspaceOps.tynnPage) throw new Error('this host has no Tynn tab');
                return deps.workspaceOps.tynnPage(args[0] as string, args[1], args[2]);
            case 'workspaces.tynnBoardAction':
                if (!deps.workspaceOps.tynnBoardAction) throw new Error('this host has no Tynn tab');
                return typeof args[0] === 'string' && typeof args[1] === 'object' && args[1] !== null ? deps.workspaceOps.tynnBoardAction(args[0], args[1]) : TYNN_NO_ACTION;
            case 'workspaces.tynnIssues':
                if (!deps.workspaceOps.tynnIssues) throw new Error('this host has no Tynn tab');
                return deps.workspaceOps.tynnIssues(args[0] as string, args[1] ?? {});
            case 'workspaces.tynnIssueAction':
                if (!deps.workspaceOps.tynnIssueAction) throw new Error('this host has no Tynn tab');
                return typeof args[0] === 'string' && typeof args[1] === 'object' && args[1] !== null ? deps.workspaceOps.tynnIssueAction(args[0], args[1]) : TYNN_NO_ACTION;
            case 'workspaces.tynnPageAction':
                if (!deps.workspaceOps.tynnPageAction) throw new Error('this host has no Tynn tab');
                return typeof args[0] === 'string' && typeof args[1] === 'object' && args[1] !== null ? deps.workspaceOps.tynnPageAction(args[0], args[1]) : TYNN_NO_ACTION;
            case 'workspaces.tynnBoardChanges':
            case 'workspaces.tynnIssueChanges': {
                const read = method === 'workspaces.tynnBoardChanges' ? deps.workspaceOps.tynnBoardChanges : deps.workspaceOps.tynnIssueChanges;
                if (!read) throw new Error('this host has no live Tynn tab');
                const [id, scope, cursor, ids] = args;
                if (typeof id !== 'string' || typeof cursor !== 'string') return { ok: false, state: 'error', reason: 'name a workspace and a cursor' };
                return read(id, scope ?? {}, cursor, Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []);
            }
            case 'workspaces.listRepos':
                return deps.workspaceOps.listRepos(str(args[0]));
            case 'workspaces.addRepo': {
                const input = (typeof args[1] === 'object' && args[1] !== null ? args[1] : {}) as { name?: unknown; path?: unknown };
                return deps.workspaceOps.addRepo(str(args[0]), { name: str(input.name), path: str(input.path) });
            }
            case 'workspaces.removeRepo':
                return deps.workspaceOps.removeRepo(str(args[0]), str(args[1]));
            case 'workspaces.removeRepoLock':
                return deps.workspaceOps.removeRepoLock ? deps.workspaceOps.removeRepoLock(str(args[0]), str(args[1])) : { ok: false, reason: 'this host cannot touch the repo' };
            case 'workspaces.commitsSince':
                return deps.workspaceOps.commitsSince ? deps.workspaceOps.commitsSince(str(args[0]), Number(args[1])) : { ok: false, reason: 'this host cannot read commits' };
            case 'workspaces.settings':
                return deps.workspaceOps.settings(str(args[0]));
            case 'workspaces.setSetting':
                return deps.workspaceOps.setSetting(str(args[0]), str(args[1]), args[2]);
            case 'workspaces.resetSetting':
                return deps.workspaceOps.resetSetting(str(args[0]), str(args[1]));
            case 'workspaces.setGoverns':
                return deps.workspaceOps.setGoverns(str(args[0]), Array.isArray(args[1]) ? args[1].map(str) : []);
            case 'workspaces.setDefaultAgent':
                return deps.workspaceOps.setDefaultAgent(str(args[0]), typeof args[1] === 'string' && args[1] !== '' ? args[1] : null);
            case 'workspaces.setMcpServer':
                return deps.workspaceOps.setMcpServer(str(args[0]), args[1], args[2]);
            case 'workspaces.savePreview':
                return deps.workspaceOps.savePreview ? deps.workspaceOps.savePreview(args[0]) : { plan: { ok: false, reason: 'this host cannot save a workspace to its repo', violations: [] }, files: [], upstream: { fetched: false, ref: null }, decisions: [], conflicts: [] };
            case 'workspaces.save':
                return deps.workspaceOps.save ? deps.workspaceOps.save(args[0], args[1]) : { ok: false, reason: 'this host cannot save a workspace to its repo', written: [] };
            case 'workspaces.cloneOffers':
                return deps.workspaceOps.cloneOffers ? deps.workspaceOps.cloneOffers(args[0]) : { ok: false, reason: 'this host does not watch a workspace’s repo' };
            case 'workspaces.applyOffer':
                return deps.workspaceOps.applyOffer ? deps.workspaceOps.applyOffer(args[0], args[1]) : { ok: false, reason: 'this host does not watch a workspace’s repo' };
            case 'workspaces.setColor':
                return deps.workspaceOps.setColor ? deps.workspaceOps.setColor(str(args[0]), str(args[1])) : { ok: false, reason: 'this host cannot set a workspace colour' };
            case 'takeOver':
                if (!deps.takeOver) throw new Error('takeOver opens a window on the host; do it there');
                return deps.takeOver.start(str(args[0]));
            // The provider's own login, for the host's owner (RemoteHost checks that); Genie never handles a credential.
            case 'providerLogin':
                return deps.signIns ? deps.signIns.providerLogin(str(args[0]), context) : { ok: false, reason: SIGN_IN_UNAVAILABLE };
            case 'logins.design':
                return deps.signIns ? deps.signIns.design(context) : { ok: false, reason: SIGN_IN_UNAVAILABLE };
            case 'accounts.switch':
                return deps.signIns ? deps.signIns.switchAccount(str(args[0]), args[1], context) : { ok: false, reason: SIGN_IN_UNAVAILABLE };
            // The crash report: the draft, and only what the person sends (Tynn #386 part 4; #897 2c-2).
            case 'crashReport.draft':
                return deps.crashReports ? deps.crashReports.draft() : { text: '' };
            case 'crashReport.send':
                if (!deps.crashReports) return { ok: false, reason: 'this host cannot send a crash report' };
                return typeof args[0] === 'string' && typeof args[1] === 'string' ? deps.crashReports.send(args[0], args[1]) : { ok: false, reason: 'A crash report needs its text.' };
            // The .exe the owner picked on this host's disk for a batch-wrapped provider (Tynn #577; #897 2c-3).
            case 'providers.chooseProgram':
                if (!deps.providerPrograms) return { ok: false, reason: 'this host cannot keep a provider’s program' };
                if (typeof args[0] !== 'string' || !isAcpProvider(args[0])) return { ok: false, reason: 'No provider named.' };
                if (typeof args[1] !== 'string' || args[1] === '') return { ok: false, reason: 'No program chosen.' };
                return deps.providerPrograms.choose(args[0], args[1]);
            // A question's named files, one of them, and its ArtBoard visuals (Tynn #912, 2f-1): the host's own question, from
            // its own Deck; who may see which question is host-question-reads.ts's, by the caller's context.
            case 'questions.files':
                if (!deps.questions || typeof args[0] !== 'string' || !Array.isArray(args[1])) return null;
                return deps.questions.files(args[0], args[1].filter((p): p is string => typeof p === 'string'), context);
            case 'questions.file':
                if (!deps.questions) return { ok: false, reason: 'this host cannot read a question’s files' };
                if (typeof args[0] !== 'string' || typeof args[1] !== 'string') return { ok: false, reason: 'no such file' };
                return deps.questions.file(args[0], args[1], context);
            case 'questions.visuals':
                if (!deps.questions) return { ok: false, reason: 'this host cannot read a question’s visuals' };
                if (typeof args[0] !== 'string') return { ok: false, reason: 'Genie does not know this question' };
                return deps.questions.visuals(args[0], context);
            // A remote window's transport to another machine (Tynn #941, 2f-2): owned by the CALLING connection, which only
            // this machine's own windows are (`local`, RemoteHost's).
            case 'deviceLink.open':
            case 'deviceLink.openRelay':
            case 'deviceLink.send':
            case 'deviceLink.close':
            case 'deviceLink.openBrowser':
                if (!deps.deviceLinkProtocol || !context) return { ok: false, reason: 'this Genie connects to no other machines' };
                return deps.deviceLinkProtocol.call(context.connectionId, method.slice('deviceLink.'.length), args);
            // WHAT AN OLDER GENIE SEALED (Tynn #959, 2g-3b; host-legacy-adopt.ts). `local` keeps every other machine out (RemoteHost's);
            // of this machine's connections only main's own client hands secrets over, never a page in a window. Its tunnel says so
            // (CallContext `own`, set by genie-host's tunnel for main's own door); a label is display words any door may say.
            case 'keychain.adoptLegacy':
                if (!deps.legacySecrets) return { ok: false, reason: 'this host keeps nothing an older Genie sealed' };
                if (context.own !== true) return { ok: false, reason: 'what an older Genie sealed is handed over by Genie itself, never by a window' };
                return deps.legacySecrets.adopt(args[0]);
            // A WINDOW-RUN TOOL'S APPROVAL (Tynn #1006, 2g-4b2): `local` keeps every other machine out (RemoteHost's), and of this
            // machine's connections only main's own client asks; the request is read strictly (approvals-gate-protocol.ts).
            // WHETHER THE PERSON IS AT THIS MACHINE (Tynn #1044, 2g-4d B): only Electron knows, so main's own client says it.
            case 'window.view': {
                if (!deps.windowView) return { ok: false, reason: 'this host keeps no window view' };
                if (context.own !== true) return { ok: false, reason: 'whether the person is here is said by Genie itself, never by a window' };
                const view = readWindowView(args);
                if ('ok' in view) return view;
                deps.windowView.userActive(view.userActive);
                return null;
            }
            case 'approvals.gate': {
                if (!deps.approvalsGate) return { ok: false, reason: 'this host keeps no approval queue' };
                if (context.own !== true) return { ok: false, reason: 'an approval is asked by Genie itself for the tools it runs, never by a window' };
                const request = readGateRequest(args);
                if ('ok' in request) return request;
                return deps.approvalsGate(request.caller, request.action, request.detail, request.forwardedCallId);
            }
            // A WRITE TO GENIE-HOST'S REGISTRY (Tynn #1007, 2g-4e): `local` keeps every other machine out, and of this machine's
            // connections only main's own client writes; the write is read strictly. genie-host answers it from the start, as
            // hostRemoteApi's own method (registry-protocol.ts hostRegistryAnswers); this is the same answer on this path.
            case 'registry.write':
                return answerRegistryWrite(deps.registryFiles, args, context);
            // The machine woke, or an agent found IssueWatch signed out: this host asks Tynn again (Tynn #959, 2g-3b).
            case 'tynn.recheck':
                if (!deps.tynnRecheck) return { ok: false, reason: 'this host has no Tynn account to ask' };
                await deps.tynnRecheck();
                return null;
            // Open with / Show in file manager on this host's own screen (Tynn #841; #912 2f-1). Who may is RemoteHost's (the owner's).
            case 'files.openExternal':
            case 'files.reveal':
                if (!deps.hostShell) return { ok: false, reason: 'this host cannot open files on its screen' };
                if (typeof args[0] !== 'string' || typeof args[1] !== 'string') return { ok: false, reason: 'that file is not in this workspace' };
                return method === 'files.openExternal' ? deps.hostShell.open(args[0], args[1]) : deps.hostShell.reveal(args[0], args[1]);
            // The throwaway shell (Tynn #378, #761; #897 2c-4): the workspace's, or Genie's own for null. Who may is RemoteHost's.
            case 'terminals.scratch':
                if (!deps.scratchTerminals) return { ok: false, reason: 'this host cannot open a scratch terminal' };
                if (args[0] !== null && args[0] !== undefined && typeof args[0] !== 'string') return { ok: false, reason: 'No workspace named.' };
                return deps.scratchTerminals.open(typeof args[0] === 'string' ? args[0] : null, context);
            // The tray's Log in names a provider, not an agent (Tynn #896, 2b-2b).
            case 'logins.provider':
                return deps.signIns ? deps.signIns.loginFor(str(args[0]), context) : { ok: false, reason: SIGN_IN_UNAVAILABLE };
            case 'features.setBrowserBounds':
                throw new Error("features.setBrowserBounds places a view on the host's own window; nothing to do remotely");
            case 'terminals.open': {
                const workspaceId = str(args[0]);
                const workspace = deps.snapshot().workspaces?.find((w) => w.id === workspaceId) ?? null;
                if (!workspace) throw new Error(`no workspace ${workspaceId}`);
                const options = (args[1] ?? {}) as { cols?: unknown; rows?: unknown; command?: unknown };
                const env = deps.serviceEnvFor(workspace.id);
                const command = typeof options.command === 'string' && options.command.trim() ? options.command : undefined;
                const wanted: TerminalOptions = { workspaceId: workspace.id, cwd: workspace.path, cols: num(options.cols), rows: num(options.rows), command, personal: true, ...(Object.keys(env).length > 0 ? { env } : {}) };
                return deps.terminals.openReady ? await deps.terminals.openReady(wanted) : deps.terminals.open(wanted);
            }
            case 'terminals.write':
                return deps.terminals.write(str(args[0]), str(args[1]));
            case 'terminals.resize':
                return deps.terminals.resize(str(args[0]), Math.floor(Number(args[1])), Math.floor(Number(args[2])));
            case 'terminals.close':
                return deps.terminals.close(str(args[0]));
            case 'terminals.attach': {
                // Scoped like list: a connection scoped to one workspace cannot join another's terminal.
                const workspaceId = str(args[0]);
                const joined = deps.terminals.attach(str(args[1]));
                if (!joined || joined.workspaceId !== workspaceId) return null;
                const { id, pid, shell, scrollback } = joined;
                return { id, pid, shell, scrollback };
            }
            case 'terminals.list': {
                const workspaceId = str(args[0]);
                return deps.terminals.list().filter((t) => t.workspaceId === workspaceId).map(({ id, pid, shell }) => ({ id, pid, shell }));
            }
            case 'features.snapshot':
                if (!context.connectionId) throw new Error('features.snapshot needs an admitted caller before reading its state');
                return deps.features.snapshot(context);
            case 'features.soundData':
                return typeof args[0] === 'string' && deps.features.soundData ? deps.features.soundData(args[0]) : null;
            case 'features.picked':
                if (context.origin === 'local-window' && Array.isArray(args[0])) await deps.features.picked?.(args[0] as unknown[], context);
                return null;
            case 'features.act':
                return deps.features.act(args[0] as FeatureAction, context);
            case 'host.listDir':
                return listHostDir(typeof args[0] === 'string' ? args[0] : '/');
            case 'host.mkdir':
                return typeof args[0] === 'string' && typeof args[1] === 'string' ? makeHostDir(args[0], args[1]) : { ok: false, reason: 'name a folder and where to make it' };
            case 'host.home':
                return homedir();
            case 'updates.state':
                return deps.updates?.state() ?? null;
            case 'updates.check':
                return deps.updates ? deps.updates.check() : null;
            case 'updates.download':
                return deps.updates ? deps.updates.download() : false;
            case 'updates.install':
                return deps.updates?.install() ?? null;
            case 'updates.forceDrain':
                return deps.updates?.forceDrain?.() ?? false;
            case 'updates.notes':
                return deps.updates?.notes?.() ?? null;
            case 'headroom':
                return deps.headroom ? deps.headroom.view() : null;
            case 'accountRetry': {
                const record = typeof args[0] === 'string' ? deps.find(args[0]) : null;
                if (!record) return { ok: false, reason: 'No agent named.' };
                deps.retryPausedAccount?.(record.provider);
                return { ok: true };
            }
            case 'activity':
                if (typeof args[0] !== 'string') return {};
                return deps.activity ? deps.activity.feeds(args[0]) : {};
            case 'inbox.sendFile':
                return deps.uploads.sendFile(str(args[0]), str(args[1]), str(args[2]), Buffer.from(str(args[3]), 'base64'));
            case 'files.children':
                return deps.files ? deps.files.children(str(args[0]), str(args[1])) : null;
            case 'files.open':
                return deps.files ? deps.files.open(str(args[0]), str(args[1])) : { ok: false, path: str(args[1]), error: NO_FILES_HERE };
            case 'files.readMedia':
                return deps.files ? deps.files.readBytes(str(args[0]), str(args[1])) : { ok: false, path: str(args[1]), error: NO_FILES_HERE };
            case 'files.upload': {
                const file = args[2] as { name?: unknown; bytes?: unknown } | null;
                if (!file || typeof file.name !== 'string' || !(file.bytes instanceof Uint8Array)) return { ok: false, reason: 'an upload is a name with bytes' };
                return deps.files ? deps.files.upload(str(args[0]), str(args[1]), file.name, file.bytes) : { ok: false, reason: NO_FILES_HERE };
            }
        }
    };

    const terminalWorkspaces = new Map<string, string>();
    return {
        localAgents: {
            detailFor: (agentId) => deps.detailFor(agentId),
            onChanged: (listener) => {
                const offHost = deps.host.subscribe(listener), offRecords = deps.subscribeAgentRecords(listener);
                const offChat = deps.subscribeAgentChat?.(listener);
                return () => { offHost(); offRecords(); offChat?.(); };
            },
        },
        invoke,
        // A connection went: its feature caller, and every channel to another machine it opened (Tynn #941, 2f-2).
        releaseCaller: context => { deps.features.releaseCaller?.(context); deps.deviceLinkProtocol?.dropOwner(context.connectionId); },
        // What this host runs, for a connection that said summary.watch (Tynn #953, 2g-2).
        ...(deps.hostSummary ? { hostSummary: () => deps.hostSummary!.now() } : {}),
        // Who is at this machine, for main's own client saying remote.watch (Tynn #997, 2g-4a).
        ...(deps.remoteWatch ? { remoteWatch: () => deps.remoteWatch!.now() } : {}),
        // genie-host's settings, for main's own client saying settings.watch (Tynn #998, 2g-4b1).
        ...(deps.settingsWatch ? { settingsWatch: () => deps.settingsWatch!.now() } : {}),
        ...(deps.marketplace ? { marketplace: deps.marketplace } : {}),
        ...(deps.gapps ? { gapps: deps.gapps } : {}),
        ...(deps.filesWatch ? { filesWatch: deps.filesWatch } : {}),
        ...(deps.tynnWatch ? { tynnWatch: deps.tynnWatch } : {}),
        ...(deps.localTerminals ? { localTerminals: deps.localTerminals } : {}),
        ...(deps.takeOver ? { takeOverEnded: (terminalId: string) => deps.takeOver!.ended(terminalId) } : {}),
        workspaceOfAgent: (agentId) => deps.find(agentId)?.workspaceId ?? null,
        // A terminal's workspace, remembered once seen: its exit is pushed after it has left the list.
        workspaceOfTerminal: (terminalId) => {
            const live = deps.terminals.list().find((t) => t.id === terminalId)?.workspaceId;
            if (live) terminalWorkspaces.set(terminalId, live);
            return live ?? terminalWorkspaces.get(terminalId) ?? null;
        },
        workspacePaths: () => Object.fromEntries((deps.snapshot().workspaces ?? []).map((w) => [w.id, w.path])),
        onEvent: (listener, options) => {
            let featuresRevision = 0;
            /*
             * An agent's detail AT MOST every AGENT_PUSH_INTERVAL_MS, the latest state last (the owner, 2026-10-20: "severe
             * UI lag"): a busy agent changes many times a second and its detail carries its ledger; built and sent per
             * event, it cost main a core. The first change goes at once.
             */
            // An agent NOBODY listening wants is not built at all (genie#1346): a phone watches one agent, not every one.
            const wants = options?.wantsAgent ?? (() => true);
            const agents = new Coalescer<string>({ intervalMs: AGENT_PUSH_INTERVAL_MS, flush: (agentId) => { if (wants(agentId)) listener(`agent:${agentId}`, deps.detailFor(agentId)); }, schedule: deps.schedule ?? realSchedule, now: deps.now ?? (() => Date.now()) });
            const offs = [
                // An agent that BECAME wanted is pushed as it is now (Tynn #862): a change to it before then was not built
                // (`wants`), so a phone opening a chat never got the ledger that landed while its watch was opening.
                options?.onAgentsWanted?.((agentIds) => { for (const agentId of agentIds) agents.request(agentId); }) ?? (() => {}),
                // This machine's own windows on their own channel: inline when it fits a frame, else a revision (Tynn #564).
                deps.subscribeSnapshot((s) => { listener('snapshot', s); listener(LOCAL_EVENTS.snapshot, s); }),
                deps.host.subscribe((agentId) => agents.request(agentId)),
                deps.subscribeAgentRecords((agentId) => agents.request(agentId)),
                () => agents.stop(),
                deps.terminals.onData((id, data) => listener('terminal-data', { id, data })),
                deps.terminals.onExit((id, exitCode) => listener('terminal-exit', { id, exitCode })),
                // A remote window hears the snapshot; this machine's own hears that it changed, and re-reads (P4 family 11):
                // no local event carries a whole snapshot, which has no bound and could end the door's connection.
                deps.features.onChange?.((data) => { listener('features', data); listener(LOCAL_EVENTS.features, { revision: ++featuresRevision }); }) ?? (() => {}),
                deps.features.onInvalidated?.(() => { listener(LOCAL_EVENTS.features, { revision: ++featuresRevision }); }) ?? (() => {}),
                deps.updates?.onChange((state) => { listener('updates', state); listener(LOCAL_EVENTS.updates, state); }) ?? (() => {}),
                deps.activity?.subscribe((feed) => { listener('activity', feed); listener(LOCAL_EVENTS.activity, feed); }) ?? (() => {}),
                deps.headroom?.subscribe((room) => listener(LOCAL_EVENTS.headroom, room)) ?? (() => {}),
                deps.hostSummary?.subscribe((summary) => listener(LOCAL_EVENTS.summary, summary)) ?? (() => {}),
                deps.remoteWatch?.subscribe((view) => listener(LOCAL_EVENTS.remote, view)) ?? (() => {}),
                deps.settingsWatch?.subscribe((view) => listener(LOCAL_EVENTS.settings, view)) ?? (() => {}),
                deps.filesWatch?.subscribe(event => listener(LOCAL_EVENTS.files, event)) ?? (() => {}),
                deps.tynnWatch?.subscribe((event) => listener(LOCAL_EVENTS.tynn, event)) ?? (() => {}),
                deps.gappsChanged?.subscribe(() => listener(LOCAL_EVENTS.gapps, null)) ?? (() => {}),
                deps.workspaceOps.onSettingsChanged?.((id) => listener('workspace-settings-changed', id)) ?? (() => {}),
                // What another window is typing (Tynn #730): this machine's windows on their own channel, remote ones on theirs.
                (() => {
                    const onTyping = (event: TypingEvent) => { listener(TYPING_EVENT, event); listener(LOCAL_EVENTS.typing, event); };
                    typingListeners.add(onTyping);
                    return () => { typingListeners.delete(onTyping); };
                })(),
            ];
            return () => { for (const off of offs) off(); };
        },
    };
}

const NO_FILES_HERE = 'this host does not offer its files remotely';

/** A prompt's files as the host hands them over (staged bytes, remote-host.ts): name, type, bytes — or `null`. */
function attachmentsOf(list: readonly unknown[]): Attachment[] | null {
    const out: Attachment[] = [];
    for (const a of list) {
        const f = a as { name?: unknown; type?: unknown; bytes?: unknown } | null;
        if (!f || typeof f.name !== 'string' || !(f.bytes instanceof Uint8Array)) return null;
        out.push({ name: f.name, type: typeof f.type === 'string' ? f.type : '', bytes: f.bytes });
    }
    return out;
}
