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
}

export interface DetectResult {
    state: 'EMPTY' | 'SIMPLE_REPO' | 'PRE_INIT' | 'FULL_ENVELOPE';
    has_project_json: boolean;
    has_root_git: boolean;
    has_gitmodules: boolean;
    repos: string[];
}

export interface Settings {
    primary_workspace?: string;
    default_editor?: string;
    default_editor_cmd?: string;
    default_start_cmd?: string;
    default_env_file?: string;
    global_hotkey?: string;
    tynn_host?: string;
    notifications_muted?: string;
    auto_update?: 'on' | 'off';
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
    | 'applying'
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
    repo: string | null;
}

export interface UpdaterConfig {
    repo: string;
    pollHours: number;
}

export interface TerminalSpec {
    id: string;
    workspace_id: string | null;
    label: string;
    cwd: string;
    shell: string | null;
    args: string[];
    env: Record<string, string>;
    sort_order: number;
    created_at: string;
    last_opened_at: string | null;
}

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

export interface AnalyseResult {
    root: string;
    repos: AnalyseRepoCandidate[];
    knowledge: AnalyseKnowledgeCandidate[];
    other: AnalyseOtherEntry[];
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
}
export interface ConvertPlanOpts {
    slug: string;
    name: string;
    parent_path: string;
    repos: AgiPlanRepo[];
    knowledge: AgiPlanKnowledge[];
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
    aionima: {
        getConfig: () => Promise<AionimaConfig>;
        setConfig: (patch: AionimaConfig) => Promise<{
            config: AionimaConfig;
            user: BackendUser | null;
        }>;
        hostInfo: () => Promise<string>;
    };
    settings: {
        get: () => Promise<Settings>;
        set: (patch: Partial<Settings>) => Promise<Settings>;
        chooseFolder: (label?: string) => Promise<string | null>;
        chooseFile: (label?: string) => Promise<string | null>;
        detectEditors: () => Promise<EditorDetection[]>;
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
        showMain: () => Promise<{ ok: boolean }>;
        openStage: (workspaceId?: string) => Promise<{ ok: boolean }>;
        quit: () => Promise<{ ok: boolean }>;
    };
    updater: {
        status: () => Promise<UpdaterStatus>;
        check: () => Promise<UpdaterStatus>;
        apply: () => Promise<{ ok: boolean; error?: string }>;
        getConfig: () => Promise<UpdaterConfig>;
        setConfig: (
            patch: Partial<UpdaterConfig>,
        ) => Promise<UpdaterConfig>;
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
        }) => Promise<TerminalSpec>;
        update: (id: string, patch: Partial<TerminalSpec>) => Promise<TerminalSpec | null>;
        remove: (id: string) => Promise<boolean>;
        get: (id: string) => Promise<TerminalSpec | null>;
        touch: (id: string) => Promise<{ ok: boolean }>;
    };
    github: {
        status: () => Promise<{
            connected: boolean;
            username: string | null;
            clientIdSet: boolean;
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
        }>;
        write: (id: string, data: string) => Promise<boolean>;
        resize: (id: string, cols: number, rows: number) => Promise<boolean>;
        detach: (id: string) => Promise<boolean>;
        kill: (id: string) => Promise<boolean>;
        list: () => Promise<Array<{ id: string; pid: number; shell: string }>>;
    };
    on: {
        authChanged: (
            cb: (payload: {
                backend?: BackendKind;
                signedIn: boolean;
            }) => void,
        ) => () => void;
        inboxUpdated: (cb: (payload: { count: number }) => void) => () => void;
        terminalData: (
            cb: (payload: { id: string; data: string }) => void,
        ) => () => void;
        terminalExit: (
            cb: (payload: { id: string; exitCode: number; signal?: number }) => void,
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
