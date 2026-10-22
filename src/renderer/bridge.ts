import type { ApplyWhen, BudgetDecision, DeletePlan, SwitchDecision } from '../core/agent-ops.js';
import type { ModelChoices } from '../core/provider-models.js';
import type { AgentPermissions } from '../core/identity.js';
import type { IssueWatchPrefs, IssueWatchSetting } from '../core/issue-watch.js';
import type { Attachment } from '../core/prompt-content.js';
import type { AgentRow, Fidelity } from '../core/dashboard-view.js';
import type { TynnContent, TynnOwner, TynnProject } from '../core/tynn.js';
import type { ImportedAgent } from '../core/agent-adoption.js';
import type { Diagnosis, FolderKind, PlanStep } from '../core/workspace-model.js';
import type { DeckItem, SignalState } from '../core/deck.js';
import type { RailWorkspace, Surface } from '../core/rail-view.js';
import { EMPTY_FEATURES, type FeatureAction, type FeatureData } from './features.js';
import type { TynnNetworkBridge } from './relay-transport.js';
import type { LiveSession } from '../core/roster.js';
import type { TakeOverProbe } from '../core/observed.js';
import type { TimedEvent } from '../core/stream-view.js';
import type { MailLike } from '../core/chat-view.js';
import type { TreeNode } from '../core/files-panel.js';
import type { BytesResult, BytesWriteResult, FileOpResult, FilesState, OpenResult, WriteResult } from '../main/files-host.js';
import type { RepoEntry } from '../core/repo-registry.js';
import type { RepoCommit } from '../core/commits.js';
import type { EnvelopePlan } from '../core/envelope-plan.js';
import type { Published, RemoteChoice } from '../core/agi-remote.js';
import type { RepoListing } from '../core/github.js';
import type { SourceRead } from '../main/envelope-wizard-host.js';

/**
 * THE RENDERER'S ONLY WINDOW ONTO THE MAIN PROCESS.
 *
 * One narrow, declared surface. The renderer never reaches for `ipcRenderer` directly and
 * never holds a Node capability: the preload script implements exactly this interface over
 * `contextBridge` and nothing else crosses.
 *
 * ## Push, never poll
 *
 * `subscribe` is a subscription, not a timer. A dashboard that polls is a dashboard that is
 * wrong for up to its interval, and with thirty agents it is also a dashboard that reads the
 * session registry a hundred times a minute to learn nothing. The main process owns the
 * registry and says when it changed.
 *
 * ## `null` crosses the bridge intact
 *
 * Every nullable field on `AgentRow` and `RailWorkspace` means *"Genie cannot see this"*, and
 * the bridge must not helpfully coalesce one to a zero on the way through. The rule only
 * works if it holds end to end — a `?? 0` anywhere in the IPC layer silently converts "we
 * have not looked" into "we looked and it was none", and the UI has no way to tell.
 */
export interface GenieSnapshot {
    agents: readonly AgentRow[];
    /** Genie's own agent's row (not a workspace agent): the Dashboard's first group. Absent/`null` = none. */
    osAgent?: AgentRow | null;
    /**
     * `null` until the store has actually been read.
     *
     * **Not `[]`.** The two are different claims and they get different surfaces: an empty
     * array means Genie looked and this machine has no workspaces, which is a first run and
     * deserves an invitation; `null` means nobody has looked yet, which deserves a skeleton.
     *
     * This distinction was missing for exactly one commit, and the Dashboard's brand-new
     * first-run state rendered "Nothing is being worked on yet" before the bridge had
     * answered — a confident claim about a machine nobody had asked. An older test caught it.
     */
    workspaces: readonly RailWorkspace[] | null;
    /**
     * The attention band, or `null` until the queue has been read.
     *
     * The rail's badge count is DERIVED from this rather than carried beside it. Two numbers
     * for one fact is how a badge ends up saying 3 while the Deck shows 2, and the badge is
     * the thing people trust enough not to check.
     */
    deckItems: readonly DeckItem[] | null;
    signals: SignalState;
    /** `null` until the workstation has been read — never a default `healthy: false`. */
    workstation: { name: string; healthy: boolean } | null;
}

/**
 * One agent's full state — what the Agent view needs.
 *
 * Fetched per agent rather than carried in the snapshot: a ledger is thousands of rows, and
 * pushing every agent's to every renderer on every event would send the whole estate's
 * history down the wire to redraw one line.
 */
export interface AgentDetail {
    agent: { id: string; name: string; provider: string; fidelity: Fidelity; cwd: string; raisesApprovals?: boolean | null | undefined; dailyBudgetUsd?: number | null; mode?: 'automated' | 'manual'; accessScope?: 'none' | 'self' | 'specific' | 'all'; /** Autonomous (Tynn #801). */ autoApprove?: boolean; manageTabs?: boolean; /** May drive pages (browser rebuild step 7). */ drivePages?: boolean; issueWatch?: IssueWatchPrefs; permissions?: AgentPermissions; /** The model CHOSEN for it; `null` = the provider's default. The one IN USE is `session.model`. */ model?: string | null; /** The persona file, workspace-relative (`.agents/<name>/AGENT.md`); `null` when the record names none. */ instructions?: string | null };
    /** `null` when the agent is registered but not running. Not an error. */
    session: LiveSession | null;
    rows: readonly TimedEvent[];
    /** The agent's recent AgentInbox mail with other agents (its chat shows each as a system row); absent = not read. */
    comms?: readonly MailLike[] | null | undefined;
    turns: number;
    /** `null` when the provider reports no cost. codex reports none — so there is no row. */
    cost: number | null;
    /** Why a start was refused, if one was. Reported, never swallowed. */
    refusal: string | null;
    /** The provider's recent stderr, oldest first — the process-ended block's log. Absent from an older host = nothing known. */
    log?: readonly string[] | undefined;
    /**
     * The live Take Over window's probe (§4.2 Observed): the TUI's terminal id, when it started, when it last printed,
     * its output bursts. `null` or absent = no Take Over — the agent is declared. The same probe the Dashboard row reads.
     */
    takeOver?: TakeOverProbe | null;
}

/** The three feature channels, named ONCE. Preload and main import this; neither retypes a string. */
export const FEATURE_CHANNELS = {
    snapshot: 'genie:features-snapshot',
    act: 'genie:features-act',
    changed: 'genie:features-changed',
    /** The renderer reports where the browser box is, so main can place the WebContentsView over it. */
    browserBounds: 'genie:features-browser-bounds',
    /** An alert's own sound file, read by main into a data URL — asked by setting KEY, never by path (Tynn #766 B2). */
    soundData: 'genie:features-sound-data',
} as const;

/** The Dashboard lanes' feeds (beta.33 item 10). */
export interface ActivityBridge {
    feeds(workspaceId: string): Promise<Readonly<Record<string, import('../core/activity-feed.js').ActivityFeed>>>;
    subscribe(onFeed: (feed: import('../core/activity-feed.js').ActivityFeed) => void): () => void;
}

export interface GenieBridge {
    /** A known remote host in its own window (Genie 1's remote.open, Tynn #819). Host-only: absent on a remote bridge. */
    remoteWindows?: { open(url: string): Promise<void> };
    /** Live site panels (beta.35 item 36, step 5): main places each site panel's page over its box. Host-only. */
    /**
     * EVERY AGENT'S ACTIVITY FEED (beta.33 item 10) — what the workspace Dashboard's lanes draw. `feeds` reads a
     * workspace's agents' feeds once; `subscribe` hears each agent's feed when its session changes (pushed by the host,
     * never polled). Absent = no host to ask: the lanes draw what the snapshot says and claim nothing more.
     */
    activity?: ActivityBridge;
    sitePanels?: {
        show(panelKey: string, host: string, bounds: { x: number; y: number; width: number; height: number }): Promise<{ ok: true } | { ok: false; error: string }>;
        hide(panelKey: string): Promise<void>;
        reload(panelKey: string): Promise<void>;
        openWindow(host: string): Promise<void>;
    };
    /** The Genie browser window (beta.35 item 36): this machine's Genie sites. Host-only: absent on a remote bridge. */
    /** `hosts`: the `.gen` names of the workstation a remote window is driving (main decides which browser by the window). */
    browserWindow?: { open(address?: string, hosts?: readonly string[]): Promise<{ ok: true } | { ok: false; error: string }> };
    /** One folder of the HOST this window drives (Tynn #835) — what every file and folder picker reads. */
    host?: { listDir(path: string): Promise<import('../main/host-fs.js').HostListing>; /** The folder picker's New folder: `name` made inside `parent` on the host. */ mkdir?(parent: string, name: string): Promise<import('../main/host-fs.js').HostMade>; /** The host's home folder: a picker's last-resort start. Absent on a remote host. */ home?(): Promise<string> };
    /** The Tynn network (Tynn #837): the workstations Tynn lists, and a channel to one over the relay. Desktop only. */
    tynnNetwork?: TynnNetworkBridge;
    /**
     * THE FEATURE SURFACES — knowledge, flows, hosting, toolchain, settings, browser (the AgentInbox is a flyout, beta.33 item 19).
     * One snapshot, pushed on change; one `act` that applies a person's action in main and
     * answers with the next snapshot, or rejects with the refusal's reason.
     */
    features: {
        snapshot(): Promise<FeatureData>;
        subscribe(onChange: (data: FeatureData) => void): () => void;
        act(action: FeatureAction): Promise<FeatureData>;
        /** Where the browser surface's box is, in window coordinates; sent on mount and resize, never polled. */
        setBrowserBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
        /** An alert's own sound file as a data URL, by its setting key (`sound_question`); `null` when it cannot be read. */
        soundData(key: string): Promise<string | null>;
    };

    /** The current snapshot. Resolves once; changes arrive through `subscribe`. */
    snapshot(): Promise<GenieSnapshot>;
    /** Called whenever the main process's view of the world changes. Returns an unsubscribe. */
    subscribe(onChange: (snapshot: GenieSnapshot) => void): () => void;

    /** One agent's detail, or `null` for an id that is not registered. */
    agentDetail(agentId: string): Promise<AgentDetail | null>;
    /** Changes to one agent. Separate from `subscribe` so a ledger is not broadcast. */
    subscribeAgent(agentId: string, onChange: (detail: AgentDetail | null) => void): () => void;

    /** The host asking the window to go somewhere (the tray's Settings…). Absent on a remote bridge: a remote window is not this host's tray. */
    onNavigate?(onRoute: (route: string) => void): () => void;
    /** What an agent just did (Tynn #766 C), for its sound. Absent on a remote bridge for now: the host's own window plays it. */
    onAction?(onAction: (action: { agentId: string | null; kind: string }) => void): () => void;

    /** Start or REATTACH a session. Never creates a second for the same agent. */
    openAgent(agentId: string): void;
    /** "Stop agent" — END the session: the provider tree goes, and the capacity slot frees. Not the turn's Stop. */
    stopAgent(agentId: string): void;
    /**
     * `Stop this turn` (the chat's context line, the Agent view's header): the CURRENT TURN ends, the agent keeps
     * running (prism-acp's turn cancel). `ok: true` = the provider was asked; `reason` names why nothing was stopped —
     * `no-turn`, `not-running`, `unsupported` (this agent cannot stop a turn; it was not killed instead) or `refused`.
     */
    cancelTurn(agentId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
    /** `Resume now`: the agent's provider login, held for its rate limit, opens at once (Tynn #794). */
    resumeLimit(agentId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
    /** `Log in to <provider>` for a signed-out agent: the provider's own login, in a window of its own on this machine. */
    providerLogin(agentId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
    /** Try again for an agent whose ACCOUNT the provider paused: every agent on that login comes back. Absent on an older host. */
    accountRetry?(agentId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
    /** `Log in to Claude Design` (#1081): the interactive `claude` in the login window on this machine. Absent on an older host. */
    designLogin?(agentId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
    /**
     * `ok: false` = not sent; the renderer KEEPS the text (and its files) as an undelivered draft (§4.4). `reason` says
     * why when the host knows (a file the provider cannot take); absent = the agent is not running.
     */
    prompt(agentId: string, text: string, attachments?: readonly Attachment[]): Promise<{ ok: boolean; reason?: string }>;
    /**
     * Answer a parked approval, with the PROVIDER'S own option id.
     *
     * The id goes back over the wire verbatim and the main process checks it against the
     * request before sending it on — the renderer is not trusted to produce a valid one, and
     * a provider receiving an option it never offered is a protocol error at best.
     */
    answerApproval(agentId: string, optionId: string, note?: string): void;
    /**
     * "Restart with this" on a finish (§4.5): stop, start, and send the agent its own handoff note
     * as the first prompt; the finish is marked seen only when the prompt was taken. A refusal
     * names its reason and leaves the item on the Deck.
     */
    restartWithHandoff(agentId: string, finishedId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
    addAgent(workspaceId: string): void;
    /**
     * Open the folder picker and register what the user chose.
     *
     * The first-run invitation's one action. Genie never guesses a path and never writes into
     * a folder before showing what it found there.
     */
    addWorkspace(): void;

    /**
     * TAKE OVER — open the agent's TUI in a terminal in a NEW window (§1). The main process
     * opens the terminal in the agent's workspace and the window on it; Genie then only
     * watches. The answer says whether it opened and which terminal, or why not.
     */
    takeOver(agentId: string): Promise<{ ok: true; terminalId: string } | { ok: false; reason: string }>;

    /** WORKSPACE OPERATIONS (§6.1). Add is preview-then-confirm: nothing is written before the plan was shown. */
    workspaces: {
        /** The folder picker on the host, then the classification and plan. Writes nothing. */
        /** The plan for adding `path` — a folder picked in the window over the host's disk (Tynn #835). */
        previewAdd(path: string): Promise<{ ok: true; path: string; kind: FolderKind; steps: PlanStep[] } | { ok: false; reason: string }>;
        confirmAdd(path: string): Promise<{ ok: true; id: string; kind: FolderKind; stamped: { from: string | null; backup: string } | null } | { ok: false; reason: string }>;
        /** A NEW workspace (Genie 1's): Genie makes <parent>/<slug>.agi, the envelope and its first commit. Refusals come before any write. */
        /** Optionally linked to one of the person's Tynn projects: its id, looked up in Tynn's own list on the host (parity 5). */
        create?(name: string, parent: string, remote?: RemoteChoice, tynnProjectId?: string): Promise<{ ok: true; id: string; path: string; published?: Published } | { ok: false; reason: string }>;
        /** Add from a git URL (§6.1): the host picks the parent folder; the plan comes back BEFORE any clone. */
        previewAddFromGit(url: string, parent: string): Promise<{ ok: true; source: 'git'; url: string; parent: string; path: string; kind: FolderKind; steps: PlanStep[] } | { ok: false; reason: string }>;
        confirmAddFromGit(url: string, parent: string): Promise<{ ok: true; id: string; kind: FolderKind; stamped: { from: string | null; backup: string } | null } | { ok: false; reason: string }>;
        /**
         * OPEN EXISTING FOLDER (Add workspace parity item 7, Genie 1's wizard): an envelope already, or what the folder is.
         * Reads only. Optional so a host without the wizard answers with a refusal.
         */
        readSource?(path: string): Promise<SourceRead>;
        /** IMPORT FROM GIT: the clone lands in a staging folder and is read like a folder. */
        stageFromGit?(url: string): Promise<SourceRead>;
        /** An existing envelope, added as it is. */
        registerExisting?(path: string): Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
        /** The wizard's plan: a NEW `<slug>.agi` with the repos as submodules and the knowledge copied; the source untouched. */
        buildEnvelope?(plan: EnvelopePlan, remote?: RemoteChoice): Promise<{ ok: true; id: string; path: string; published?: Published } | { ok: false; reason: string }>;
        /** A cancelled import's staging clone, removed. Nothing else is ever removed. */
        discardStaged?(path: string): Promise<{ ok: true } | { ok: false; reason: string }>;
        /** IMPORT FROM GIT's browser (Add workspace parity item 8): the repositories the host's GitHub sign-in reaches. */
        githubRepos?(): Promise<RepoListing>;
        /** From Tynn (§6.1): the signed-in person's projects, to pick from (Genie 1's "your Tynn projects"); `added` = already a workspace here, by its id. */
        tynnProjects(): Promise<{ ok: true; host: string; projects: TynnProject[]; added?: Record<string, string> } | { ok: false; reason: string }>;
        /** Who a new Tynn project may belong to (Genie 1's Owner field; Add workspace parity item 5). Optional: an older host has none. */
        tynnOwnerOptions?(): Promise<{ ok: true; owners: TynnOwner[] } | { ok: false; reason: string }>;
        /** A Tynn project created from the optional picker (Genie 1's "New project"), in the project list's shape. */
        createTynnProject?(input: { name: string; slug: string; owner: { kind: TynnOwner['kind']; id: string } | null }): Promise<{ ok: true; project: TynnProject } | { ok: false; reason: string }>;
        /** "It came with agents" (Add workspace parity item 6): the `.agents/*` this workspace has not registered. Optional: an older host has none. */
        importedAgents?(workspaceId: string): Promise<{ ok: true; agents: ImportedAgent[] } | { ok: false; reason: string }>;
        /** Adopt one: registered from its AGENT.md, which is read and never rewritten. */
        adoptAgent?(workspaceId: string, name: string): Promise<{ ok: true; id: string; name: string } | { ok: false; reason: string }>;
        /** The CHOSEN project: the parent picked on the host, then the plan before anything is written. */
        previewAddFromTynn(projectId: string, parent: string): Promise<{ ok: true; source: 'tynn'; project: TynnProject; host: string; parent: string; path: string; kind: FolderKind; content?: TynnContent; steps: PlanStep[] } | { ok: false; reason: string; workspaceId?: string }>;
        confirmAddFromTynn(parent: string, projectId: string): Promise<{ ok: true; id: string; kind: FolderKind; stamped: { from: string | null; backup: string } | null } | { ok: false; reason: string }>;
        hibernate(workspaceId: string): Promise<{ ok: true; asleep: true; handoffs: { landed: string[]; missing: string[] } } | { ok: false; reason: string }>;
        wake(workspaceId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
        /** Forgets the workspace and its agents. The folder on disk is never touched. */
        remove(workspaceId: string): Promise<{ ok: true; agentsForgotten: number; path: string; folderUntouched: true } | { ok: false; reason: string }>;
        /** The repo registry (§6.1): the envelope's repos[]; the host repo cannot be removed. */
        listRepos(workspaceId: string): Promise<{ ok: true; repos: RepoEntry[] } | { ok: false; reason: string }>;
        addRepo(workspaceId: string, input: { name: string; path: string }): Promise<{ ok: true; slug: string } | { ok: false; reason: string }>;
        removeRepo(workspaceId: string, slug: string): Promise<{ ok: true } | { ok: false; reason: string }>;
        /** "Locate repo" on a Dashboard group fault: the host asks for the folder (inside the envelope) and moves the manifest's path. */
        locateRepo(workspaceId: string, slug: string, path: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }>;
        /** The commits in the workspace's repos since a moment, newest first — git's own account (an observed agent's index). */
        commitsSince(workspaceId: string, sinceMs: number): Promise<{ ok: true; commits: readonly RepoCommit[] } | { ok: false; reason: string }>;
        /** "Remove stale lock" on a red repo chip: unlinks `index.lock` only when it is stale; refuses with the reason otherwise. */
        removeRepoLock(workspaceId: string, slug: string): Promise<{ ok: true } | { ok: false; reason: string }>;
        /** This workspace's effective values for the workspace-scoped settings and which keys it overrides (§6.1). */
        settings(workspaceId: string): Promise<{ ok: true; values: Record<string, boolean | string>; overridden: string[] } | { ok: false; reason: string }>;
        setSetting(workspaceId: string, key: string, value: boolean | string): Promise<{ ok: true } | { ok: false; reason: string }>;
        resetSetting(workspaceId: string, key: string): Promise<{ ok: true } | { ok: false; reason: string }>;
        /** A workspace's settings changed in main (an agent's tabs, beta.35 item 36). Absent on a remote bridge. */
        onSettingsChanged?(listener: (workspaceId: string) => void): () => void;
        /** Ops projects (§6.1): which other workspaces this one governs; known ids only, never itself. */
        setGoverns(workspaceId: string, childIds: readonly string[]): Promise<{ ok: true; governs: string[] } | { ok: false; reason: string }>;
        /** Genie 1's default agent: one of this workspace's agents, or `null` for none. */
        setDefaultAgent(workspaceId: string, agentId: string | null): Promise<{ ok: true } | { ok: false; reason: string }>;
    };

    /** AGENT OPERATIONS (§6.2). Each answers with what happened or why not; nothing is silent. */
    agents: {
        /** Graceful resumes the same thread and REFUSES when it cannot; fresh discards it on purpose. */
        restart(agentId: string, kind: 'graceful' | 'fresh'): Promise<{ ok: true; kind: 'graceful' } | { ok: true; kind: 'fresh'; discarded: string | null } | { ok: false; reason: string }>;
        /** What a delete WOULD do — shown before the person confirms. Touches nothing. */
        previewDelete(agentId: string, outcome: 'unmount' | 'delete', alsoRemoveFrom: readonly string[]): Promise<{ ok: true; plan: DeletePlan } | { ok: false; reason: string }>;
        delete(agentId: string, outcome: 'unmount' | 'delete', alsoRemoveFrom: readonly string[]): Promise<{ ok: true; plan: DeletePlan } | { ok: false; reason: string }>;
        switchDriver(agentId: string, to: string): Promise<SwitchDecision>;
        setBudget(agentId: string, dailyLimitUsd: number | null): Promise<{ ok: true; decision: BudgetDecision } | { ok: false; reason: string }>;
        diagnose(agentId: string): Promise<{ ok: true; diagnosis: Diagnosis } | { ok: false; reason: string }>;
        /** Mode is wording for the agent (§6.2), not a permission boundary. */
        setMode(agentId: string, mode: 'automated' | 'manual'): Promise<{ ok: true } | { ok: false; reason: string }>;
        /** The agent's own half of who may message it (§6.4). */
        setAccessScope(agentId: string, scope: 'none' | 'self' | 'all'): Promise<{ ok: true } | { ok: false; reason: string }>;
        /** Autonomous (its services/processes/sites/terminals actions run without asking, recorded) or asked (Tynn #801). */
        setAutoApprove(agentId: string, on: boolean): Promise<{ ok: true } | { ok: false; reason: string }>;
        /** May manage the workspace's tabs (beta.35 item 36). */
        setManageTabs(agentId: string, on: boolean): Promise<{ ok: true } | { ok: false; reason: string }>;
        /** May drive pages (browser rebuild step 7). */
        setDrivePages(agentId: string, on: boolean): Promise<{ ok: true } | { ok: false; reason: string }>;
        /** What the agent hears from IssueWatch (Tynn #806). */
        setIssueWatch(agentId: string, setting: IssueWatchSetting): Promise<{ ok: true } | { ok: false; reason: string }>;
        /** What a Claude agent may do: all tools, ask before shell commands, or edits only. Refused for a Codex agent. */
        /** `apply`: when the change takes effect on a running agent (`applyWhen`); absent from an older host. */
        setPermissions(agentId: string, permissions: AgentPermissions): Promise<{ ok: true; apply?: ApplyWhen } | { ok: false; reason: string }>;
        /** The model the agent starts with (any provider); `null` = the provider's default. Applies when it next starts. */
        setModel(agentId: string, model: string | null): Promise<{ ok: true; apply?: ApplyWhen } | { ok: false; reason: string }>;
        /**
         * The provider's own models for the agent's picker (prism-acp 0.22): the running session's when it can say, else
         * the provider's CLI asked once and kept; `refresh` asks again. Optional: an older host has none.
         */
        models?(agentId: string, refresh?: boolean): Promise<ModelChoices | { ok: false; reason: string }>;
    };

    /**
     * TERMINALS — for shells, builds, services and hosted sites. **No agent has one.**
     *
     * Keyed by WORKSPACE, never by agent: there is no way to express "a terminal for this
     * agent" through this contract, which is the renderer's half of the one rule. Output and
     * exits are pushed; the renderer holds them in `workspace-view.ts` and hands the buffer to
     * `fancy-term`'s controlled `output` prop.
     */
    terminals: {
        open(
            workspaceId: string,
            options: { cols: number; rows: number; command?: string },
        ): Promise<{ id: string; pid: number; shell: string; scrollback: string }>;
        write(id: string, data: string): void;
        resize(id: string, cols: number, rows: number): void;
        close(id: string): void;
        /** Open terminals in one workspace — so a window that reloads can re-attach (§6.5). */
        list(workspaceId: string): Promise<readonly { id: string; pid: number; shell: string }[]>;
        /**
         * JOIN a running terminal (§6.5 multi-attach): its scrollback so far; the live bytes follow on `onData`. Null when it is
         * gone or not this workspace's. `null` for the workspace means "whichever it is in" — the host's OWN windows may; a remote
         * connection always names the workspace, because that is what its scope is checked against.
         */
        attach(workspaceId: string | null, id: string): Promise<{ id: string; pid: number; shell: string; scrollback: string } | null>;
        /** The previous session's scrollback for this workspace, ONCE (§6.5); `null` when there is none. */
        previousSession(workspaceId: string): Promise<string | null>;
        onData(listener: (id: string, data: string) => void): () => void;
        onExit(listener: (id: string, exitCode: number) => void): () => void;
    };

    /**
     * THE FILE PANEL (§4.3) — one per workspace. Reads are confined to the workspace root in main;
     * refusals come back in words. `onChange` is a push from the host's watcher, never a poll.
     */
    files: {
        /** The workspace tree without .git or node_modules; `null` for an unknown workspace. */
        tree(workspaceId: string): Promise<readonly TreeNode[] | null>;
        /** ONE folder's direct children (`''` = the root), listed when the panel opens it; `null` outside the workspace. Absent on an older host. */
        children?(workspaceId: string, dir: string): Promise<readonly TreeNode[] | null>;
        open(workspaceId: string, path: string): Promise<OpenResult>;
        /** A media file's BYTES, for the Files panel's viewer (an image read as text is not the image). Absent on an older host. */
        readMedia?(workspaceId: string, path: string): Promise<BytesResult>;
        /** The file as of the last commit — `Show diff` on a change nobody reported. Absent on a bridge with no host files. */
        lastCommitted?(workspaceId: string, path: string): Promise<string | null>;
        state(workspaceId: string): Promise<FilesState | null>;
        watch(workspaceId: string): Promise<void>;
        /** Once per batch of changes on disk (genie#921), with the paths that changed — absent from a host before batching. */
        onChange(listener: (workspaceId: string, paths?: readonly string[]) => void): () => void;
        /** Write against the sha that was read; a changed file comes back as a conflict, never overwritten (§4.3). */
        write(workspaceId: string, path: string, text: string, expectedSha: string | null): Promise<WriteResult>;
        /**
         * A PLUGIN EDITOR'S BYTES (beta.33 item 14), naming the plugin whose editor holds the file: the host lets them move
         * only for an enabled plugin's own claimed and declared types. Absent on a bridge with no host files.
         */
        readBytes?(workspaceId: string, pluginId: string, path: string): Promise<BytesResult>;
        /** Git's state of every changed file, for the tree's colours (beta.33 item 15). Absent on a bridge with no host files. */
        gitStatus?(workspaceId: string): Promise<Readonly<Record<string, 'modified' | 'added' | 'deleted' | 'untracked'>>>;
        writeBytes?(workspaceId: string, pluginId: string, path: string, base64: string, expectedSha: string | null): Promise<BytesWriteResult>;
        /** Right-click (Tynn #841): open with the host OS's own app / show in its file manager. Absent where this window is
         *  not the host (a window driving another machine) — those act on the host's screen. */
        openExternal?(workspaceId: string, path: string): Promise<{ ok: true } | { ok: false; reason: string }>;
        reveal?(workspaceId: string, path: string): Promise<{ ok: true } | { ok: false; reason: string }>;
        /** The tree's file operations (Tynn #844), confined to the workspace and never overwriting; Delete goes to the host's
         *  trash. Absent on a bridge whose host does not offer them — the menu then does not either. */
        create?(workspaceId: string, path: string, kind: 'file' | 'folder'): Promise<FileOpResult>;
        rename?(workspaceId: string, from: string, to: string): Promise<FileOpResult>;
        duplicate?(workspaceId: string, path: string): Promise<FileOpResult>;
        trash?(workspaceId: string, path: string): Promise<FileOpResult>;
        /** The popped-out panels (§4.3): host-only windows, so a remote bridge has none of this. */
        windows?: {
            popOut(workspaceId: string): Promise<void>;
            bringBack(workspaceId: string): Promise<void>;
            list(): Promise<readonly string[]>;
            onChange(listener: (popped: readonly string[]) => void): () => void;
        };
    };

    /**
     * UPDATES — §7. The main process owns the state machine (`UpdateHost`); the renderer only
     * asks and shows. Nothing downloads without `download()`, nothing installs without
     * `install()`, and both answer honestly when refused: `false` / `null`, never a silent
     * no-op. `install` answers with the §7.2 teardown report — what had to be stopped — before
     * the app quits to apply.
     */
    /** The native window buttons drawn over the title bar (Windows / Linux); absent in a browser or on a phone. */
    windowChrome?: {
        readonly overlay: boolean;
        setOverlayColors(color: string, symbolColor: string): Promise<boolean>;
        /** What the buttons were last painted with; `null` before the first paint. */
        current(): Promise<{ color: string; symbolColor: string } | null>;
    } | undefined;
    updates: {
        state(): Promise<UpdateState>;
        subscribe(onChange: (state: UpdateState) => void): () => void;
        check(): Promise<UpdateState>;
        download(): Promise<boolean>;
        install(): Promise<{ report: string } | null>;
    };

    /**
     * THE OFFICIAL PANELS' HOST CALLS (beta.33 item 14), by workspace: the Repository panel's git (each the person's own
     * click) and the ArtBoard. Absent on a bridge with no host (a window driving another machine): the panels say so.
     */
    repo?: {
        call(op: 'list' | 'status' | 'diff' | 'stage' | 'unstage' | 'commit' | 'branch' | 'push' | 'pull', workspaceId: string, rel: string, a?: unknown, b?: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
    } | undefined;
    artboard?: {
        read(workspaceId: string): Promise<import('../core/artboard.js').ResolvedBoard>;
        review(workspaceId: string, postId: string, verdict: 'approved' | 'rejected', comment: string): Promise<{ ok: true; delivered: boolean } | { ok: false; error: string }>;
    } | undefined;

    /** A phone's upload (§6.8): only the remote bridge has it — the desktop picks files natively. */
    uploads?: {
        sendFile(to: string, text: string, name: string, base64: string): Promise<{ ok: true; messageId: string } | { ok: false; reason: string }>;
    };
}

/** Mirror of `src/main/updater.ts`'s state, crossed as-is — every unknown is `null`. */
export interface UpdateState {
    phase: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
    version: string | null;
    percent: number | null;
    error: string | null;
    checkedAt: number | null;
    /** What is in the update (core/update-notes.ts): `null` = fetching, `'unavailable'` = offline. */
    changelog?: import('../core/update-notes.js').UpdateChangelog | 'unavailable' | null;
}

/** The updates bridge when there is no bridge: idle forever, every action refused. */
export const NO_UPDATES: GenieBridge['updates'] = {
    state: () => Promise.resolve({ phase: 'idle', version: null, percent: null, error: null, checkedAt: null }),
    subscribe: () => () => {},
    check: () => Promise.resolve({ phase: 'idle', version: null, percent: null, error: null, checkedAt: null }),
    download: () => Promise.resolve(false),
    install: () => Promise.resolve(null),
};

/**
 * Which surfaces this build can actually render.
 *
 * Exported from here because both the shell and the rail read it, and the rail's rows are
 * DERIVED from it — see `railSurfacesFor`. Two lists would drift, and the failure is silent in
 * both directions: a row that navigates nowhere, or a surface nothing points at.
 *
 * **Add a surface in the commit that makes it render, never before.**
 */
/** No main process (tests, the live check): first-paint data, and actions refused out loud. */
export const NO_FEATURES: GenieBridge['features'] = {
    snapshot: async () => EMPTY_FEATURES,
    subscribe: () => () => {},
    act: async () => { throw new Error('no main process to act on'); },
    setBrowserBounds: async () => {},
    soundData: async () => null,
};

export const SERVABLE: readonly Surface[] = ['dashboard', 'agent', 'deck', 'workspace', 'takeover', 'files', 'knowledge', 'flows', 'hosting', 'settings', 'browser'];

/**
 * The terminal bridge when there is NO bridge — a render test, or `App` before `window.genie`
 * exists. Every call is a no-op and every list is empty, which is the honest answer: nothing
 * is opened, nothing is written, nothing is claimed. Never a fake terminal.
 */
export const NO_FILES: GenieBridge['files'] = {
    tree: () => Promise.resolve(null),
    children: () => Promise.resolve(null),
    open: (_w, path) => Promise.resolve({ ok: false as const, path, error: 'no files host is attached' }),
    state: () => Promise.resolve(null),
    watch: () => Promise.resolve(),
    onChange: () => () => {},
    write: async () => ({ ok: false as const, reason: 'no files host is attached' }),
};

export const NO_TERMINALS: GenieBridge['terminals'] = {
    open: () => Promise.reject(new Error('no terminal engine is attached')),
    write: () => {},
    resize: () => {},
    close: () => {},
    list: () => Promise.resolve([]),
    attach: () => Promise.resolve(null),
    previousSession: () => Promise.resolve(null),
    onData: () => () => {},
    onExit: () => () => {},
};

declare global {
    interface Window {
        /**
         * Present only in the real app. It is optional on purpose: a renderer that assumes a
         * bridge cannot be rendered in a test, and the surfaces are then only ever checked by
         * launching the app — which is exactly how four releases shipped unexamined.
         */
        genie?: GenieBridge;
    }
}

/**
 * The snapshot a surface starts from before the bridge has answered.
 *
 * **Everything unknowable is `null`, and `agents` is empty with `workspaces` empty too.** This
 * is the state that renders skeletons, and it is deliberately NOT "zero agents in zero
 * workspaces": *"No agents"* and *"we have not heard yet"* are different claims, and first
 * paint must make the second one.
 */
export const EMPTY_SNAPSHOT: GenieSnapshot = {
    agents: [],
    workspaces: null,
    deckItems: null,
    signals: { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false },
    workstation: null,
};
