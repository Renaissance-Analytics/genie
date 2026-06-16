/**
 * Typed handle on the contextBridge surface exposed in main/preload.ts.
 * Always go through this — no direct ipcRenderer use anywhere in the
 * renderer.
 */

export type BackendKind = 'tynn' | 'aionima';

export interface BackendUser {
    backend: BackendKind;
    id: string;
    name: string;
    email?: string;
    kind?: string;
}

export interface TynnProject {
    /** Backend the project lives in. New field — older code without it falls back to 'tynn'. */
    backend?: BackendKind;
    id: string;
    name: string;
    slug: string;
    owner_type?: string;
    owner_name?: string;
    base_url?: string;
}

export interface WorkspaceRow {
    id: string;
    backend: BackendKind;
    project_id: string;
    project_name: string;
    /** Mirrored from project_id / project_name for v1 schema reads. */
    tynn_project_id: string;
    tynn_project_name: string;
    shape: 'agi' | 'simple';
    path: string;
    editor: string | null;
    editor_cmd: string | null;
    start_cmd: string | null;
    env_file: string | null;
    last_opened_at: string | null;
    created_by_genie: number;
    /** User-defined sidebar order (lower = higher). Assigned by main; optional on create. */
    sort_order?: number;
    /** Agent-integration MCP enabled for this workspace's terminals (1/0). */
    mcp_enabled?: number;
}

export interface DetectResult {
    state: 'EMPTY' | 'SIMPLE_REPO' | 'PRE_INIT' | 'FULL_ENVELOPE';
    has_project_json: boolean;
    has_root_git: boolean;
    has_gitmodules: boolean;
    repos: string[];
}

/** A ForceTheQuestion question pushed to the modal (mirrors the MCP schema). */
export interface ForceQuestionSpec {
    header: string;
    question: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
}

/** The user's answer to one ForceTheQuestion question. */
export interface ForceAnswerSpec {
    header: string;
    question: string;
    selected: string[];
    note: string;
}

/** Issue Watch: a detected repo + its watch state for the flyout. */
export interface WatchRepoView {
    owner: string;
    repo: string;
    enabled: boolean;
    unread: number;
}

/** Issue Watch: one feed item (issue / PR / Dependabot alert). */
export interface WatchFeedItem {
    kind: 'issue' | 'pr' | 'dependabot';
    key: string;
    number: number | null;
    title: string;
    url: string;
    updatedAt: string;
    author?: string;
    severity?: string;
    owner: string;
    repo: string;
    unread: boolean;
}

export interface Settings {
    primary_workspace?: string;
    /** Last-activated workspace id in the master view. */
    active_workspace?: string;
    default_editor?: string;
    default_editor_cmd?: string;
    default_start_cmd?: string;
    default_env_file?: string;
    global_hotkey?: string;
    tynn_host?: string;
    notifications_muted?: string;
    auto_update?: 'on' | 'off';
    /** Default shell id ('git-bash' | 'pwsh' | … | 'custom'). Empty = auto-detect. */
    terminal_shell?: string;
    /** Manual executable line, used when terminal_shell === 'custom'. */
    terminal_custom_cmd?: string;
    /** Max panels visible at once per workspace. String-encoded; default '4'. */
    max_views?: string;
    /** Per-workspace draggable-grid track sizes, JSON-encoded. */
    layout_json?: string;
    /** Tier 3: keep terminals running in a detached host so they survive a full
     *  quit. Defaults 'off' (in-process). 'on' opts in. */
    detached_terminals?: 'on' | 'off';
    /** Prepend the bundled tynn-cli bin to terminal PATH + inject GENIE_* env.
     *  Defaults ON; 'off' disables. */
    cli_tools_in_terminals?: 'on' | 'off';
    /** Play a chime when an agent calls imDone. Defaults 'off'. */
    notify_sound?: 'on' | 'off';
    /** Show an OS notification (tray popup) when an agent calls imDone.
     *  Defaults 'off'. */
    notify_toast?: 'on' | 'off';
}

export interface DocEntry {
    slug: string;
    title: string;
}

export interface ShellDetection {
    id: string;
    label: string;
    command: string;
    args: string[];
}

export interface AionimaConfig {
    host?: string;
    token?: string | null;
}

export interface EditorDetection {
    id: 'cursor' | 'vscode' | 'code-insiders';
    label: string;
    path: string;
}

export interface InboxPayload {
    count: number;
    events: Array<{
        id: string;
        backend: BackendKind;
        kind: string;
        actor: string;
        subject: string;
        url: string;
        when: string;
    }>;
}

export interface SignedInSummaryItem {
    backend: BackendKind;
    user: BackendUser;
    host: string;
}

export type UpdaterState =
    | 'idle'
    | 'checking'
    | 'available'
    | 'up-to-date'
    | 'applying'      // phase 1
    | 'downloading'   // phase 2
    | 'ready-to-restart'
    | 'error'
    | 'disabled';

export interface UpdaterStatus {
    state: UpdaterState;
    currentVersion: string;
    latestVersion: string | null;
    publishedAt: string | null;
    releaseUrl: string | null;
    log: string[];
    error: string | null;
    /** Only meaningful for the phase-1 backend. */
    repo?: string | null;
    /** Only meaningful during phase-2 download: 0..1. */
    progress?: number | null;
    /**
     * True when APPLYING this update will restart the detached pty-host —
     * i.e. a host-backed build with detached terminals running. On the update
     * path the host pins Genie's binary so it must be killed for NSIS to
     * replace it; live terminals come back from a snapshot (history kept,
     * running processes stop). The update pill warns the user when this is set.
     */
    willRestartPtyHost?: boolean;
}

export interface UpdaterConfig {
    repo: string;
    pollHours: number;
}

export interface ChangelogGroup {
    version: string;
    changes: string[];
}
export interface Changelog {
    current: string;
    latest: string;
    groups: ChangelogGroup[];
    partial: boolean;
}

/** A view spec is a terminal, a fancy-code editor, or a background process runner. */
export type ViewType = 'terminal' | 'code' | 'process';

/** Lifecycle status of a background Process service runner. */
export type ProcessStatus =
    | 'running'
    | 'stopped'
    | 'crashed'
    | 'restarting'
    | 'failed';

/** Per-type spec metadata. Code views persist the open file's relative path. */
export interface ViewMeta {
    file_path?: string;
    /** When true, this code view is pinned to `root` + reopens `file_path`. */
    locked?: boolean;
    /** Workspace-relative folder the tree is rooted at when locked. '' = workspace root. */
    root?: string;
    /** Code view: workspace-relative paths of the open editor tabs (in tab order). */
    open_files?: string[];
    /** Code view: workspace-relative path of the active (front) tab. */
    active_file?: string;
    /** Code view: when true, the file tree stays open after opening a file. */
    tree_pinned?: boolean;
    /** Code view: ids of the tree folders left expanded, restored on relaunch. */
    expanded_tree_ids?: string[];
    /** Code view: word-wrap toggle state. */
    word_wrap?: boolean;
    /** Process view: the command line run (non-interactively) by the runner. */
    command?: string;
    /** Process view: start automatically when the workspace/app opens. */
    autostart?: boolean;
    /** Process view: relaunch the command (with backoff) if it exits/crashes. */
    restart_on_exit?: boolean;
    [key: string]: unknown;
}

export interface TerminalSpec {
    id: string;
    workspace_id: string | null;
    label: string;
    cwd: string;
    shell: string | null;
    args: string[];
    env: Record<string, string>;
    type: ViewType;
    meta: ViewMeta;
    sort_order: number;
    created_at: string;
    last_opened_at: string | null;
    /** Epoch ms of the last persisted session snapshot, or null when none (Tier 1). */
    snapshot_at: number | null;
    /** On-disk encrypted snapshot size in bytes, or null when none (Tier 1). */
    snapshot_bytes: number | null;
    /** Last cwd the shell reported via OSC-7, or null when unknown (Tier 1.5). */
    live_cwd: string | null;
    /**
     * Tier 2: true when live/visible, false when DISABLED (suspended-but-
     * retained — spec kept, pty kept alive while the app is open). Pre-v6 rows
     * read back as true.
     */
    enabled: boolean;
}

/**
 * One node in the Code View file tree. Shape-compatible with react-fancy's
 * `TreeNodeData` so it can be fed straight into `<TreeNav>`. Produced by
 * the main-side `files:list-tree` walk.
 */
export interface TreeNodeData {
    id: string;
    label: string;
    type?: 'file' | 'folder';
    ext?: string;
    children?: TreeNodeData[];
}

/**
 * Normalised git status token for one file, produced by `files:git-status`.
 * Maps a workspace-relative path → one of these. Used to colour the tree.
 */
export type GitFileStatus =
    | 'untracked'
    | 'modified'
    | 'added'
    | 'deleted'
    | 'renamed'
    | 'ignored';

export type GitStatusMap = Record<string, GitFileStatus>;

interface CreateAgiOpts {
    slug: string;
    name: string;
    parent_path: string;
    remote?:
        | { kind: 'none' }
        | { kind: 'paste'; url: string }
        | { kind: 'auto'; owner: string };
}

export interface CreateAgiResult {
    path: string;
    git_log_count: number;
    remote?: string;
}

export interface ConvertToAgiOpts {
    slug: string;
    name: string;
    parent_path: string;
    source:
        | { kind: 'local'; path: string }
        | { kind: 'remote'; url: string };
    sub_name?: string;
    remote?:
        | { kind: 'none' }
        | { kind: 'paste'; url: string }
        | { kind: 'auto'; owner: string };
}

export interface ConvertToAgiResult extends CreateAgiResult {
    submodule_path: string;
    submodule_url: string;
}

export interface AnalyseRepoCandidate {
    rel_path: string;
    abs_path: string;
    default_name: string;
    origin_url: string | null;
    head_ref: string | null;
}

export interface AnalyseKnowledgeCandidate {
    rel_path: string;
    abs_path: string;
    kind: 'file' | 'directory';
    suggested_target: string;
    size?: number;
}

export interface AnalyseOtherEntry {
    rel_path: string;
    kind: 'file' | 'directory';
}

export interface StructureDocStatus {
    isEnvelope: boolean;
    hasReadme: boolean;
    hasAgents: boolean;
    hasClaude: boolean;
    missing: boolean;
    hasRemote: boolean;
}
export interface AddStructureDocsResult {
    added: string[];
    committed: boolean;
    pushed: boolean;
    pushError?: string;
}
export interface McpStatus {
    repoServers: string[];
    rootServers: string[];
    missingAtRoot: string[];
    needsConsolidation: boolean;
}
export interface ConsolidateMcpResult {
    servers: string[];
    files: string[];
    committed: boolean;
    pushed: boolean;
    pushError?: string;
    gitignored?: boolean;
}

export type SourceKind = 'single-repo' | 'monorepo' | 'repo-collection' | 'plain-folder';

export interface SubmoduleEntry {
    name: string;
    path: string;
    url: string;
}

export interface RootEntry {
    rel_path: string;
    abs_path: string;
    kind: 'file' | 'directory';
    git_state: 'tracked' | 'untracked' | 'ignored';
    suggested: 'codebase' | 'knowledge' | 'root';
    suggested_target: string;
}

export interface AnalyseResult {
    source_kind: SourceKind;
    root: string;
    repos: AnalyseRepoCandidate[];
    knowledge: AnalyseKnowledgeCandidate[];
    other: AnalyseOtherEntry[];
    /** Present for 'single-repo' AND 'monorepo' sources (root is a repo). */
    root_entries?: RootEntry[];
    /** Root repo's declared submodules; non-empty when source_kind === 'monorepo'. */
    submodules: SubmoduleEntry[];
}

export type ProjectJsonRepoRole = 'host' | 'package';

/** A member repo as recorded in the envelope's project.json. */
export interface ProjectJsonRepo {
    name: string;
    url?: string;
    /** Checkout path inside the envelope, always `repos/<name>`. */
    path?: string;
    /** 'host' = the primary build target; 'package' = a consumed dependency. */
    role?: ProjectJsonRepoRole;
    /** Tracked branch for `git submodule update --remote`. */
    branch?: string;
}

export interface AgiPlanRepo {
    source: string;
    is_local: boolean;
    submodule_name: string;
}
export interface AgiPlanKnowledge {
    source_abs_path: string;
    kind: 'file' | 'directory';
    target_subdir: string;
    /** Copy beside project.json instead of into .ai/. */
    to_envelope_root?: boolean;
}
export interface ConvertPlanOpts {
    slug: string;
    name: string;
    parent_path: string;
    repos: AgiPlanRepo[];
    knowledge: AgiPlanKnowledge[];
    /** `submodule_name` of the host (primary) member — the repo Aionima builds/hosts. */
    primary?: string;
    remote?:
        | { kind: 'none' }
        | { kind: 'paste'; url: string }
        | { kind: 'auto'; owner: string };
}

interface GenieApi {
    auth: {
        startSignIn: (kind?: BackendKind) => Promise<{
            ok: boolean;
            message?: string;
        }>;
        redeemCode: (code: string) => Promise<{ ok: boolean }>;
        signOut: (kind?: BackendKind) => Promise<{ ok: boolean }>;
        whoami: (kind?: BackendKind) => Promise<BackendUser | null | Record<string, BackendUser | null>>;
        summary: () => Promise<SignedInSummaryItem[]>;
    };
    issueWatch: {
        repos: (workspaceId: string) => Promise<WatchRepoView[]>;
        set: (
            workspaceId: string,
            owner: string,
            repo: string,
            enabled: boolean,
        ) => Promise<{ ok: boolean }>;
        feed: (workspaceId: string) => Promise<WatchFeedItem[]>;
        markSeen: (workspaceId: string) => Promise<{ ok: boolean }>;
        counts: () => Promise<Record<string, number>>;
    };
    aionima: {
        getConfig: () => Promise<AionimaConfig>;
        setConfig: (patch: AionimaConfig) => Promise<{
            config: AionimaConfig;
            user: BackendUser | null;
            /** Probe failure detail when user is null (e.g. bad host / network). */
            error?: string;
        }>;
        hostInfo: () => Promise<string>;
    };
    settings: {
        get: () => Promise<Settings>;
        set: (patch: Partial<Settings>) => Promise<Settings>;
        chooseFolder: (label?: string) => Promise<string | null>;
        chooseFile: (label?: string) => Promise<string | null>;
        detectEditors: () => Promise<EditorDetection[]>;
        detectShells: () => Promise<{
            shells: ShellDetection[];
            defaultId: string | null;
        }>;
    };
    workspaces: {
        list: () => Promise<WorkspaceRow[]>;
        add: (row: WorkspaceRow) => Promise<WorkspaceRow>;
        update: (
            id: string,
            patch: Partial<WorkspaceRow>,
        ) => Promise<WorkspaceRow | undefined>;
        remove: (id: string) => Promise<{ ok: boolean }>;
        touch: (id: string) => Promise<{ ok: boolean }>;
        /** Persist a new sidebar order (full ordered list of workspace ids). */
        reorder: (ids: string[]) => Promise<{ ok: boolean }>;
        /** Toggle the agent-integration MCP for a workspace's terminals. */
        setMcp: (id: string, enabled: boolean) => Promise<{ ok: boolean }>;
        /** Repo subfolder names under the workspace envelope (for Add Process cwd). */
        repos: (id: string) => Promise<string[]>;
        open: (id: string) => Promise<{ ok: boolean }>;
    };
    agi: {
        detect: (folder: string) => Promise<DetectResult>;
        create: (opts: CreateAgiOpts) => Promise<CreateAgiResult>;
        importExisting: (folder: string) => Promise<DetectResult>;
        convert: (opts: ConvertToAgiOpts) => Promise<ConvertToAgiResult>;
        analyse: (folder: string) => Promise<AnalyseResult>;
        convertPlan: (opts: ConvertPlanOpts) => Promise<CreateAgiResult>;
        push: (envelopePath: string, branch?: string) => Promise<{ ok: boolean }>;
        docStatus: (envelopePath: string) => Promise<StructureDocStatus>;
        addDocs: (
            envelopePath: string,
            name: string,
            slug: string,
        ) => Promise<AddStructureDocsResult>;
        mcpStatus: (envelopePath: string) => Promise<McpStatus>;
        consolidateMcp: (envelopePath: string) => Promise<ConsolidateMcpResult>;
    };
    tynn: {
        projects: () => Promise<TynnProject[]>;
        captureWish: (
            projectId: string,
            content: string,
            backendKind?: BackendKind,
        ) => Promise<{ id: string; backend: BackendKind }>;
        inbox: () => Promise<InboxPayload>;
        openInBrowser: (
            urlOrPath: string,
            backendKind?: BackendKind,
        ) => Promise<{ ok: boolean }>;
    };
    tynnHost: {
        get: () => Promise<string>;
    };
    app: {
        hideCapture: () => Promise<{ ok: boolean }>;
        getCurrentProject: () => Promise<{ id: string; name: string } | null>;
        showSettings: () => Promise<{ ok: boolean }>;
        showDocs: () => Promise<{ ok: boolean }>;
        showMain: () => Promise<{ ok: boolean }>;
        openStage: (workspaceId?: string) => Promise<{ ok: boolean }>;
        quit: () => Promise<{ ok: boolean }>;
        /**
         * Reply to the manual-quit terminal confirmation (see
         * on.confirmQuitTerminals). `confirmed:false` aborts the quit; otherwise
         * `keepIds` are the host terminals to leave running. Fire-and-forget.
         */
        quitDecision: (payload: { confirmed: boolean; keepIds: string[] }) => void;
        autostart: {
            get: () => Promise<{
                enabled: boolean;
                supported: boolean;
                platform: string;
            }>;
            set: (enabled: boolean) => Promise<{ enabled: boolean }>;
        };
    };
    docs: {
        list: () => Promise<DocEntry[]>;
        read: (slug: string) => Promise<string | null>;
    };
    process: {
        /** Start a background Process service runner. */
        start: (id: string) => Promise<{ ok: boolean }>;
        /** Stop a Process (deliberate — won't auto-restart). */
        stop: (id: string) => Promise<{ ok: boolean }>;
        /** Restart a Process. */
        restart: (id: string) => Promise<{ ok: boolean }>;
        /** Current status of every managed Process (id → status). */
        statuses: () => Promise<Record<string, ProcessStatus>>;
        /** Recent output tail for a Process (ANSI-stripped) — the hover log. */
        log: (id: string) => Promise<string>;
    };
    cli: {
        /** Whether the tynn-cli toolkit is shipped with this build + its home dir. */
        info: () => Promise<{ shipped: boolean; home: string | null }>;
        /** Run the bundled install.sh to add the tools to PATH system-wide (Git Bash). */
        install: () => Promise<{ ok: boolean; output: string }>;
    };
    updater: {
        mode: () => Promise<'phase1' | 'phase2'>;
        status: () => Promise<UpdaterStatus>;
        check: () => Promise<UpdaterStatus>;
        apply: () => Promise<{ ok: boolean; error?: string }>;
        restart: () => Promise<{ ok: boolean; error?: string }>;
        getConfig: () => Promise<UpdaterConfig>;
        setConfig: (
            patch: Partial<UpdaterConfig>,
        ) => Promise<UpdaterConfig>;
        changelog: (latest: string) => Promise<Changelog>;
    };
    terminalSpec: {
        list: () => Promise<TerminalSpec[]>;
        create: (input: {
            id: string;
            workspace_id: string | null;
            label: string;
            cwd: string;
            shell?: string | null;
            args?: string[];
            env?: Record<string, string>;
            type?: ViewType;
            meta?: ViewMeta;
        }) => Promise<TerminalSpec>;
        update: (id: string, patch: Partial<TerminalSpec>) => Promise<TerminalSpec | null>;
        remove: (id: string) => Promise<boolean>;
        get: (id: string) => Promise<TerminalSpec | null>;
        touch: (id: string) => Promise<{ ok: boolean }>;
    };
    files: {
        listTree: (
            workspacePath: string,
            opts?: { maxDepth?: number; maxEntries?: number; root?: string },
        ) => Promise<TreeNodeData[]>;
        read: (
            workspacePath: string,
            relPath: string,
        ) => Promise<{ content: string; truncated: boolean }>;
        write: (
            workspacePath: string,
            relPath: string,
            content: string,
        ) => Promise<{ ok: boolean }>;
        createFile: (
            workspacePath: string,
            relPath: string,
        ) => Promise<{ ok: boolean }>;
        createFolder: (
            workspacePath: string,
            relPath: string,
        ) => Promise<{ ok: boolean }>;
        rename: (
            workspacePath: string,
            fromRel: string,
            toRel: string,
        ) => Promise<{ ok: boolean }>;
        duplicate: (
            workspacePath: string,
            relPath: string,
        ) => Promise<{ ok: boolean; relPath: string }>;
        delete: (
            workspacePath: string,
            relPath: string,
        ) => Promise<{ ok: boolean }>;
        gitStatus: (
            workspacePath: string,
            opts?: { ignored?: boolean },
        ) => Promise<GitStatusMap>;
    };
    github: {
        status: () => Promise<{
            connected: boolean;
            username: string | null;
            clientIdSet: boolean;
            builtInClientId: boolean;
            usingOverride: boolean;
            activeClientId: string;
            storageOk: boolean;
            flow:
                | { kind: 'idle' }
                | {
                      kind: 'pending';
                      userCode: string;
                      verificationUri: string;
                      expiresInSec: number;
                  }
                | {
                      kind: 'success';
                      user: { login: string; name: string | null; avatar_url: string };
                  }
                | { kind: 'error'; code: string; message: string };
        }>;
        startDevice: () => Promise<{
            user_code: string;
            verification_uri: string;
            expires_in: number;
            interval: number;
        }>;
        cancelDevice: () => Promise<{ ok: boolean }>;
        resetClientId: () => Promise<{ ok: boolean }>;
        disconnect: () => Promise<{ ok: boolean }>;
        user: () => Promise<{ login: string; name: string | null; avatar_url: string }>;
        orgs: () => Promise<
            Array<{
                login: string;
                avatar_url: string;
                can_create_repository?: boolean;
            }>
        >;
        createRepo: (opts: {
            name: string;
            owner?: string | null;
            description?: string;
            private?: boolean;
        }) => Promise<{
            full_name: string;
            clone_url: string;
            ssh_url: string;
            html_url: string;
            default_branch: string;
        }>;
        forkRepo: (opts: {
            owner: string;
            repo: string;
            intoOrg?: string | null;
            name?: string;
        }) => Promise<{
            full_name: string;
            clone_url: string;
            ssh_url: string;
            html_url: string;
            default_branch: string;
        }>;
        parseRemote: (
            url: string,
        ) => Promise<{ owner: string; repo: string } | null>;
    };

    terminal: {
        create: (opts: {
            id: string;
            cwd: string;
            shell?: string;
            args?: string[];
            cols?: number;
            rows?: number;
            env?: Record<string, string>;
        }) => Promise<{
            id: string;
            pid: number;
            shell: string;
            existing: boolean;
            scrollback: string;
            snapshot?: { serialized: string; savedAt: number };
        }>;
        write: (id: string, data: string) => Promise<boolean>;
        resize: (id: string, cols: number, rows: number) => Promise<boolean>;
        /** Persist a SerializeAddon snapshot of this terminal's buffer (Tier 1). */
        snapshot: (id: string, serialized: string) => Promise<boolean>;
        detach: (id: string) => Promise<boolean>;
        /**
         * Tier 2: keep a pty alive on zero owners (retained=true, for disable)
         * or release it (retained=false). Set true BEFORE the last detach.
         * Refused (ok=false) when retaining would exceed the cap.
         */
        setRetained: (
            id: string,
            retained: boolean,
        ) => Promise<{ ok: boolean; retainedCount: number; max: number; reason?: string }>;
        kill: (id: string) => Promise<boolean>;
        list: () => Promise<Array<{ id: string; pid: number; shell: string }>>;
        /** Agent-integration MCP: clear a terminal's attention glow (imDone). */
        clearAttention: (id: string) => Promise<void>;
    };
    /** Agent-integration MCP: the ForceTheQuestion OS-level modal. */
    ask: {
        onShow: (
            cb: (payload: { id: string; questions: ForceQuestionSpec[] }) => void,
        ) => () => void;
        answer: (id: string, answers: ForceAnswerSpec[]) => Promise<void>;
        cancel: (id: string) => Promise<void>;
        /** Signal main the show-listener is attached (race-free delivery). */
        ready: () => Promise<void>;
        /** Close this modal window regardless of state (resolves cancelled). */
        dismiss: () => Promise<void>;
    };
    on: {
        authChanged: (
            cb: (payload: {
                backend?: BackendKind;
                signedIn: boolean;
            }) => void,
        ) => () => void;
        inboxUpdated: (cb: (payload: { count: number }) => void) => () => void;
        /** Customization: play a notification chime (agent imDone). */
        notifySound: (cb: (payload: { kind: string }) => void) => () => void;
        /** Issue Watch: per-workspace unread counts changed. */
        issueWatchUpdate: (
            cb: (payload: { counts: Record<string, number> }) => void,
        ) => () => void;
        terminalData: (
            cb: (payload: { id: string; data: string }) => void,
        ) => () => void;
        terminalExit: (
            cb: (payload: { id: string; exitCode: number; signal?: number }) => void,
        ) => () => void;
        /** Main asks every window to serialize its terminals before quit (Tier 1). */
        terminalSnapshotRequest: (cb: () => void) => () => void;
        /** Live pty count broadcast (Tier 2 resource awareness). */
        terminalCount: (cb: (payload: { count: number }) => void) => () => void;
        /** Agent-integration MCP: a terminal asked for attention (imDone) or cleared. */
        terminalAttention: (
            cb: (payload: { id: string; on: boolean }) => void,
        ) => () => void;
        /** A background Process changed status. */
        processStatus: (
            cb: (payload: { id: string; status: ProcessStatus }) => void,
        ) => () => void;
        /** Tier 3 detached-host status — fired on fallback to in-process. */
        terminalHostStatus: (
            cb: (payload: { message: string; level: 'info' | 'warn' }) => void,
        ) => () => void;
        /**
         * Manual-quit terminal confirmation (T3). Main asks the master window to
         * pick which detached terminals to keep running vs shut down before quit.
         * Reply via app.quitDecision().
         */
        confirmQuitTerminals: (
            cb: (payload: {
                terminals: Array<{ id: string; pid: number; shell: string }>;
            }) => void,
        ) => () => void;
        updaterStatus: (cb: (status: UpdaterStatus) => void) => () => void;
        updaterLog: (cb: (payload: { line: string }) => void) => () => void;
    };
}

declare global {
    interface Window {
        genie: GenieApi;
    }
}

export function api(): GenieApi {
    if (typeof window === 'undefined' || !window.genie) {
        throw new Error(
            'window.genie unavailable — preload.ts did not run. Either the page is being rendered outside Electron (e.g. opened directly in a browser) or the preload script failed to compile. Check the Electron main-process console for a load error.',
        );
    }
    return window.genie;
}

/** Returns true when the preload bridge is wired and callable. */
export function hasGenieBridge(): boolean {
    return typeof window !== 'undefined' && !!window.genie;
}

export function ulid(): string {
    const t = Date.now().toString(36);
    const r = Math.random().toString(36).slice(2, 10);
    return (t + r).padEnd(20, '0').slice(0, 20).toUpperCase();
}

/**
 * Detected shells, cached for the window's lifetime. Detection walks the
 * filesystem in main, so every TerminalPanel sharing one promise beats N
 * panels firing N IPC round-trips on a grid render. Installing a new
 * shell mid-session just needs a window reload to show up.
 */
let shellsPromise: Promise<{
    shells: ShellDetection[];
    defaultId: string | null;
}> | null = null;
export function detectedShells(): Promise<{
    shells: ShellDetection[];
    defaultId: string | null;
}> {
    if (!shellsPromise) {
        shellsPromise = api()
            .settings.detectShells()
            .catch(() => ({ shells: [], defaultId: null }));
    }
    return shellsPromise;
}
