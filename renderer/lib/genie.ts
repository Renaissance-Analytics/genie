/**
 * Typed handle on the contextBridge surface exposed in main/preload.ts.
 * Always go through this — no direct ipcRenderer use anywhere in the
 * renderer.
 */

import { makeRemoteBridge } from './remote-bridge';
import type { TynnHealth } from '../../main/mcp/tynn-health';

export type { TynnHealth };

export type BackendKind = 'tynn' | 'aionima';

/** A Genie tool presented as a droppable step. Derived from the capability model. */
export interface FlowNodeKindView {
    kind: string;
    tool: string;
    capability: string;
    label: string;
    risk: 'standard' | 'high';
}

/** What starts a flow, read off its graph. */
export interface FlowTriggerView {
    nodeId: string;
    kind: 'manual' | 'schedule' | 'webhook';
    cron?: string;
    /** Set when Genie recognises the trigger but cannot arm it yet. */
    unsupported?: string;
}

export interface FlowSummaryView {
    id: string;
    appId: string;
    name: string;
    enabled: boolean;
    updatedAt: string;
    triggers: FlowTriggerView[];
    /** False when the stored graph could not be parsed — say so, do not hide it. */
    readable: boolean;
}

export interface FlowView {
    id: string;
    appId: string;
    name: string;
    graph: unknown;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface FlowNodeRefusalView {
    nodeId: string;
    label?: string;
    reason: string;
}

export interface FlowAdmissionView {
    allowed: boolean;
    capabilities: string[];
    refusals: FlowNodeRefusalView[];
    /** Set when the whole graph is refused for a reason no single node caused. */
    reason?: string;
}

export interface FlowRunOutcomeView {
    ok: boolean;
    error?: string;
    refusals?: FlowNodeRefusalView[];
    capabilities?: string[];
    outputs?: Record<string, unknown>;
}

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

/**
 * An owner the signed-in user may create a Tynn project under, for the
 * "Create new project" form. "Personal" is always offered first (kind=user);
 * the user's orgs/teams follow.
 */
export interface OwnerOption {
    kind: 'user' | 'organization' | 'team';
    id: string;
    label: string;
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
    /** Require user approval before an agent (manageProcess) starts a background
     *  process. 1=require approval (default), 0=auto-run. */
    process_approval?: number;
    /** Require user approval before an agent (manageTerminals / runAgent) spawns
     *  a terminal, writes to one, or launches/drives a coding agent. 1=require
     *  approval (default), 0=auto-run. */
    terminal_approval?: number;
    /** Require user approval before an agent (manageProcess) arms a SCHEDULED
     *  task — a process with `meta.schedule`. 1=require approval (default),
     *  0=arm immediately. */
    schedule_approval?: number;
    /** AgentInbox OUTER tier — who may reach INTO this workspace (its channels and
     *  its agents) from another workspace. 'all' is the default and preserves the
     *  pre-feature behaviour. Resolve via `workspaces.getAgentAccess`. */
    agent_access?: WorkspaceAgentAccess;
    /** 1 = this workspace is the designated WORKSTATION OPERATOR and its agent may
     *  act on every workspace on this machine (Tynn #248). */
    workstation_operator?: number | null;
    /** How many agent terminals this workspace may run at once (Tynn #117). RAW —
     *  NULL inherits the workstation default and unlimited is a main-side
     *  sentinel, so read it via `workspaces.getMaxAgentTerminals`, which decodes
     *  both. Write it ONLY via `workspaces.setMaxAgentTerminals`: the generic
     *  `update` patch deliberately drops this column, which is what stops an agent
     *  raising its own cap. */
    max_agent_terminals?: number | null;
    /** Workspace ids admitted when `agent_access: 'specific'`, JSON-encoded.
     *  Resolve via `workspaces.getAgentAccess` rather than parsing here. */
    agent_access_workspaces?: string | null;
    /** Per-workspace IssueWatch remediation policy (null reads as 'surface'). */
    issuewatch_policy?: 'surface' | 'fix' | 'fix-and-ship' | null;
    /** Per-workspace IssueWatch granularity, JSON-encoded (null reads as the
     *  all-on + upstream-issues+prs defaults). Resolve via the dedicated
     *  `workspaces.getIssuewatchGranularity` IPC rather than parsing here. */
    issuewatch_granularity?: string | null;
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

/** One pending ForceTheQuestion in the top-bar inbox (mirrors main PendingQuestion). */
export interface PendingQuestionSpec {
    id: string;
    questions: ForceQuestionSpec[];
    workspaceLabel?: string;
    index: number;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    /** The remote host it was forwarded from (undefined ⇒ local). */
    remoteHost?: string;
    /** True for a DND-deferred question (never popped a modal). */
    deferred?: boolean;
    /** When the question ARRIVED (ms epoch), stamped at enqueue — the inbox shows
     *  it as "came in 5m ago". Absent when it was forwarded from a host running an
     *  older build, so render nothing rather than assuming a time. */
    createdAt?: number;
}

/** Pending questions grouped by workspace for the inbox panel (main-side grouping). */
export interface WorkspaceQuestionGroupSpec {
    workspaceLabel: string;
    remoteHost?: string;
    count: number;
    topPriority: 'low' | 'normal' | 'high' | 'urgent';
    questions: PendingQuestionSpec[];
}

/**
 * Issue Watch: per-workspace tallies by bucket (the 4-dot pill). The three
 * security-alert kinds (dependabot / code-scanning / secret-scanning) collapse
 * into one `security` bucket — the pill shows one security dot, not three.
 * Mirrors `TypeCounts` in main/issue-watch/index.ts.
 */
export interface WatchTypeCounts {
    issue: number;
    pr: number;
    /** dependabot + code-scanning + secret-scanning. */
    security: number;
    /**
     * Unresolved project feedback in Tynn — the one bucket with no GitHub
     * stream behind it, and 0 on a workspace Tynn is not feeding.
     */
    feedback: number;
    /** False until Tynn has delivered this workspace at least once. */
    knownToServer: boolean;
}

/**
 * Why an Issue Watch read came back empty. `null` means the read SUCCEEDED
 * (genuinely no items) — distinct from a swallowed failure, so the flyout can
 * say "no open issues" only when true and otherwise explain why it can't see
 * them. Mirrors `WatchFetchError` in main/github/api.ts.
 */
export type WatchFetchError =
    | 'unauthenticated'
    | 'forbidden'
    | 'not_found'
    | 'rate_limited'
    | 'unknown';

/**
 * Issue Watch: a classified read failure PLUS the raw HTTP status + GitHub
 * message behind it, so the flyout can show the EXACT cause ("GitHub returned
 * 401: Bad credentials") rather than a vague "unexpected error". Mirrors
 * `WatchErrorDetail` in main/github/api.ts.
 */
export interface WatchErrorDetail {
    error: WatchFetchError;
    /** Underlying HTTP status when the failure came from GitHub's API. */
    status?: number;
    /** GitHub's message (or the auth-error message) for the failure. */
    message?: string;
}

/** Issue Watch: a detected repo + its watch state for the flyout. */
export interface WatchRepoView {
    owner: string;
    repo: string;
    enabled: boolean;
    unread: number;
    /** Why this repo's last read was empty (null = read ok / never polled). */
    error: WatchFetchError | null;
    /** Raw detail (HTTP status + message) behind `error`, or null. */
    detail: WatchErrorDetail | null;
    /** When this repo is a fork AND the workspace watches upstream, the parent
     *  repo whose Issues/PRs are folded in — drives the "⬆ owner/repo" badge.
     *  Null/absent for a non-fork, an orphan fork, or upstream watching off. */
    upstream?: { owner: string; repo: string } | null;
}

/**
 * Issue Watch granularity — WHAT a workspace watches + pings about (mirrors
 * `IssuewatchGranularity` in main/db.ts). `own` toggles each own-repo kind;
 * `upstream` chooses how much of a fork's parent to watch.
 */
export interface IssuewatchGranularity {
    own: { issues: boolean; pulls: boolean; security: boolean };
    upstream: 'none' | 'issues' | 'issues+prs';
}

/** How an agent acts on an IssueWatch bucket: 'surface' (report only / hold),
 *  'fix' (fix the root cause, report before shipping), or 'fix-and-ship'
 *  (remediate + ship right away). Mirrors `IssuewatchPolicy` in main/db.ts. */
export type IssuewatchPolicy = 'surface' | 'fix' | 'fix-and-ship';

/** One local dev site in the header `.gen` popover — opens in the Testing
 *  Browser via the loopback carrier. */
export interface LocalGenSite {
    genName: string;
    /** The upstream loopback vhost the `.gen` maps to (e.g. tynn.test). */
    hostname: string;
}

/** One connected host's enabled `.gen` site in the header popover. */
export interface HostGenSite {
    genName: string;
    siteId: string;
    hostname: string;
}

/** The header `.gen` popover payload: local sites + per-connected-host sites. */
export interface GenSitesAll {
    local: LocalGenSite[];
    hosts: Array<{ connKey: string; hostname: string; sites: HostGenSite[] }>;
}

/* --- the container DEV SERVER (#234) -------------------------------------- *
 *
 * What GENIE serves — a container in the workspace's sandbox, published to
 * loopback and routed at `<name>.gen`. The ONLY source of a `.gen` site: the
 * hosts-file discovery that used to carry someone else's `*.test` vhost under a
 * `.gen` name is retired.
 *
 * These mirror `main/mcp/protocol.ts` exactly, because the Site Manager and an
 * MCP agent call the SAME main-side function (`runManageSite` /
 * `runManageService`). Re-declared rather than imported for the same reason
 * every other type here is: the renderer must not reach into main.            */

/** Which container runtime is driving, or why none is. */
export interface DevRuntimeInfo {
    /** `docker`, `podman`, or `none`. */
    kind: string;
    version?: string;
    /** Present when `kind` is `none`: the sentence that says what to install. */
    installHint?: string;
}

/** One way a repo could be run — the layered site definition's offer. */
export interface DevSiteRunOption {
    runMode: string;
    stack?: string;
    /** The repo file that produced this option (`Dockerfile`, `go.mod`, …). */
    source: string;
    reason: string;
    command?: string[];
    port?: number;
    /** False when something load-bearing here was guessed. */
    confident: boolean;
    /** Present when `confident` is false: what you must supply or check. */
    needs?: string;
}

/**
 * How Genie's OWN bundled web server (Caddy) serves a host-native site that is
 * NOT its own dev server — the human/agent declares a MODE and Genie renders the
 * config (genie #167/#171). Mirror of main's `HostServeConfig`; `root` is
 * repo-relative (`dist`, `dashboard/dist`, `public`).
 *   - `static` — serve a built directory, `spa` adding the index.html fallback;
 *   - `php`    — serve `public/` via a FastCGI PHP worker (the nginx/Valet model).
 * Absent ⇒ the site runs the repo's OWN dev server, reverse-proxied (proxy mode).
 *
 * `version` PINS the engine (genie#207); omitted, the site follows the machine
 * default set in Settings → Toolchain and moves with it.
 */
export type HostServeConfig =
    | { mode: 'static'; root: string; spa?: boolean }
    | { mode: 'php'; root: string; version?: string };

/** One configured dev site plus whatever is currently true about it. */
export interface DevSiteInfo {
    id: string;
    name: string;
    genName: string;
    repo: string;
    runMode: string;
    kind: 'http' | 'tcp';
    enabled: boolean;
    /** Opt-in: `<name>.gen` exposed to real external browsers (story #238). */
    browserExposed?: boolean;
    /** running | stopped | failed */
    state: string;
    /** Whether the published port ANSWERED. `running` only says the container
     *  is up; this says the dev server inside it has bound. */
    ready?: boolean;
    port?: number;
    hostPort?: number;
    origin?: string;
    /** The origin that answers on THIS machine, in the protocol the port really
     *  speaks: `https://<genName>:<hostPort>` for a container site (the sandbox's
     *  Caddy, routed by SNI), `http://127.0.0.1:<port>` for a host-native one. */
    localOrigin?: string;
    /** The exact command that reaches `localOrigin` from here — the https form
     *  needs `--resolve` to pin the `.gen` name to loopback (genie#195). */
    localCurl?: string;
    command?: string[];
    image?: string;
    /** What is being hosted (`php`, `node`, `static`, …) and which production
     *  server holds the port. */
    stack?: string;
    server?: string;
    /** The production BUILD that runs before the server, and the server's argv. */
    build?: Array<{ label: string; command: string[]; optional?: boolean }>;
    serve?: string[];
    /** The last build's log — present on a start that built, and streamed live
     *  while a build is in flight (Gap 2). */
    buildLog?: string;
    /** Extra browser-facing surfaces, as they resolved. */
    exposed?: Array<{ name: string; protocol: string; genName: string; hostPort?: number }>;
    /** The stored env + upstream Host, so the Edit form can prefill them. */
    env?: Record<string, string>;
    upstreamHost?: string;
    /** How Genie serves this host-native site (static/php), so the Edit form can
     *  prefill the serve-mode picker. Absent ⇒ it runs the repo's own dev server. */
    hostServe?: HostServeConfig;
    /** The transient start stage, present ONLY while a start is in flight (Gap 2):
     *  `pulling → building → starting → ready|failed`. A settled row omits it. */
    phase?: DevSitePhase;
    error?: string;
}

/** The transient stages a starting site passes through (Gap 2) — surfaced live so
 *  a card shows progress the instant Start is clicked, not only when it finishes. */
export type DevSitePhase = 'pulling' | 'building' | 'starting' | 'ready' | 'failed';

/** One live START tick for a dev site, pushed over `on.devSiteProgress`. */
export interface DevSiteProgress {
    workspaceId: string;
    siteId: string;
    name: string;
    genName: string;
    phase: DevSitePhase;
    /** The accumulated build/pull log tail, when there is one. */
    log?: string;
    /** Set on `failed`: the reason the start did not complete. */
    error?: string;
}

export interface ManageSiteRequest {
    action:
        | 'list'
        | 'detect'
        | 'create'
        | 'update'
        | 'start'
        | 'stop'
        | 'restart'
        | 'status'
        | 'logs'
        | 'open'
        | 'remove';
    name?: string;
    repo?: string;
    runMode?: string;
    image?: string;
    command?: string[];
    /** create/update: the production build steps and the server's literal argv. */
    build?: Array<{ label?: string; command: string[]; optional?: boolean }>;
    serve?: string[];
    port?: number;
    /** create: point `<name>.gen` at a dev server ALREADY running as a host process
     *  on `127.0.0.1:<hostPort>` — no container, no build (a reverse-proxy). */
    hostPort?: number;
    /** create/update: have GENIE serve this host-native site (static/php) rather
     *  than running a repo dev server. `null` on update CLEARS it back to proxy
     *  (the repo's own dev server); omit to leave the serve mode untouched. */
    hostServe?: HostServeConfig | null;
    env?: Record<string, string>;
    /** create/update: extra browser-facing surfaces. */
    exposed?: Array<{ name: string; port: number; protocol: string; reason: string }>;
    kind?: 'http' | 'tcp';
    genName?: string;
    upstreamHost?: string;
    enabled?: boolean;
    id?: string;
    tail?: number;
}

export interface ManageSiteResult {
    ok: boolean;
    error?: string;
    sites: DevSiteInfo[];
    affectedId?: string;
    options?: DevSiteRunOption[];
    applied?: DevSiteRunOption;
    logs?: string;
    /** create: what Genie did about the framework's Host-header allowlist —
     *  `solved` means it set something the framework definitely reads,
     *  `documented` means the repo still has to change. */
    hostAllowlist?: {
        framework: string;
        status: 'solved' | 'documented' | 'not-needed';
        note: string;
        upstreamHostFallback?: string;
    };
    runtime?: DevRuntimeInfo;
}

/** One reachable surface of a service, from BOTH sides of the boundary.
 *
 *  `host`/`port` are how a container ON THE WORKSPACE NETWORK dials the engine;
 *  `hostPort`/`localAddress` are how THIS MACHINE does. A connection string
 *  built from the second and handed to a container fails every time. */
export interface DevServiceEndpoint {
    name: string;
    kind: 'http' | 'tcp';
    host: string;
    port: number;
    hostPort?: number;
    localAddress?: string;
}

/** One configured service plus whatever is currently true about it. */
export interface DevServiceInfo {
    id: string;
    engine: string;
    version: string;
    /** `<engine>-<version>` — the unit engines are SHARED by. */
    engineKey: string;
    /** True when this workspace opted out of sharing and runs its own. */
    dedicated: boolean;
    /** This is the version whose connection this workspace's apps get. Only
     *  meaningful when the workspace holds two majors of one engine (#242 P3). */
    active?: boolean;
    enabled: boolean;
    /** running | stopped | failed */
    state: string;
    ready?: boolean;
    /** How many workspaces currently hold this engine (1 when dedicated). */
    holders?: number;
    endpoints?: DevServiceEndpoint[];
    /** The per-workspace names carved out of the shared engine. */
    namespace?: { identifier: string; dnsName: string };
    /** The env keys injected into this workspace's site containers. */
    envKeys?: string[];
    error?: string;
}

/* --- the WORKSTATION view of the Dev Server ------------------------------- *
 *
 * A service ENGINE is shared across every workspace on the same (engine,
 * major), its image is pulled once for the machine, and the container runtime
 * under it is a property of the computer. None of those has a workspace to
 * belong to, so they are read and driven at machine level — see
 * main/dev-server/workstation.ts.                                             */

/** One language runtime the dev base image provides. */
export interface DevBaseToolchain {
    id: string;
    label: string;
    version: string;
    /** Where the version is pinned (a Dockerfile ARG, or the Debian base tag). */
    source: string;
    /** Package managers shipped alongside it. */
    extras?: string[];
}

/** One shared service ENGINE on this machine. `installed` (image on disk),
 *  `state` (a container exists / is up) and `holders` (workspaces using it right
 *  now) are independent — every pair of them occurs, so none are merged. */
export interface DevEngineInfo {
    /** The CONTAINER's identity: an engine key, or `<engineKey>@<workspaceId>`
     *  for a dedicated one. What a machine-level action names. */
    recordKey: string;
    engineKey: string;
    engine: string;
    version: string;
    label: string;
    summary: string;
    /** `sql-database-role` | `redis-acl` | `namespace` | `none` — what a
     *  workspace's boundary on this engine actually is. */
    provision: string;
    image: string;
    containerName: string;
    /** The image is on this machine. Nothing was downloaded to find out. */
    installed: boolean;
    /** `absent` = no container; `stopped` = one exists but is not up. */
    state: 'running' | 'stopped' | 'absent';
    containerId?: string;
    dedicated: boolean;
    ownerWorkspaceId?: string;
    /** Workspaces holding it right now — the live reference count. */
    holders: number;
    /** Workspaces that have it configured at all, enabled or not. */
    configured: number;
    /** WHO — the workspace names. */
    workspaces: string[];
}

/** What one container-runtime candidate reported. */
export interface DevRuntimeProbe {
    kind: string;
    /** The CLI is on PATH. */
    installed: boolean;
    /** The CLI answered AND its engine did — only then is it usable. */
    running: boolean;
    version?: string;
    /** Redacted CLI output explaining a failed probe. */
    detail?: string;
}

/** The whole machine-level Dev Server read (`devServer.workstation`). */
export interface DevWorkstationInfo {
    runtime: {
        kind: string;
        version?: string;
        installHint?: string;
        /** `not-installed` vs `not-running` — they need opposite advice. */
        reason?: string;
        probes: DevRuntimeProbe[];
    };
    devBase: {
        image: string;
        installed: boolean;
        toolchain: DevBaseToolchain[];
    };
    engines: DevEngineInfo[];
    error?: string;
}

// --- first-run toolchain setup (#240) --------------------------------------
// Mirrors main/dev-server (toolchain-detect / -plan / -choice / -setup): the
// renderer can't import main types, so the wizard's shapes are restated here.

export type HostToolName =
    | 'git'
    | 'node'
    | 'npm'
    | 'php'
    | 'composer'
    | 'docker'
    | 'claude-code'
    | 'codex'
    // A Windows PREREQUISITE rather than a tool anyone picks: every
    // windows.php.net build links against the Visual C++ runtime, so php
    // installs and then cannot start without it (genie#209). It appears in the
    // setup plan on Windows only.
    | 'vcredist';
export type ToolchainPackageManager = 'winget' | 'brew' | 'apt' | 'dnf';
export type ToolchainInstallMethod = 'pm' | 'direct' | 'npm-global';

export interface HostToolProbe {
    name: HostToolName;
    installed: boolean;
    version?: string;
    /** Docker only: CLI present AND engine reachable. */
    running?: boolean;
    detail?: string;
}
export interface ToolchainReport {
    platform: string;
    probes: HostToolProbe[];
    present: HostToolName[];
    missing: HostToolName[];
}
export interface ToolchainPmProbe {
    pm: ToolchainPackageManager;
    available: boolean;
    version?: string;
}
export interface PackageManagerChoices {
    os: string;
    available: ToolchainPackageManager[];
    recommended?: ToolchainPackageManager;
    /** The manager to plan with by default — `direct` when none exists. */
    defaultChoice: ToolchainPackageManager | 'direct';
    probes: ToolchainPmProbe[];
}
export interface ToolchainInstallStep {
    tool: HostToolName;
    method: ToolchainInstallMethod;
    packageManager?: ToolchainPackageManager;
    requiresElevation: boolean;
    requiresRestart: boolean;
    dependsOn: HostToolName[];
}
export interface ToolchainConsentLine {
    tool: HostToolName;
    method: ToolchainInstallMethod;
    packageManager?: ToolchainPackageManager;
    requiresElevation: boolean;
    requiresRestart: boolean;
}
export interface ToolchainConsent {
    count: number;
    installs: ToolchainConsentLine[];
    requiresElevation: boolean;
    requiresRestart: boolean;
    elevated: HostToolName[];
    restarts: HostToolName[];
}
/** The wizard's "look" payload — what's here, what would install, at what cost. */
export interface ToolchainInspection {
    os: string;
    arch?: string;
    report: ToolchainReport;
    packageManagers: PackageManagerChoices;
    pmChoice: ToolchainPackageManager | 'direct';
    plan: ToolchainInstallStep[];
    consent: ToolchainConsent;
}

export type ToolchainStepStatus = 'succeeded' | 'failed' | 'skipped';
/** Streamed per tool as an install runs (`on.toolchainProgress`). */
export interface ToolchainProgress {
    tool: HostToolName;
    phase: 'start' | 'done';
    status?: ToolchainStepStatus;
}
export interface ToolchainStepResult {
    tool: HostToolName;
    status: ToolchainStepStatus;
    error?: string;
    version?: string;
}
/** The outcome of running an install plan (`devServer.toolchainInstall`). */
export interface ToolchainInstallResult {
    ok: boolean;
    results: ToolchainStepResult[];
    refused?: 'not-approved';
    restartRequired: boolean;
    skipped: HostToolName[];
    /** Set when the update was HELD because live work would be hit: `blocked`
     *  cannot be overridden, `warn` proceeds if the human confirms. */
    risk?: 'blocked' | 'warn';
    /** Why it was held — names the agents / containers / sites at stake. */
    error?: string;
    /** Exactly what is at stake. */
    affected?: string[];
}

/** Where a candidate "latest" version was learned. */
export type ToolchainUpdateSource =
    | 'version-index'
    | 'package-manager'
    | 'npm-global'
    | 'registry'
    | 'unknown';
/** Who installed a TOOL, as far as its resolved path can say (genie#213).
 *  Mirrors main/dev-server/tool-install-origin.ts. */
export type ToolInstallSource =
    | 'genie'
    | 'winget'
    | 'program-files'
    | 'homebrew'
    | 'npm-global'
    | 'system'
    | 'unknown';

export interface ToolInstallOrigin {
    /** True only for a binary inside Genie's own toolchain root — the ones Genie
     *  may update. */
    managedByGenie: boolean;
    source: ToolInstallSource;
    /** The directory holding the binary. */
    directory?: string;
}

/** One installed tool's update status (`devServer.toolchainUpdates`). */
export interface ToolUpdate {
    name: HostToolName;
    installed?: string;
    latest?: string;
    updateAvailable: boolean;
    /** Where the LATEST version number was learned. Not to be confused with
     *  {@link origin}, which is who installed the thing. */
    source: ToolchainUpdateSource;
    /** Who installed it and where, when the path could be resolved. */
    origin?: ToolInstallOrigin;
}

// --- multi-version languages (the Toolchain page) --------------------------
// Mirrors main/dev-server/toolchain-versions.ts. Restated here for the same
// reason as the wizard shapes above: the renderer cannot import main types.

/** The languages Genie manages VERSIONS of — one model for all five. */
export type LanguageTool = 'php' | 'node' | 'python' | 'go' | 'rust';

/** Who put an install on the machine. Only `genie` is selectable/removable;
 *  the rest are detected for awareness. */
export type EngineInstallSource = 'genie' | 'herd' | 'xampp' | 'nvm' | 'system';

/** ONE installed version: a DIRECTORY holding real executables (genie#206 —
 *  never a PATH entry, which on Windows is often just a `.bat` shim). */
export interface EngineInstall {
    tool: LanguageTool;
    version: string;
    dir: string;
    exe: string;
    source: EngineInstallSource;
    removable: boolean;
    sizeBytes?: number;
}

/** A site that consumes a language, and whether it PINNED a version. Absent
 *  `version` = it follows the machine default (and moves when that moves). */
export interface ToolchainSiteUsage {
    genName: string;
    tool: LanguageTool;
    version?: string;
}

/** The whole Toolchain page read (`devServer.toolchainInstalls`). */
export interface ToolchainInstallsInfo {
    installs: EngineInstall[];
    /** The machine default per language, already resolved. */
    defaults: Partial<Record<LanguageTool, string>>;
    /** Versions this release can install here, per language, newest first. */
    addable: Partial<Record<LanguageTool, string[]>>;
    /** Sites that consume a language, for the default-change sentence. */
    sites: ToolchainSiteUsage[];
    /** `<userData>/toolchain` — the directory Genie owns end to end. */
    root: string;
}

/** The outcome of adding or removing a version. */
export interface ToolchainVersionResult {
    ok: boolean;
    error?: string;
    /** Set by a removal: the version that became the default, or null when the
     *  language no longer has a managed install. */
    nextDefault?: string | null;
    /** Set by a removal: bytes reclaimed. */
    freedBytes?: number;
}

/** Machine-level start | stop | logs for ONE shared engine. */
export interface DevEngineActionRequest {
    recordKey: string;
    /** `install` PRE-DOWNLOADS this version's image (#242 P3, multi-version) —
     *  it never starts anything. */
    action: 'start' | 'stop' | 'logs' | 'install';
    tail?: number;
}

export interface DevEngineActionResult {
    ok: boolean;
    error?: string;
    logs?: string;
}

/** One engine Genie can run, as the catalog offers it. */
export interface DevServiceCatalogEntry {
    engine: string;
    label: string;
    summary: string;
    versions: string[];
    defaultVersion?: string;
    /** False for an engine that can only ever be dedicated (`custom`). */
    shared: boolean;
    /** `sql-database-role` | `redis-acl` | `namespace` — how strong the
     *  per-workspace boundary inside a shared engine actually is. */
    provision: string;
}

export interface ManageServiceRequest {
    action:
        | 'catalog'
        | 'list'
        | 'add'
        | 'start'
        | 'stop'
        | 'status'
        | 'logs'
        | 'connection'
        | 'dedicated'
        | 'remove';
    engine?: string;
    version?: string;
    dedicated?: boolean;
    image?: string;
    port?: number;
    env?: Record<string, string>;
    enabled?: boolean;
    id?: string;
    tail?: number;
    purge?: boolean;
}

export interface ManageServiceResult {
    ok: boolean;
    error?: string;
    services: DevServiceInfo[];
    affectedId?: string;
    catalog?: DevServiceCatalogEntry[];
    /** `connection`: the env a site container is actually given. */
    env?: Record<string, string>;
    logs?: string;
    runtime?: DevRuntimeInfo;
}

/** Per-bucket IssueWatch remediation policy (mirrors main/db.ts). The three count
 *  buckets — security (dependabot + code-scanning + secret-scanning), issue, pr —
 *  each carry their own policy. */
export interface IssuewatchPolicyBuckets {
    security: IssuewatchPolicy;
    issue: IssuewatchPolicy;
    pr: IssuewatchPolicy;
}

/** Issue Watch: the surfaced per-workspace status (why the feed is what it is). */
export interface WorkspaceWatchStatus {
    connected: boolean;
    error: WatchFetchError | null;
    /** Raw detail (HTTP status + message) behind `error`, or null. */
    detail: WatchErrorDetail | null;
    /** True when the stored GitHub session is dead — show a Reconnect CTA. */
    needsReauth: boolean;
    /**
     * The Issue Watch capabilities the SERVING machine's GitHub App is missing
     * (the `issue-watch.*` keys the flyout gates on). Host-sourced in a remote
     * window (via the bridge's `/api/desktop/issue-watch/status`) so the gate
     * reflects the HOST's App grants, not the client's. Optional so an older
     * host that predates the field degrades to "nothing gated" instead of
     * breaking. Empty when GitHub isn't connected.
     */
    missingCapabilities?: GithubCapabilityKey[];
    serviceState?: 'connecting' | 'connected' | 'signed-out' | 'disabled' | 'disconnected';
    /**
     * Whether Tynn actually reported a snapshot for THIS workspace. `connected`
     * only means the transport is healthy — a reconcile listing zero workspaces
     * is still a successful delivery, so without this a workspace the server has
     * never heard of looked identical to one with nothing open. Optional so an
     * older host that predates the field degrades gracefully.
     */
    knownToServer?: boolean;
}

/** Issue Watch: one feed item (issue / PR / security alert). */
export interface WatchFeedItem {
    kind: 'issue' | 'pr' | 'dependabot' | 'code-scanning' | 'secret-scanning';
    key: string;
    number: number | null;
    title: string;
    url: string;
    /** When it was OPENED on GitHub. Undefined on rows cached before Tynn stored
     *  it — the byline falls back to the updated date rather than saying nothing. */
    createdAt?: string;
    updatedAt: string;
    /** Absent on security alerts: GitHub reports no author for one, so the row
     *  omits the name rather than inventing it. */
    author?: string;
    severity?: string;
    owner: string;
    repo: string;
    /** Whether this item is from the watched repo itself or its fork-upstream —
     *  the flyout groups the feed into "This repo" and "Upstream" sections. */
    source: 'own' | 'upstream';
    unread: boolean;
}

/**
 * A GitHub-dependent Genie capability key (mirrors `CapabilityKey` in
 * main/github/capabilities.ts). The renderer gates features off these keys.
 */
export type GithubCapabilityKey =
    | 'issue-watch.issues'
    | 'issue-watch.pulls'
    | 'issue-watch.dependabot'
    | 'issue-watch.code-scanning'
    | 'issue-watch.secret-scanning'
    | 'github.provision';

/** A GitHub App permission name Genie depends on (mirrors `GhPermission`). */
export type GithubPermission =
    | 'metadata'
    | 'issues'
    | 'pull_requests'
    | 'vulnerability_alerts'
    | 'security_events'
    | 'secret_scanning_alerts'
    | 'contents'
    | 'administration';

/** The access level a permission is granted/required at (mirrors `GhAccess`). */
export type GithubAccess = 'read' | 'write' | 'admin';

/**
 * One installation missing a permission, with the deep-link to ITS own review
 * page (mirrors `MissingInstallation` in capability-service.ts). GitHub has no
 * bulk-approve, so the resolve flow lists each one with its own link.
 */
export interface GithubMissingInstallation {
    login: string;
    installationId: number | null;
    isOrg: boolean;
    reviewUrl: string;
}

/**
 * Per missing permission, the installations not granting it (mirrors
 * `MissingPermissionGroup`). Drives the resolve flow's per-install list.
 */
export interface GithubMissingPermissionGroup {
    permission: GithubPermission;
    access: GithubAccess;
    installations: GithubMissingInstallation[];
}

/**
 * The GitHub capability status (mirrors `GithubCapabilities` in
 * main/github/capability-service.ts). `connected:false` ⇒ no token; the gate is
 * inert and features use their normal not-connected handling. `missing` is the
 * set of capabilities the installed App's granted permissions don't cover —
 * those are gated OFF and surfaced via the resolve modal + header warning.
 */
export interface GithubCapabilities {
    connected: boolean;
    satisfiedFeatures: GithubCapabilityKey[];
    missing: GithubCapabilityKey[];
    missingPermissions: GithubPermission[];
    /**
     * Per missing permission, the SPECIFIC installations not granting it (each
     * with a deep-link to its own review page). The resolve flow lists these so
     * the user knows which installs to approve (no GitHub bulk-approve). Empty
     * while disconnected / before the first check.
     */
    missingByPermission: GithubMissingPermissionGroup[];
    /**
     * Deep-link to the App's permission-settings page, where the App OWNER adds
     * a missing permission (the real first step — until they do, there's nothing
     * pending for any install to approve).
     */
    appPermissionsUrl: string;
    checked: boolean;
}

export interface Settings {
    primary_workspace?: string;
    /** Last-activated workspace id in the master view. */
    active_workspace?: string;
    /** Collapsed sidebar workspace rows — JSON-encoded string[] of workspace
     *  ids. Persists the expand/collapse state across restarts. */
    collapsed_workspaces?: string;
    default_env_file?: string;
    global_hotkey?: string;
    /** Terminal-scoped hotkeys (Tynn #246/#247) — NOT OS-wide: they bind only
     *  while a Genie terminal panel has focus. */
    ftq_nudge_hotkey?: string;
    command_window_hotkey?: string;
    /** Command Window prompt library — JSON array of {id,label,text}. */
    saved_prompts?: string;
    tynn_host?: string;
    notifications_muted?: string;
    auto_update?: 'on' | 'off';
    /** Default shell id ('git-bash' | 'pwsh' | … | 'custom'). Empty = auto-detect. */
    terminal_shell?: string;
    /** Manual executable line, used when terminal_shell === 'custom'. */
    terminal_custom_cmd?: string;
    /** Max panels visible at once per workspace. String-encoded; default '4'. */
    max_views?: string;
    /** WORKSTATION DEFAULT for how many agent terminals one workspace may run at
     *  once (Tynn #117). String-encoded; `'unlimited'` turns the cap off, empty
     *  falls back to the built-in default. A workspace may override it via
     *  `workspaces.setMaxAgentTerminals`. Only a person writes either. */
    max_agent_terminals?: string;
    /** Per-workspace draggable-grid track sizes, JSON-encoded. Keyed per window
     *  (`${connKey}|${workspaceId}|${signature}`). */
    layout_json?: string;
    /** CLIENT-LOCAL panel view state (visible set, focus, maximize, layout) per
     *  `${connKey}|${workspaceId}`, JSON-encoded. Local-only (never bridged to a
     *  host). See `renderer/lib/view-state.ts`. */
    view_state_json?: string;
    /** Tier 3: keep terminals running in a detached host so they survive a full
     *  quit. Defaults 'off' (in-process). 'on' opts in. */
    detached_terminals?: 'on' | 'off';
    /** Whether Genie launches minimized to the tray (default 'off' = start open). */
    start_minimized?: 'on' | 'off';
    /** Play a chime when an agent calls imDone. Defaults 'off'. */
    notify_sound?: 'on' | 'off';
    /** Show an OS notification (tray popup) when an agent calls imDone.
     *  Defaults 'off'. */
    notify_toast?: 'on' | 'off';
    /** Which sound the imDone alert plays (gated by notify_sound): 'synth' (the
     *  built-in chime, default), a bundled wav ('3tootpipe' | 'dingdongdoink'),
     *  'custom' (sound_imdone_custom file), or 'off'. */
    sound_imdone?: 'off' | 'synth' | '3tootpipe' | 'dingdongdoink' | 'sparkle' | 'triumphant' | 'winddown' | 'custom';
    /** Absolute path to the custom imDone sound (used when sound_imdone === 'custom'). */
    sound_imdone_custom?: string;
    /** Which sound the ForceTheQuestion alert plays. Same value set as
     *  sound_imdone; default 'synth'. */
    sound_forcequestion?: 'off' | 'synth' | '3tootpipe' | 'dingdongdoink' | 'sparkle' | 'triumphant' | 'winddown' | 'custom';
    /** Absolute path to the custom ForceTheQuestion sound (used when
     *  sound_forcequestion === 'custom'). */
    sound_forcequestion_custom?: string;
    /** ForceTheQuestion AVAILABILITY (client-side). 'available' (default) pops the
     *  always-on-top modal now; 'dnd' suppresses the popup + chime and diverts the
     *  question to the top-bar inbox to answer at leisure. This is the GLOBAL
     *  default; per-workspace / per-workstation overrides live in the JSON maps
     *  below (most-specific wins). See main/ask/availability.ts. */
    ftq_availability?: 'available' | 'dnd';
    /** Per-workspace availability overrides — JSON `{ [workspaceId]: 'available'|'dnd' }`. */
    ftq_availability_workspaces?: string;
    /** Per-workstation (remote host) availability overrides — JSON
     *  `{ [workstationId]: 'available'|'dnd' }`. */
    ftq_availability_workstations?: string;
    /** The reply an agent gets when the user is in DND, so it can hold or proceed.
     *  Empty = the built-in default sentence (see main/ask/availability.ts). */
    ftq_dnd_message?: string;
    /** Still play the ForceTheQuestion chime while in DND (no modal / focus steal).
     *  Default 'off'. */
    ftq_dnd_sound?: 'on' | 'off';
    /** Fixed loopback port for the agent-integration MCP server. String-encoded;
     *  default '51717'. Changing it requires restarting the MCP server. */
    mcp_port?: string;
    /** Phone web UI (mobile) server. Opt-in: 'off' (default) | 'on'. */
    mobile_enabled?: 'on' | 'off';
    /** Desktop Genie Remote — allow another Genie in Remote mode to drive this host.
     *  Opt-in: 'off' (default) | 'on'. Independent of `mobile_enabled`: either can be
     *  on alone; the host server binds while either is on. */
    remote_enabled?: 'on' | 'off';
    remote_network_local?: 'on' | 'off';
    remote_network_lan?: 'on' | 'off';
    remote_network_tailscale?: 'on' | 'off';
    remote_network_tynn?: 'on' | 'off';
    /** Fixed port for the mobile server (bound on the Tailscale IP). String-
     *  encoded; default '51718'. Changing it requires restarting the server. */
    mobile_port?: string;
    /** The Genie Browser — Genie's own built-in browser for `.gen` dev sites
     *  (#232). Default 'on'; 'off' means Genie never opens one, and a `.gen`
     *  site opens nowhere. Workstation-level, alongside the hosting runtime. */
    genie_browser_enabled?: 'on' | 'off';
    /** Keep the Genie endpoint synced into each workspace's Claude `.mcp.json`.
     *  Default 'on'; 'off' leaves that file alone. */
    mcp_sync_claude?: 'on' | 'off';
    /** Keep it synced into Cursor `.cursor/mcp.json`. Default 'on'. */
    mcp_sync_cursor?: 'on' | 'off';
    /** Inject workspace-scoped MCP config into Codex Agent Terminal launches. */
    mcp_sync_codex?: 'on' | 'off';
    /** Keep the Genie brief synced into AGENTS.md. Default 'on'. */
    mcp_sync_agents?: 'on' | 'off';
    /** Terminal copy/paste behaviour: 'contextmenu' (default) | 'linux'
     *  (highlight-to-copy, right/middle-click paste) | 'winmac' (Ctrl/Cmd+C / +V). */
    terminal_copy_paste?: 'contextmenu' | 'linux' | 'winmac';
    /** Ai.System — instruction set injected into every workspace's AGENTS.md
     *  (inside the Genie Protocol block). Capped at 2000 chars. Default ''. */
    ai_system?: string;
    /** Split Add-Terminal button: the last terminal type the user created
     *  (`regular` | `claude` | `codex` | `custom`). Drives the main button's
     *  default action. RUNTIME-owned — written by the master as terminals are
     *  created, never by the Settings UI. Default 'regular'. */
    last_terminal_type?: string;
    /** The MACHINE's default version per language, JSON `{"php":"8.3.33",…}`.
     *  Only Genie-managed installs may be named. RUNTIME-owned: written by the
     *  Toolchain page's `toolchain:set-default` ipc, never by the Settings form's
     *  whole-object Save (which would carry a stale default back). */
    toolchain_defaults?: string;
    /** Specialized terminals: the launch command for a Claude Code agent
     *  (resolved server-side; blank = the built-in default `claude`). */
    agent_command_claude?: string;
    /** Specialized terminals: the launch command for a Codex agent (blank =
     *  the built-in default). */
    agent_command_codex?: string;
    /** Specialized terminals: the launch command for a Custom agent — no
     *  built-in default, so a per-terminal command is required when blank. */
    agent_command_custom?: string;
    /** Specialized terminals: always-on launch flags for a Claude Code agent —
     *  appended after the command, before Genie's `--session-id` (e.g.
     *  `--dangerously-skip-permissions`). Blank = none. */
    agent_flags_claude?: string;
    /** Specialized terminals: always-on launch flags for a Codex agent. */
    agent_flags_codex?: string;
    /** Specialized terminals: always-on launch flags for a Custom agent. */
    agent_flags_custom?: string;
    /** GApp AI Provider (genie#245): which AI TUI a Genie App's DECLARED agents run
     *  as — `claude` | `codex` | `custom`, or '' to follow `agent_default`. The
     *  user's choice per WORKSTATION, never the app's: it is spending this
     *  machine's compute and this user's subscription. HOST-SOURCED — the host is
     *  what launches the TUI. */
    gapp_ai_provider?: string;
    /** Workstation Setup: the owner's chosen DEFAULT agent id (claude/codex/custom).
     *  Written by the setup wizard; lets a re-run pre-fill and a future picker pick
     *  a default. HOST-SOURCED — it describes the host's agent environment. */
    agent_default?: string;
    /** Workstation Setup: the enabled-agent ids as a JSON string array. Written by
     *  the setup wizard; HOST-SOURCED (mirrors `agent_default`). */
    agent_enabled?: string;
}

/** Health of a workspace's agent docs (AGENTS.md + Genie section + CLAUDE sync). */
export interface WorkspaceDocHealth {
    hasAgents: boolean;
    hasGenieSection: boolean;
    /** missing | symlink | broken-pointer | mirror | divergent */
    claude: string;
    claudeDivergent: boolean;
    healthy: boolean;
}

/** Result of a re-runnable workspace-doc repair pass. */
export interface RepairDocsResult {
    health: WorkspaceDocHealth;
    actions: string[];
    claudeDivergent: boolean;
    backedUpTo?: string;
}

/** Live state of the agent-integration MCP server (Settings → Agent MCP). */
export interface McpServerState {
    running: boolean;
    /** The port actually bound (null when not running). */
    port: number | null;
    /** The port the user configured (what the server tries to bind). */
    configuredPort: number;
    /** True when the configured port was taken and the server fell back. */
    conflict: boolean;
}

/**
 * The MCP server-push (SSE GET stream) measurement. The probe's whole purpose:
 * `streamsOpened > 0` ⇒ a real client opens the stream; `streamsWithSession`/
 * `sessionsCorrelated > 0` ⇒ it echoes Mcp-Session-Id (per-agent routing is
 * live); `pushesReached` ⇒ pushes actually landed on an open stream.
 */
export interface ServerPushDiagnostics {
    open: number;
    streamsOpened: number;
    streamsWithSession: number;
    pushesSent: number;
    pushesReached: number;
    sessionsCorrelated: number;
}

/**
 * Live state of the mobile remote-control server (Settings → Mobile), bundled
 * with the pairing PIN + a QR data-URL of the pairing link. The phone NEVER sees
 * this — it's the desktop Settings view's status. `url` is the tailnet phone URL
 * `http://<ip>:<port>/m/` (null when not bound); `tailnetNotDetected` is true
 * when the server is enabled but no Tailscale interface was found (fail closed);
 * `conflict` is true when the configured port was taken (no silent fallback);
 * `locked` reflects the global kill-switch.
 */
/** One paired device in the host-side Devices roster (no bearer token). */
export interface MobileDevice {
    /** Stable, non-secret roster id (used to revoke this one device). */
    id: string;
    /** Short human label derived from the device's User-Agent. */
    label: string;
    /** The tailnet IP it paired from ('' if unknown / pre-upgrade). */
    ip: string;
    /** When it paired (epoch ms). */
    createdAt: number;
}

export interface MobileStatus {
    running: boolean;
    /** True when the host server is bound (either the phone UI or desktop remote is on). */
    enabled: boolean;
    /** True when the phone web UI (`/m`) is being served. */
    mobileUiEnabled: boolean;
    /** True when desktop Genie Remote connections are allowed (independent of the phone UI). */
    remoteEnabled: boolean;
    /** The bound Tailscale IPv4 (null when not running). */
    ip: string | null;
    /** The bound port (null when not running). */
    port: number | null;
    /** The port the user configured. */
    configuredPort: number;
    /** The phone URL `http://<ip>:<port>/m/`, or null when not running. */
    url: string | null;
    /** True when the configured port was taken (restart on a free port to fix). */
    conflict: boolean;
    /** True when enabled but no Tailscale interface was detected (fail closed). */
    tailnetNotDetected: boolean;
    listeners: Array<{
        network: 'local' | 'lan' | 'tailscale';
        ip: string;
        port: number;
        secure: boolean;
    }>;
    /** True when the DESKTOP holds the baton (the kill-switch, as it always read). */
    locked: boolean;
    /** Everyone who can drive right now + their emoji (the connected-users list). */
    participants: BatonParticipant[];
    /** The desktop's own view of the baton — who is driving, with which emoji. */
    control: ControlView;
    /** The 6-digit pairing PIN (shown big + in the QR). */
    pin: string;
    /** A data-URL PNG QR of `<url>?pair=<pin>`, or null when not bound. */
    qrDataUrl: string | null;
    /** Remotes currently connected (drives the host's "remote session" overlay). */
    peers: MobilePeer[];
    /** win32 only: server is listening but no inbound Windows Firewall rule for the
     *  live port exists — a paired phone can't connect until it's allowed. Always
     *  false on non-win32 / when a matching rule is present. */
    needsFirewallRule: boolean;
    /** True when served over browser-trusted HTTPS (a Tailscale cert was issued);
     *  false = http-over-WireGuard (still encrypted — the fail-open fallback). */
    secure: boolean;
}

/** A remote/phone currently connected to THIS host. */
export interface MobilePeer {
    ip: string;
    since: number;
    /** The baton principal id (session id, or the Tynn user id when identified). */
    id: string;
    /** Display name for the connected-users list. */
    name: string;
    /** The user's attribution emoji — what their actions are signed with. */
    emoji: string;
    /** True for the one user currently driving. */
    holdsControl: boolean;
}

/** One row of the connected-users list (everyone who could drive). */
export interface BatonParticipant {
    id: string;
    name: string;
    emoji: string;
    /** Owners may TAKE the baton; everyone else can only be GIVEN it. */
    isOwner: boolean;
    holdsControl: boolean;
}

/** Who holds the HOST's baton, as a remote driver window sees it. */
export interface RemoteControlState {
    /** True when SOMEBODY ELSE is driving and this window is view-only. */
    locked: boolean;
    /** The holder's attribution emoji (null when free / an older host). */
    holderEmoji?: string | null;
    /** The holder's display name (null when free / an older host). */
    holderName?: string | null;
}

/** Who holds the baton, as one client sees it. */
export interface ControlView {
    /** True when SOMEONE ELSE is driving and this client is view-only. */
    locked: boolean;
    holder: string | null;
    holderEmoji: string | null;
    /** This client's own principal id. */
    you: string | null;
    participants: BatonParticipant[];
}

/** A peer node on the tailnet (from `tailscale status`). */
export interface TailnetPeer {
    hostname: string;
    ip: string | null;
    online: boolean;
    os: string;
}

/** Tailscale lifecycle status for the Work Mode settings (mirrors main/tailscale). */
export interface TailscaleStatus {
    installed: boolean;
    running: boolean;
    self: { ip: string | null; hostname: string; online: boolean } | null;
    peers: TailnetPeer[];
    authUrl?: string | null;
}

/** A Genie host discovered on the tailnet (Work Mode remote). */
export interface GenieHost {
    hostname: string;
    peerName: string;
    ip: string;
    port: number;
    /** Stable per-install identity (from the beacon); absent for an old host. */
    hostId?: string;
    /** MagicDNS dial address advertised by the beacon. */
    dnsName?: string;
    /** `host:<hostId>` once identified, else `ip:port` — the merge/connect key. */
    connKey: string;
}

/** One enabled `.gen` tunnel site shown in the Testing Browser chrome. */
export interface TestingBrowserSite {
    genName: string;
    hostname: string;
    scheme: string;
    port: number;
}

/** One Testing Browser tab (the site content is a main-owned WebContentsView). */
export interface TestingBrowserTab {
    id: string;
    url: string;
    title: string;
}

/** The Testing Browser chrome's render state (serve-local-sites Phase D). Mirrors
 *  `chromeState` in main/testing-browser/index.ts. */
export interface TestingBrowserState {
    connKey: string;
    hostname: string;
    tabs: TestingBrowserTab[];
    activeTabId: string | null;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    presetId: string;
    presets: Array<{ id: string; label: string }>;
    sites: TestingBrowserSite[];
}

/** The host this Genie is driving in remote mode (no token — main holds that). */
export interface RemoteHost {
    ip: string;
    port: number;
    hostname: string;
    /** Stable per-install identity (survives IP changes); absent for an old host. */
    hostId?: string;
    /** MagicDNS dial address. */
    dnsName?: string;
}

/** Remote-mode status surfaced to the renderer (titlebar indicator + bridge). */
export interface RemoteStatus {
    connected: boolean;
    host: RemoteHost | null;
}

/**
 * Bridge link health for a host window — drives the upgrade/limbo overlay:
 *   - connected     — versions match, normal operation,
 *   - mismatch      — incompatible bridge protocol (direction → upgrade host vs
 *                     update this Genie),
 *   - reconnecting  — host dropped / upgrading; overlay + auto-reconnect,
 *   - lost          — host didn't return within the limbo timeout (manual retry).
 */
export interface RemoteLinkState {
    phase: 'connected' | 'mismatch' | 'reconnecting' | 'lost';
    direction?: 'host-behind' | 'client-behind';
    hostVersion?: number;
    localVersion?: number;
    reason?: 'upgrade' | 'dropped';
    /** Soft, non-blocking nudge (phase 'connected' only): host is on an older
     *  RELEASE build than this client, but still wire-compatible. `hostVersion`
     *  is null when the host is provably older but reports no version. */
    hostBuildBehind?: { hostVersion: string | null; localVersion: string };
}

/** A host remembered in the Hosts picker (persisted; survives discovery gaps). */
export interface KnownHost {
    ip: string;
    port: number;
    hostname: string;
    /** User-chosen label; the UI falls back to hostname. */
    name?: string;
    /** Stable per-install identity (when known); the record is keyed by it. */
    hostId?: string;
    /** Last-seen MagicDNS dial address. */
    dnsName?: string;
    /** `host:<hostId>` once identified, else `ip:port` — the registry key. */
    connKey: string;
    /** Whether this host currently has a live connection (a host window open). */
    connected: boolean;
    /** Whether that live connection currently has terminal streams attached. */
    activeTerminals: boolean;
}

/** A Virtual Workstation the signed-in member may connect to (Hosts picker).
 *  `connectable` is true only when it's active AND the member is entitled. */
export interface ConnectableWorkstation {
    id: string;
    name: string;
    status: string;
    is_local: boolean;
    relay_endpoint: string;
    connectable: boolean;
    capability: string | null;
    scopes: string[];
    source: 'owner' | 'grant' | 'invite' | null;
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
    /**
     * Set when auto-update can't apply on this platform (macOS, where an
     * unsigned/ad-hoc build fails Squirrel.Mac signature validation). The UI
     * shows a "Download manually" button pointing here instead of a dead error.
     */
    manualDownloadUrl?: string | null;
    /**
     * Present at 'ready-to-restart' ONLY when applying would INTERRUPT live work
     * (running terminals / agent chats the restart tears down). When set, the
     * hands-free auto-apply is HELD: the pill shows an explicit "Restart & update"
     * confirm with the count, so an upgrade never silently kills a live session.
     */
    interruption?: { terminals: number; agentChats: number } | null;
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
export type ViewType = 'terminal' | 'code' | 'process' | 'plugin' | 'plugin-panel';

/** Lifecycle status of a background Process service runner. */
export type ProcessStatus =
    | 'running'
    | 'stopped'
    | 'crashed'
    | 'restarting'
    | 'failed';

/**
 * One Task Manager row: a background process plus the workspace that spawned
 * it. `workspace` is the spawning workspace's display name, or "System" for a
 * System-Workspace process (and `workspaceId` is null for those).
 */
export interface ProcessListItem {
    id: string;
    /** Discriminates a background process from an interactive terminal/pty. */
    kind: 'process' | 'terminal';
    label: string;
    command: string;
    workspace: string;
    workspaceId: string | null;
    status: ProcessStatus;
    autostart: boolean;
}

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
    /**
     * Code view: a TRANSIENT 1-based line to reveal when a freshly-created
     * editor panel mounts (openFileForUser at a line that opened a new panel).
     * Consumed + cleared by CodePanel on mount so it never re-reveals on a
     * later relaunch — it is not persisted scroll state.
     */
    reveal_line?: number;
    /** Process view: the command line run (non-interactively) by the runner. */
    command?: string;
    /** Process view: start automatically when the workspace/app opens. */
    autostart?: boolean;
    /** Process view: relaunch the command (with backoff) if it exits/crashes. */
    restart_on_exit?: boolean;
    /** Process view: persisted "was running" intent — restores the process on
     *  next launch if Genie went down while it was running (service-like). */
    was_running?: boolean;
    /** SCHEDULED TASK: a 5-field cron expression in the HOST's local time. Its
     *  presence turns a process into a scheduled task — one-shot per fire,
     *  armed by the Host so it runs with no UI attached and across restarts. */
    schedule?: string;
    /** SCHEDULED TASK: what a fire does. Default 'command'. */
    schedule_kind?: 'command' | 'agent-nudge';
    /** agent-nudge: the terminal to nudge. */
    nudge_target_terminal_id?: string;
    /** agent-nudge: the AgentInbox agent id to nudge. */
    nudge_agent_id?: string;
    /** agent-nudge: the prompt delivered on each fire. */
    nudge_prompt?: string;
    /** SCHEDULED TASK: epoch ms the last fire started. */
    last_run_at?: number;
    /** SCHEDULED TASK: how the last fire went. */
    last_run_status?: 'ok' | 'failed' | 'skipped';
    /** SCHEDULED TASK: set while an agent-armed schedule awaits approval. */
    schedule_pending_approval?: boolean;
    /** System Workspace tag (unattached spec grouped under the System Workspace). */
    system?: boolean;
    /** Plugin editor view: the owning plugin id (§6.1). */
    plugin_id?: string;
    /** Plugin editor view: the plugin's editor id from its manifest. */
    editor_id?: string;
    /** Plugin editor view: the workspace-relative file the editor is bound to. */
    file?: string;
    /** Plugin editor/panel view: the declared first-party Fancy component export. */
    fancy_export?: string;
    /** Plugin editor/panel view: the declared Fancy package + version (provenance). */
    fancy_package?: string;
    fancy_version?: string;
    /** Plugin panel view: the plugin's panel id from its manifest (`plugin-panel`). */
    panel_id?: string;
    /** Plugin panel view: the panel's display title. */
    panel_title?: string;
    /** Plugin panel view: the panel's declared icon name (from Genie's catalog). */
    panel_icon?: string;
    /** Specialized terminal: the AI-TUI kind this terminal launches (claude /
     *  codex / custom). Set on agent terminals created via terminalSpec.createAgent;
     *  absent on a plain shell. Gates the AgentInbox identity + the sidebar badge. */
    agent?: AgentType;
    /** Specialized terminal: the resolved command line the agent was launched with
     *  (informational — the launch profile / resolveAgentCommand fills this). */
    agent_command?: string;
    /** AgentInbox: this agent's channel purpose (kebab, ≤6 words; default `general`). */
    purpose?: string;
    /** AgentInbox: who can discover / DM this agent — see {@link AgentInboxScope}. */
    scope?: AgentInboxScope;
    /** AgentInbox: the chosen workspace ids when `scope === 'specific'`. */
    scope_workspaces?: string[];
    [key: string]: unknown;
}

/** The AI-TUI kind a specialized terminal launches. */
export type AgentType = 'claude' | 'codex' | 'custom';

/**
 * AgentInbox accessibility scope (INNER tier) — who may DM this agent:
 *  - `self`     — same-workspace agents only (DEFAULT),
 *  - `specific` — the workspaces the owner picks (∪ its own),
 *  - `all`      — every agent on the workstation,
 *  - `none`     — nobody, but the agent stays LISTED to peers as unreachable so
 *                 they can discover it and ask for access,
 *  - `hidden`   — nobody, and omitted from peers' discovery entirely (the true
 *                 opt-out; `none` closes the mailbox, not the door).
 * The workspace's own `agent_access` (OUTER tier) applies on top: it decides which
 * workspaces may reach this one at all. A caller must clear BOTH.
 * Channel broadcasts reach members regardless of this scope — cross-workspace
 * channel access is governed by the workspace tier.
 */
export type AgentInboxScope = 'none' | 'self' | 'specific' | 'all' | 'hidden';

/** Who may reach INTO a workspace (its channels + its agents) — the OUTER tier. */
export type WorkspaceAgentAccess = 'none' | 'self' | 'specific' | 'all';

/** A discoverable AgentInbox agent (directory row / presence payload). */
export interface AgentInboxAgentInfo {
    agentId: string;
    terminalId: string;
    workspaceId: string | null;
    workspaceName: string;
    /** The workspace slug the channel name is built from. */
    slug: string;
    /** 'claude' | 'codex' | 'custom' (or another launched TUI kind). */
    agentType: string;
    label: string;
    purpose: string;
    scope: AgentInboxScope;
    /** Redacted (empty) for a caller that cannot reach this agent. */
    scopeWorkspaces: string[];
    /** Whether the caller this row was built for may DM this agent. `false` = the
     *  "visible but unavailable" state. Always true in the human panel directory. */
    reachable: boolean;
    status: 'online' | 'away' | 'offline';
    /** The captured AI chat-session uuid, or null when not yet detected. */
    chatSessionId: string | null;
}

/** An AgentInbox broadcast channel (`slug:purpose`), keyed internally by workspace. */
export interface AgentInboxChannelInfo {
    /** Opaque internal key (`workspaceId:purpose`). */
    key: string;
    /** The workspace slug displayed in the `slug:purpose` label. */
    slug: string;
    purpose: string;
    workspaceId: string | null;
    workspaceName: string;
    memberCount: number;
}

/** An AgentInbox DM thread (a message-carrying pair) — human↔agent OR
 *  agent↔agent — as the human panel's DMs list reports it. */
export interface AgentInboxDmThreadInfo {
    /** Order-independent pair key (`idA|idB`). */
    key: string;
    /** Participant ids (either may be `'human'`). */
    a: string;
    b: string;
    /** Display labels (`You` for the human; a logged label for a departed agent). */
    aLabel: string;
    bLabel: string;
    /** True when the human is a participant (else agent↔agent). */
    withHuman: boolean;
    lastFromLabel: string;
    lastPreview: string;
    lastSeq: number;
    lastTs: number;
    count: number;
}

/** One FILE riding an AgentInbox message. Metadata only — the bytes live in the
 *  host's content-addressed store and are fetched on demand for a download. */
export interface AgentInboxAttachment {
    /** The handle used to fetch the bytes (`agentInbox.attachmentBytes`). */
    id: string;
    /** Base name as sent — never a path. */
    filename: string;
    bytes: number;
    mime: string;
    sha256: string;
}

/** One AgentInbox message (channel broadcast or 1:1 DM). */
export interface AgentInboxMessage {
    seq: number;
    id: string;
    /** Sender agentId, or `'human'` for a message posted from the panel. */
    from: string;
    fromLabel: string;
    kind: 'dm' | 'channel';
    /** Channel key when `kind === 'channel'`. */
    channel?: string;
    /** Recipient agentId when `kind === 'dm'`. */
    to?: string;
    text: string;
    ts: number;
    /** Files sent with this message. Absent when there are none. */
    attachments?: AgentInboxAttachment[];
}

/** Live presence event: a full agent snapshot, or a terse offline/left tick. */
export type AgentInboxPresenceEvent =
    | AgentInboxAgentInfo
    | { agentId: string; status: 'offline'; left: true };

/** Live message event (preview only — the full body is fetched via history). */
export interface AgentInboxMessageEvent {
    kind: 'dm' | 'channel';
    channelKey?: string;
    toAgentId?: string;
    from: string;
    fromLabel: string;
    seq: number;
    ts: number;
    preview: string;
}

/** Track C — an unACKed urgent DM escalating to the human oversight surface, or
 *  (`resolved: true`) the clearing of a previously-raised alert. */
export interface AgentInboxEscalationEvent {
    messageId: string;
    targetAgentId: string;
    targetLabel?: string;
    fromLabel?: string;
    preview?: string;
    sinceTs?: number;
    resolved?: boolean;
}

/** Result of a plugin-editor binary read (base64 payload) (§6.2). */
export interface PluginEditorReadResult {
    ok: boolean;
    value?: { base64: string; bytes: number; relPath: string };
    error?: string;
}

/** Result of a plugin-editor binary write (§6.2). */
export interface PluginEditorWriteResult {
    ok: boolean;
    value?: { relPath: string; bytes: number };
    error?: string;
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

/** A member repo of an envelope as the workspace settings window sees it. */
export interface EnvelopeRepoView {
    name: string;
    url: string | null;
    role: 'host' | 'package' | null;
    /** Checkout path inside the envelope (`repos/<name>`). */
    path: string;
    /** Present in project.json `repos[]`. */
    inRegistry: boolean;
    /** A git checkout exists at `repos/<name>` on disk. */
    onDisk: boolean;
}

export interface EnvelopeReposResult {
    /** False for a plain-folder (non-`.agi`) workspace — UI hides the section. */
    isEnvelope: boolean;
    repos: EnvelopeRepoView[];
}

/** Result of an envelope repo / knowledge mutation. */
export interface RepoMutationResult {
    ok: boolean;
    error?: string;
}

/** One `.ai/` knowledge folder's state. */
export interface KnowledgeFolderView {
    name: string;
    /** Envelope-relative path, e.g. `.ai/knowledge`. */
    relPath: string;
    exists: boolean;
    /** Entries directly inside (0 when absent; `.gitkeep` excluded). */
    entryCount: number;
}

export interface KnowledgeResult {
    isEnvelope: boolean;
    /** Whether the `.ai/` folder itself exists. */
    aiExists: boolean;
    folders: KnowledgeFolderView[];
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

// --- Plugin System (Settings → Plugins) -------------------------------------

/** One toggleable granular permission grant (§12.1). */
export interface PluginPermissionView {
    category: 'fs' | 'network' | 'genieApi';
    key: string;
    label: string;
    granted: boolean;
}

/**
 * A plugin's evaluated provenance verdict (Plugin System Phase 3). `outdated`
 * means the stored manifest predates a newer schema requirement (needs an update)
 * — distinct from a signature/tamper `untrusted`.
 */
export type PluginTrustStatus = 'trusted' | 'unsigned' | 'untrusted' | 'outdated';

/** An installed plugin as Settings → Plugins renders it. */

/* ---- Genie Apps (Tynn #250) ------------------------------------------- */

/** One capability an app DECLARED, and whether the user granted it. */
export interface AppPermissionView {
    key: string;
    label: string;
    grantDescription: string;
    risk: 'standard' | 'high';
    granted: boolean;
}

/** An installed Genie App, as the Apps panel sees it. */
export interface InstalledAppView {
    id: string;
    name: string;
    slug: string;
    version: string;
    workspaceId: string;
    installPath: string;
    scope: 'self' | 'workspaces' | 'workstation';
    workspaces: string[];
    revoked: boolean;
    /** Running from the developer's own folder, with dev tools on. */
    devMode: boolean;
    /** Where it came from. Null for an app installed before Genie recorded it. */
    source: { kind: 'folder' | 'github'; origin: string; commit?: string } | null;
    /** `https://<slug>.gen/` — where its window opens. */
    homeUrl: string;
    permissions: AppPermissionView[];
    installedAt: string;
}

/** The backup policy, at either level (Tynn #250, step 4). */
export interface AppBackupPolicy {
    enabled: boolean;
    /** Absolute host path. A shared or synced folder is the point. */
    dir: string;
    /** How many dumps to keep per app, per engine version. */
    keep: number;
}

export interface AppBackupSettingsView {
    workstation: AppBackupPolicy;
    /** Null when this app simply follows the workstation default. */
    override?: Partial<AppBackupPolicy> | null;
    resolved?: AppBackupPolicy & {
        from: { enabled: 'workstation' | 'app'; dir: 'workstation' | 'app'; keep: 'workstation' | 'app' };
        reason?: string;
    };
}

export interface AppBackupResultView {
    engine: string;
    version: string;
    ok: boolean;
    path?: string;
    bytes?: number;
    error?: string;
    pruned: string[];
}

export interface AppBackupRunView {
    ok: boolean;
    /** Set when nothing ran, with the reason. */
    skipped?: string;
    dir?: string;
    results: AppBackupResultView[];
    /** Live engines this app uses that no dump covers yet — stated, never
     *  left to be inferred from an absence. */
    notCovered: string[];
}

export interface AppActionResult {
    ok: boolean;
    error?: string;
    app?: InstalledAppView;
}

/** One runtime an app needs, and who is expected to provide it. */
export interface AppRequirementView {
    tool: string;
    version?: string;
    reason?: string;
    status: 'satisfied' | 'genie-installs' | 'user-provides';
}

export interface AppRequirementPlanView {
    items: AppRequirementView[];
    genieInstalls: AppRequirementView[];
    userProvides: AppRequirementView[];
    needsUser: boolean;
    installable: true;
}

/** Whether a tracked app has a newer version upstream. */
export type AppUpdateState = 'current' | 'update-available' | 'unknown' | 'not-tracked';

/** One capability, as the GitHub review presents it. */
export interface AppReviewCapability {
    key: string;
    label: string;
    grantDescription: string;
    risk: 'standard' | 'high';
}

/** What a person reads before installing third-party code from GitHub. */
export interface GithubInstallReview {
    origin: string;
    commit: string;
    shortCommit: string;
    ref: string;
    name: string;
    slug: string;
    version: string;
    description?: string;
    /** Every command that will RUN on this machine. No permission covers these. */
    commands: string[];
    highRisk: AppReviewCapability[];
    standard: AppReviewCapability[];
    escalations: string[];
    /** What the user must type to proceed. */
    confirmPhrase: string;
}

/**
 * One thing the check found — mirrors `main/apps/findings.ts`.
 *
 * Three fields because a check answer owes three things: WHERE to look, WHAT is
 * wrong, and WHAT TO DO. A single sentence is what the panel used to render, and it
 * routinely left out the third.
 */
export interface AppFinding {
    /** Stable id, e.g. `agents.persona-missing`. */
    check: string;
    /** `error` — it will not work. `advice` — it will, and think about it anyway. */
    severity: 'error' | 'advice';
    where: string;
    problem: string;
    fix: string;
}

/** The result of checking a folder without installing it. */
export interface AppCheckReport {
    ok: boolean;
    /** Errors first, then advice. */
    findings: AppFinding[];
    /** Which checks were evaluated — so a clean report says what it covered. */
    ran: string[];
    app?: { id: string; slug: string; name: string; version: string; description?: string };
}

export interface AppInstallResult {
    ok: boolean;
    appId?: string;
    workspaceId?: string;
    homeUrl?: string;
    errors?: string[];
    /** Installed, but something did not come UP. Not the same as a failed install. */
    warnings?: string[];
    userProvides?: AppRequirementView[];
}

/**
 * What opening a preview produced.
 *
 * Same shape as an install's result and read the same way, with the same split
 * between `errors` (it did not open, and nothing was created) and `warnings` (it
 * opened, and something in it did not come up — a site with no hosting stack
 * behind it, background services a preview deliberately does not start).
 */
export interface AppPreviewResult {
    ok: boolean;
    /** The PREVIEW's app id — never the app's own. */
    appId?: string;
    workspaceId?: string;
    /** `https://<slug>.preview.gen/` — its own address, not the installed one's. */
    homeUrl?: string;
    errors?: string[];
    warnings?: string[];
}

/** A preview that is open right now. */
export interface AppPreviewView {
    appId: string;
    name: string;
    /** The developer's folder — a preview runs on live source, never a copy. */
    folder: string;
    homeUrl: string;
    warnings: string[];
}

export interface InstalledPluginView {
    id: string;
    name: string;
    version: string;
    namespace: string;
    description: string | null;
    enabled: boolean;
    sourceType: 'repo' | 'folder' | 'marketplace';
    sourceUrl: string | null;
    marketplaceId: string | null;
    publisher: string | null;
    tools: Array<{ name: string; description: string }>;
    editors: Array<{ id: string; title: string; extensions: string[]; fancyEditor: string }>;
    /** Declared workspace-panel → Fancy component mappings (vetted-Fancy-only). */
    panels: Array<{ id: string; title: string; icon?: string; fancyComponent: string }>;
    /**
     * WHERE this plugin's surfaces run. `client` = editors + panels (rendered in
     * whichever Genie window opens them); `host` = MCP tools / recipes (code that
     * runs on this machine). Only host surfaces need enabling + permissions here.
     */
    sides: { client: boolean; host: boolean };
    permissions: PluginPermissionView[];
    integrity: string | null;
    signed: boolean;
    /** Trust verdict: trusted / unsigned / untrusted (Phase 3). */
    trust: PluginTrustStatus;
    publisherKeyId: string | null;
    devApproved: boolean;
}

/**
 * A plugin-contributed recipe as delivered to the WizardModal launcher — the
 * SERIALIZABLE recipe manifest (form/choice/terminal/browser steps) plus its
 * origin. The renderer reconstitutes it into a runtime Recipe (see
 * lib/recipes/plugin.ts) before running it.
 */
export interface PluginRecipeStepView {
    type: 'form' | 'choice' | 'terminal' | 'browser';
    id: string;
    title: string;
    fields?: Array<{
        key: string;
        label: string;
        type?: 'text' | 'password' | 'number' | 'select';
        placeholder?: string;
        description?: string;
        required?: boolean;
        options?: Array<{ value: string; label: string; description?: string }>;
        defaultValue?: string;
    }>;
    options?: Array<{ value: string; label: string; description?: string }>;
    multi?: boolean;
    command?: string;
    args?: string[];
    cwd?: string;
    until?: { pattern?: string; exit?: number };
    capture?: string;
    url?: string;
    pollMs?: number;
}

export interface PluginRecipeView {
    pluginId: string;
    pluginName: string;
    namespace: string;
    /** Namespaced, collision-free launch id: `${namespace}.${recipe.id}`. */
    launchId: string;
    recipe: { id: string; title: string; steps: PluginRecipeStepView[] };
}

/**
 * A plugin-contributed workspace PANEL as delivered to the Add-view launcher.
 * The renderer mounts the declared Fancy component through its compile-time
 * adapter registry (keyed by `fancyComponent.export`) — never a dynamic import.
 */
export interface PluginPanelView {
    pluginId: string;
    pluginName: string;
    namespace: string;
    /** Namespaced, collision-free launch id: `${namespace}.${panel.id}`. */
    launchId: string;
    panel: {
        id: string;
        title: string;
        icon?: string;
        fancyComponent: { package: string; version: string; export: string };
        placement?: 'grid' | 'workspace';
    };
}

// --- Repository panel (host-side git ops) -----------------------------------

/** A discriminated result from a `repo:*` op (host git binding). */
export type RepoResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** One selectable repo in the panel's repo picker (root + each member repo). */
export interface RepoRef {
    /** Workspace-relative folder ('' = the workspace root itself). */
    rel: string;
    name: string;
}

export type RepoChangeLabel =
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'copied'
    | 'typechange'
    | 'untracked'
    | 'conflicted';

/** One changed file, split across the staged (index) and unstaged (worktree) sides. */
export interface RepoChange {
    path: string;
    index: string;
    worktree: string;
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
    label: RepoChangeLabel;
}

/** The panel's view model for one repo: branch header + changed files. */
export interface RepoStatus {
    branch: string | null;
    upstream: string | null;
    ahead: number;
    behind: number;
    detached: boolean;
    changes: RepoChange[];
}

/** Developer Mode state + the user's developer-trusted signing keys. */
export interface PluginDeveloperModeState {
    enabled: boolean;
    keys: Array<{ keyId: string; label: string }>;
}

/**
 * A member entry a marketplace index listed that Genie cannot install, and why —
 * shown in Settings so a plugin that never appears is explained, not just absent.
 */
export interface MarketplaceIssue {
    at: string;
    id: string | null;
    name: string | null;
    errors: string[];
}

/** A 3rd-party marketplace + its indexed member plugins. */
export interface MarketplaceView {
    id: string;
    name: string;
    url: string;
    official: boolean;
    /** ISO timestamp of the last successful index read — how old this list is. */
    checkedAt: string;
    plugins: Array<{ id: string; name: string; description: string | null; installed: boolean }>;
    issues: MarketplaceIssue[];
}

/** The outcome of re-reading one marketplace index. */
export interface MarketplaceRefreshReport {
    id: string;
    name: string;
    ok: boolean;
    error?: string;
    rejected?: MarketplaceIssue[];
}

export interface OfficialPluginEntry {
    id: string;
    name: string;
    description: string;
    repo: string;
}

/** A bundled first-party plugin Genie ships in the box (Hello World / Presentation / Spreadsheet). */
export interface BundledPlugin {
    id: string;
    name: string;
    description: string;
    path: string;
}

export interface OfficialPluginsResult {
    curated: OfficialPluginEntry[];
    bundled: BundledPlugin[];
}

export type PluginActionResult<T = { id: string; name: string; version: string }> =
    | { ok: true; value: T }
    | { ok: false; error: string };

// --- Workstation Knowledge Graph (Wish #87) --------------------------------
// A workstation-wide, local knowledge/memory store the Knowledge Graph window
// reads/writes over `knowledge.*`. Each node is a markdown memory; the
// `[[wikilink]]` refs between memories are the graph's edges. DISTINCT from the
// envelope `.ai/` KnowledgeFolderView/KnowledgeResult above — those are one
// workspace's on-disk knowledge FOLDERS; this is the cross-workspace memory
// STORE that replaces bloated system-wide agent prompt instructions.

/** One memory in the Knowledge Graph store. */
export interface KnowledgeNode {
    id: string;
    title: string;
    /** The memory body, as markdown. */
    body: string;
    tags: string[];
    /** Ids of the memories this one links to — its out-edges. Resolved main-side
     *  from the body's `[[wikilinks]]` (by title/slug, at read time) PLUS any
     *  explicit links passed to add/update. */
    links: string[];
    /** Who wrote it: an agent (RAG/MCP) or the user (this window). */
    source: 'agent' | 'user';
    /** Epoch ms. */
    createdAt: number;
    updatedAt: number;
}

/** One `knowledge.search` hit — a lightweight node projection + match snippet. */
export interface KnowledgeSearchResult {
    id: string;
    title: string;
    /** A short excerpt around the match, for the results list. */
    snippet: string;
    /** Relevance score (higher = better). The result ORDER is authoritative. */
    score: number;
    tags: string[];
}

/** A directed edge: `source` (the memory containing the link) → `target` (the
 *  linked memory's id). Only edges whose BOTH ends resolve to real nodes appear. */
export interface KnowledgeGraphEdge {
    source: string;
    target: string;
}

/** The whole store as a graph: the full nodes + the edges between them. */
export interface KnowledgeGraphData {
    nodes: KnowledgeNode[];
    edges: KnowledgeGraphEdge[];
}

/**
 * Fields accepted when creating / updating a memory. Only `title` is required;
 * edges are derived main-side from the body's `[[wikilinks]]`, so `links` is
 * reserved for EXPLICIT extra edges (ids/titles/slugs) — this window omits it,
 * letting the body be the single source of truth for links.
 */
export interface KnowledgeInput {
    title: string;
    body?: string;
    tags?: string[];
    links?: string[];
}

/** What the Host reports for one scheduled task, for display only. The HOST owns
 *  the cron evaluator; the renderer never parses or evaluates an expression. */
export interface ScheduleInfo {
    /** Epoch ms of the armed next occurrence; null when the task isn't armed
     *  (disabled, awaiting approval, or an expression that can never fire). */
    nextAt: number | null;
    /** Human rendering of the expression, e.g. "Daily at 03:00". */
    description: string;
}

export interface GenieApi {
    auth: {
        startSignIn: (kind?: BackendKind) => Promise<{
            ok: boolean;
            message?: string;
            /** The Tynn sign-in URL. Shown for manual copy when there is no
             *  local browser (open it on any device → sign in → paste code). */
            url?: string;
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
        counts: () => Promise<Record<string, WatchTypeCounts>>;
        /** Why this workspace's feed is what it is (connected + worst read error). */
        status: (workspaceId: string) => Promise<WorkspaceWatchStatus>;
    };
    /**
     * Reading + opening this machine's `.gen` dev sites. HOST-SOURCED content in
     * a remote window: the sites belong to the machine the window represents, so
     * these route through the bridge to the host (remote-bridge.ts), like the
     * IssueWatch rail. There is no write here — a `.gen` site is CREATED by the
     * Dev Server (`devServer.site`), never configured from a discovered host.
     */
    sites: {
        /** The header `.gen` popover's data, CONTEXTUAL to this window: a local
         *  window's own sites, or a host window's host sites. */
        all: () => Promise<GenSitesAll>;
        /** Open a `.gen` site in the Testing Browser (contextual: local loopback
         *  or the host's tunnel, by which window asked). */
        open: (genName: string) => Promise<{ ok: boolean; error?: string }>;
    };
    /**
     * The container DEV SERVER (#234) — what makes a `.gen` site exist at all.
     * Driven by the Workspace Site Manager and the Workstation Dev Server
     * settings; `sites` above only READS and OPENS what this created.
     *
     * TWO calls, mirroring the `manageSite` / `manageService` MCP tools: main
     * runs literally the same function for an agent and for this, so the human
     * surface can never drift from the agent one.
     *
     * LOCAL-ONLY for now: unlike `sites` these do NOT route to a host in a
     * remote window, so the Site Manager is offered on a local Floor only (see
     * `isRemoteWindow`). Host-sourcing them needs `/api/dev-server/*` on the
     * host — P5.
     */
    devServer: {
        /** Drive one workspace's SITES. */
        site: (workspaceId: string, req: ManageSiteRequest) => Promise<ManageSiteResult>;
        /** Drive one workspace's SERVICES. `catalog` answers with an empty
         *  workspace id, so the picker can offer engines before any exist. */
        service: (workspaceId: string, req: ManageServiceRequest) => Promise<ManageServiceResult>;
        /** Which container runtime is driving, or why none is. Never downloads. */
        runtimeStatus: () => Promise<DevRuntimeInfo>;
        /** First-run toolchain setup (#240): inspect what dev tools THIS machine
         *  has, the managers that could install the rest, the plan, and the
         *  consent object. Inspecting installs nothing; pass a package-manager
         *  choice to re-plan with it. */
        toolchainInspect: (pmChoice?: string) => Promise<ToolchainInspection>;
        /** Run the reviewed install plan (main runs its own plan; the package-
         *  manager choice is the only lever). Per-tool progress arrives on
         *  `on.toolchainProgress`. */
        toolchainInstall: (pmChoice?: string) => Promise<ToolchainInstallResult>;
        /** Toolchain Manager (#242): scan installed tools for available updates.
         *  A pure read — queries `<pm> outdated` but installs nothing. CACHED:
         *  a fresh answer is reused so opening the page twice is not two scans;
         *  pass `force` for an explicit Refresh. */
        toolchainUpdates: (force?: boolean) => Promise<ToolUpdate[]>;
        /** Toolchain Manager (#242 P2): update ONE installed tool to latest. Main
         *  validates the tool + builds the command. Progress on `on.toolchainProgress`.
         *  Main REFUSES (or asks) when the update would walk into live work —
         *  replacing an agent TUI mid-turn, or restarting Docker under running
         *  containers; pass `confirmed` to accept a `warn`. */
        toolchainUpdate: (tool: HostToolName, confirmed?: boolean) => Promise<ToolchainInstallResult>;
        /** The Toolchain page: every language version on this machine, the
         *  machine defaults, what this release could still install, and the
         *  sites that consume each language. A pure read — it lists directories
         *  and never downloads. */
        toolchainInstalls: (force?: boolean) => Promise<ToolchainInstallsInfo>;
        /** Make a GENIE-managed version the machine default. Sites that pinned
         *  nothing follow it, and change on their next start. */
        toolchainSetDefault: (
            tool: LanguageTool,
            version: string,
        ) => Promise<ToolchainVersionResult>;
        /** Install one version this release has a recipe for. */
        toolchainAddVersion: (
            tool: LanguageTool,
            version: string,
        ) => Promise<ToolchainVersionResult>;
        /** Delete a version GENIE installed. Refused for anyone else's — the
         *  result says which installer owns it. */
        toolchainRemoveVersion: (
            tool: LanguageTool,
            version: string,
        ) => Promise<ToolchainVersionResult>;
        /** The MACHINE's Dev Server: the runtime, the dev base image's
         *  toolchains, and every shared service engine with its holders. A pure
         *  read — opening it never pulls or starts anything. */
        workstation: () => Promise<DevWorkstationInfo>;
        /** Machine-level start | stop | logs for ONE shared engine. Machine-level
         *  because the engine is: one container, many workspaces. */
        engine: (req: DevEngineActionRequest) => Promise<DevEngineActionResult>;
        /** The repo subfolders a site can be created against. */
        repos: (workspaceId: string) => Promise<string[]>;
    };
    mcp: {
        status: () => Promise<McpServerState>;
        restart: () => Promise<McpServerState>;
        docHealth: (workspaceId: string) => Promise<WorkspaceDocHealth | null>;
        repairDocs: (workspaceId: string) => Promise<RepairDocsResult | null>;
        /** Server-push (SSE GET stream) measurement — did a real client open the
         *  stream, echo an Mcp-Session-Id, and receive a pushed notification. */
        pushStatus: () => Promise<ServerPushDiagnostics>;
    };
    /** Plugin System (Settings → Plugins). Install from a repo URL / folder /
     *  marketplace; enable/disable; toggle granular permissions; uninstall. */
    /**
     * Genie Apps — the MANAGEMENT surface, for Genie's own UI. An installed app
     * never sees this: what a GApp gets is the two-call bridge in its own
     * sandboxed window, with none of this on it.
     */
    apps: {
        list: () => Promise<InstalledAppView[]>;
        get: (appId: string) => Promise<InstalledAppView | null>;
        requirements: (appId: string) => Promise<AppRequirementPlanView | null>;
        checkUpdates: () => Promise<Record<string, AppUpdateState>>;
        installFolder: (folder?: string, devMode?: boolean) => Promise<AppInstallResult>;
        checkFolder: (folder?: string) => Promise<AppCheckReport>;
        /**
         * Open a folder in a REAL GApp window without installing it.
         *
         * Same window, same tab strip, same Agent tab with the panels the manifest
         * declared, same isolation — at its own address and in its own storage
         * partition, so it can never touch an installed copy. Closing the window
         * is the whole cleanup.
         */
        previewFolder: (folder?: string) => Promise<AppPreviewResult>;
        /** What is being previewed right now. */
        previews: () => Promise<AppPreviewView[]>;
        closePreview: (appId: string) => Promise<{ ok: boolean }>;
        scaffold: (req: { name: string; id?: string; parent?: string }) => Promise<{
            ok: boolean;
            folder?: string;
            error?: string;
        }>;
        /** The GApp WINDOW's own bridge — what this window is, and which tab shows. */
        reviewGithub: (
            url: string,
            ref?: string,
        ) => Promise<{ ok: true; review: GithubInstallReview } | { ok: false; error: string }>;
        installGithub: (commit: string, typed: string) => Promise<AppInstallResult>;
        discardGithub: (commit: string) => Promise<{ ok: boolean }>;
        open: (appId: string) => Promise<AppActionResult>;
        setCapabilities: (appId: string, capabilities: string[]) => Promise<AppActionResult>;
        setRevoked: (appId: string, revoked: boolean) => Promise<AppActionResult>;
        uninstall: (appId: string) => Promise<AppActionResult>;
        /**
         * Where this app's database dumps land (Tynn #250, step 4).
         *
         * Omit `appId` for the WORKSTATION default; pass one to read that app's
         * override alongside it. `resolved.from` says which level decided each
         * field, so a folder is never shown without saying where it came from.
         */
        backupSettings: (appId?: string) => Promise<AppBackupSettingsView>;
        /** `appId: null` writes the workstation default; a `null` patch for an
         *  app CLEARS its override so it follows that default again. */
        setBackup: (
            appId: string | null,
            patch: Partial<AppBackupPolicy> | null,
        ) => Promise<{ ok: boolean } & Partial<AppBackupSettingsView>>;
        /** Dump this app's live database engines now. */
        backup: (appId: string) => Promise<AppBackupRunView>;
    };
    /**
     * fancy-flow workflows owned by a Genie App — Genie's own editing surface.
     *
     * Saving grants nothing. A graph reaching past the app's permissions saves
     * fine, because an author is allowed to be mid-edit; it is refused at RUN.
     * `check` is how the canvas shows that before anyone waits for 3am.
     */
    flows: {
        list: (appId: string) => Promise<FlowSummaryView[]>;
        get: (flowId: string) => Promise<FlowView | null>;
        save: (input: {
            id: string;
            appId: string;
            name: string;
            graph: unknown;
            enabled?: boolean;
        }) => Promise<FlowView | null>;
        remove: (flowId: string) => Promise<boolean>;
        setEnabled: (flowId: string, enabled: boolean) => Promise<FlowView | null>;
        check: (appId: string, graph: unknown) => Promise<FlowAdmissionView>;
        palette: (appId: string) => Promise<{
            available: FlowNodeKindView[];
            all: FlowNodeKindView[];
        }>;
        run: (flowId: string) => Promise<FlowRunOutcomeView>;
    };
    /**
     * The GApp window's own surface. Only a GApp window answers these; Genie's
     * other windows get null, because they are not one.
     */
    gapp: {
        describe: () => Promise<{
            app: InstalledAppView;
            /** The app's workspace — the Agent tab's Floor runs over it. */
            workspace: WorkspaceRow | null;
            tabs: { kind: 'agent' | 'app'; title: string }[];
            /**
             * Present only when this window is a PREVIEW.
             *
             * The strip uses it to say so, and to keep saying what did not come
             * up: an app tab showing nothing, with no explanation, reads as a bug
             * in the app being built rather than as a preview limitation.
             */
            preview?: { folder: string; warnings: string[] };
        } | null>;
        showTab: (index: number) => Promise<void>;
    };
    plugins: {
        list: () => Promise<InstalledPluginView[]>;
        installRepo: (url: string, ref?: string) => Promise<PluginActionResult>;
        installFolder: (folder?: string) => Promise<PluginActionResult>;
        enable: (id: string, enabled: boolean) => Promise<PluginActionResult<boolean>>;
        setGrant: (
            id: string,
            category: 'fs' | 'network' | 'genieApi',
            key: string,
            granted: boolean,
        ) => Promise<PluginActionResult<boolean>>;
        uninstall: (id: string) => Promise<PluginActionResult<boolean>>;
        marketplaces: () => Promise<MarketplaceView[]>;
        addMarketplace: (url: string, ref?: string) => Promise<PluginActionResult>;
        refreshMarketplace: (id: string) => Promise<PluginActionResult>;
        /** Re-read every marketplace index older than `maxAgeMs` (0 = all of them). */
        refreshMarketplaces: (
            maxAgeMs?: number,
        ) => Promise<PluginActionResult<MarketplaceRefreshReport[]>>;
        removeMarketplace: (id: string) => Promise<PluginActionResult<boolean>>;
        installMarketplacePlugin: (
            marketplaceId: string,
            pluginId: string,
        ) => Promise<PluginActionResult>;
        official: () => Promise<OfficialPluginsResult>;
        installBundled: (id: string) => Promise<PluginActionResult>;
        /** Launchable recipes contributed by enabled + `recipes`-granted plugins. */
        recipes: () => Promise<PluginRecipeView[]>;
        /** Launchable workspace panels contributed by enabled + `ui.panel`-granted plugins. */
        panels: () => Promise<PluginPanelView[]>;
        /** Capability-scoped binary read/write for a granted plugin editor (§6.2). */
        editorRead: (
            pluginId: string,
            root: string,
            relPath: string,
        ) => Promise<PluginEditorReadResult>;
        editorWrite: (
            pluginId: string,
            root: string,
            relPath: string,
            base64: string,
        ) => Promise<PluginEditorWriteResult>;
        /** Which enabled plugin's editor claims this file's extension (§6.1),
         *  or null when the default code editor should open it. */
        editorFor: (fileName: string) => Promise<{
            pluginId: string;
            editorId: string;
            fancyExport: string;
            fancyPackage: string;
            fancyVersion: string;
        } | null>;
        /** Markdown <-> DOCX conversion for the Document editor (runs in main,
         *  keeping mammoth/docx out of the renderer bundle). */
        convertDocument: (req: {
            to: 'markdown' | 'docx';
            base64?: string;
            markdown?: string;
        }) => Promise<{ ok: boolean; markdown?: string; base64?: string; error?: string }>;
        /** Developer Mode + trusted signing keys (Phase 3). */
        developerMode: () => Promise<PluginDeveloperModeState>;
        setDeveloperMode: (enabled: boolean) => Promise<PluginActionResult<boolean>>;
        addTrustedKey: (
            publicKeyPem: string,
            label?: string,
        ) => Promise<PluginActionResult<{ keyId: string }>>;
        removeTrustedKey: (keyId: string) => Promise<PluginActionResult<boolean>>;
    };
    /**
     * Repository panel (the first plugin-panel consumer): host-side git ops the
     * RepoChangesPanel adapter drives. Every op is contained to the workspace root
     * + a workspace-relative repo folder ('' = the root itself). Human-initiated +
     * ungated. Remote windows get a "desktop-only for now" degradation (Phase 6).
     */
    repo: {
        list: (workspaceRoot: string) => Promise<RepoResult<RepoRef[]>>;
        status: (workspaceRoot: string, repoRel: string) => Promise<RepoResult<RepoStatus>>;
        diff: (
            workspaceRoot: string,
            repoRel: string,
            filePath: string,
            staged: boolean,
        ) => Promise<RepoResult<{ patch: string }>>;
        stage: (workspaceRoot: string, repoRel: string, paths: string[]) => Promise<RepoResult<null>>;
        unstage: (
            workspaceRoot: string,
            repoRel: string,
            paths: string[],
        ) => Promise<RepoResult<null>>;
        commit: (
            workspaceRoot: string,
            repoRel: string,
            message: string,
        ) => Promise<RepoResult<{ commit: string }>>;
        push: (workspaceRoot: string, repoRel: string, remote?: string) => Promise<RepoResult<null>>;
        pull: (workspaceRoot: string, repoRel: string) => Promise<RepoResult<null>>;
        createBranch: (
            workspaceRoot: string,
            repoRel: string,
            name: string,
        ) => Promise<RepoResult<null>>;
    };
    /**
     * Mobile remote-control server (Settings → Mobile). Desktop-only namespace —
     * the phone talks to the tailnet server directly, never via this bridge.
     *   - `status()` — live state + PIN + QR data-URL.
     *   - `restart(enabled?)` — persist the toggle (caller sets `mobile_enabled`
     *     first), then (re)bind/unbind; returns the fresh status.
     *   - `regeneratePin()` — roll the PIN (sessions kept).
     *   - `revokeSessions()` — drop every paired session (returns the count).
     *   - `lock(locked)` — engage/release the global kill-switch.
     */
    mobile: {
        status: () => Promise<MobileStatus>;
        restart: (enabled?: boolean) => Promise<MobileStatus>;
        /** Toggle desktop Genie Remote independently of the phone UI. */
        setRemoteEnabled: (enabled: boolean) => Promise<MobileStatus>;
        regeneratePin: () => Promise<MobileStatus>;
        /** win32: add the inbound firewall rule for the live port (one UAC prompt).
         *  `cancelled` when the user declines UAC; `error` on any other failure. */
        allowFirewall: () => Promise<
            MobileStatus & { ok: boolean; cancelled?: boolean; error?: string }
        >;
        revokeSessions: () => Promise<MobileStatus & { revoked: number }>;
        /** Host-side roster of paired devices (no bearer tokens). */
        sessions: () => Promise<MobileDevice[]>;
        /** Unpair one device by its roster id. */
        revokeSession: (id: string) => Promise<MobileStatus & { ok: boolean }>;
        lock: (locked: boolean) => Promise<MobileStatus>;
        /** Hand the baton to a connected user (the desktop must be holding it). */
        giveControl: (
            principalId: string,
        ) => Promise<MobileStatus & { ok: boolean; error?: string }>;
    };
    tailscale: {
        status: () => Promise<TailscaleStatus>;
        up: () => Promise<{ ok: boolean; authUrl?: string | null; message?: string }>;
        openAuth: (url: string) => Promise<{ ok: boolean }>;
        install: () => Promise<{ started: boolean; url?: string; message?: string }>;
    };
    workmode: {
        discoverHosts: () => Promise<GenieHost[]>;
        openRemote: (host: {
            ip: string;
            port: number;
            hostname: string;
        }) => Promise<{ ok: boolean }>;
    };
    remote: {
        disconnect: () => Promise<{ ok: boolean }>;
        status: () => Promise<RemoteStatus>;
        /** This window's binding — `local`, or `remote` to a specific host. Read
         *  once on boot to route api() per-window (host window vs local window).
         *  `connKey` is the bound host's stable workstation identity (null when
         *  local) — keys per-workstation client settings (e.g. FTQ availability). */
        myBinding: () => Promise<{
            mode: 'local' | 'remote';
            host: RemoteHost | null;
            connKey: string | null;
        }>;
        request: (path: string, init?: { method?: string; json?: unknown }) => Promise<unknown>;
        onStatus: (cb: (s: RemoteStatus) => void) => () => void;
        /** Bridge link health (version match + upgrade/limbo). Read on mount;
         *  live changes arrive via `onLink`. Drives the host-window overlay. */
        linkState: () => Promise<RemoteLinkState>;
        /** Trigger the HOST's self-update over the bridge (download + restart). */
        upgradeHost: () => Promise<{ ok: boolean; error?: string }>;
        /** Manually restart the bridge after the limbo auto-retry gave up ('lost'). */
        reconnect: () => Promise<{ ok: boolean; error?: string }>;
        onLink: (cb: (s: RemoteLinkState) => void) => () => void;
        /** Control state: `locked:true` ⇒ the host has taken control and this
         *  driver is view-only. Read on mount; live changes arrive via `onControl`.
         *  Drives the view-only banner + the remote-bridge input gate. */
        controlState: () => Promise<RemoteControlState>;
        onControl: (cb: (s: RemoteControlState) => void) => () => void;
        /** Attach to a host pty. `cols`/`rows` (the client's fitted grid, when known)
         *  are held by main and applied once the term socket opens — a resize sent
         *  before then would hit a CONNECTING socket and be discarded. */
        terminalAttach: (
            id: string,
            workspaceId?: string,
            cols?: number,
            rows?: number,
        ) => Promise<{ ok: boolean }>;

        terminalInput: (id: string, data: string) => Promise<boolean>;
        terminalResize: (id: string, cols: number, rows: number) => Promise<boolean>;
        terminalDetach: (id: string) => Promise<{ ok: boolean }>;
        /** Connect a host (handling the PIN) and open its OWN native Floor window.
         *  The local window stays local — only the new host window is remote. */
        open: (
            host: RemoteHost,
            pin?: string,
        ) => Promise<{ ok: boolean; connKey?: string; error?: string; needsPin?: boolean }>;
        /** The persisted known-hosts list (for the picker), each tagged connected. */
        known: () => Promise<KnownHost[]>;
        forget: (connKey: string) => Promise<{ ok: boolean }>;
        rename: (connKey: string, name: string) => Promise<{ ok: boolean }>;
    };
    /** Serve-local-sites (Phase D): the Testing Browser. `open` shows the browser
     *  for a connected host; the rest are driven BY the chrome window (each resolves
     *  to that window's browser instance in main). The site content is a
     *  main-owned WebContentsView; the chrome renders `onState`. */
    testingBrowser: {
        open: (connKey: string, hostname: string) => Promise<{ ok: boolean; error?: string }>;
        state: () => Promise<TestingBrowserState | null>;
        navigate: (input: string) => Promise<{ ok: boolean; error?: string }>;
        back: () => Promise<{ ok: boolean }>;
        forward: () => Promise<{ ok: boolean }>;
        reload: () => Promise<{ ok: boolean }>;
        newTab: (input?: string) => Promise<{ ok: boolean; error?: string }>;
        closeTab: (tabId: string) => Promise<{ ok: boolean }>;
        activateTab: (tabId: string) => Promise<{ ok: boolean }>;
        setBounds: (bounds: {
            x: number;
            y: number;
            width: number;
            height: number;
        }) => Promise<{ ok: boolean }>;
        setViewport: (presetId: string) => Promise<{ ok: boolean }>;
        refreshSites: () => Promise<void>;
        onState: (cb: (s: TestingBrowserState) => void) => () => void;
        onLoadError: (
            cb: (e: { tabId: string; code: number; description: string; url: string }) => void,
        ) => () => void;
    };
    /** Virtual Workstations (relay transport): the signed-in member's entitled
     *  workstations + opening one over the Tynn relay (grant minted main-side). */
    workstations: {
        connectable: () => Promise<ConnectableWorkstation[]>;
        open: (
            workstationId: string,
            name: string,
        ) => Promise<{ ok: boolean; connKey?: string; error?: string }>;
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
    /** System clipboard via Electron main (reliable; the renderer's
     *  navigator.clipboard fails silently in a sandboxed window). */
    clipboard: {
        write: (text: string) => Promise<{ ok: boolean }>;
        read: () => Promise<string>;
        /**
         * The LOCAL clipboard image as a PNG data-URL, or null when there's no
         * image. NOT re-pointed by the remote bridge, so in a host window this
         * still reads the LOCAL clipboard (the machine the user copied on) — the
         * source of a remote image paste.
         */
        readImage: () => Promise<string | null>;
        /**
         * Place a PNG (base64, no data-URL prefix) where the CLI on the machine the
         * terminal runs on will read it: locally that's this machine; in a host
         * window the remote bridge re-points it to the HOST over the authed bridge.
         * On Windows/macOS it lands on the OS clipboard; on a LINUX host it's written
         * to a temp file and `path` is its absolute HOST path — the caller pastes the
         * path instead of a clipboard trigger (Claude Code can't reliably read a Linux
         * clipboard image). `supported:false` ⇒ the target can't accept an image (a
         * legacy unwired host) — the caller no-ops gracefully and never breaks text
         * paste.
         */
        writeImage: (
            dataBase64: string,
        ) => Promise<{ ok: boolean; supported: boolean; path?: string }>;
    };
    /** Built-in editor — reply to a main `editor:open-file` request
     *  (openFileForUser MCP tool), keyed by the request id main awaits. */
    editor: {
        openFileResult: (
            requestId: string,
            result: { reused: boolean; opened: boolean },
        ) => Promise<{ ok: boolean }>;
    };
    settings: {
        get: () => Promise<Settings>;
        set: (patch: Partial<Settings>) => Promise<Settings>;
        chooseFolder: (label?: string, defaultPath?: string) => Promise<string | null>;
        chooseFile: (label?: string) => Promise<string | null>;
        /** Read a sound file into a base64 data-URL (null when unreadable).
         *  Backs the per-alert "Custom file…" choice + the Settings Preview. */
        soundDataUrl: (path: string) => Promise<string | null>;
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
        /** Designate (or clear) this workspace as the WORKSTATION OPERATOR — its
         *  agent may then act on every workspace on this machine (Tynn #248). */
        setWorkstationOperator: (id: string, on: boolean) => Promise<{ ok: boolean }>;
        /** This workspace's agent-terminal cap: a maximum, `'unlimited'`, or `null`
         *  to inherit the workstation default (Tynn #117). Read through here rather
         *  than off the `list()` row — the column encodes unlimited as a sentinel
         *  that main decodes. */
        getMaxAgentTerminals: (id: string) => Promise<number | 'unlimited' | null>;
        /** Set (or clear, with `null`) this workspace's agent-terminal cap. Its own
         *  channel, reachable only from a window: an agent that can raise its own
         *  cap has no cap, so no agent-facing tool writes this (Tynn #117). */
        setMaxAgentTerminals: (
            id: string,
            cap: number | 'unlimited' | null,
        ) => Promise<{ ok: boolean }>;
        /** Toggle "require approval before an agent starts a background process". */
        setProcessApproval: (
            id: string,
            require: boolean,
        ) => Promise<{ ok: boolean }>;
        /** Toggle "require approval before an agent spawns a terminal / launches
         *  a coding agent" (manageTerminals / runAgent). */
        setTerminalApproval: (
            id: string,
            require: boolean,
        ) => Promise<{ ok: boolean }>;
        /** Toggle "require approval before an agent arms a scheduled task"
         *  (a manageProcess create carrying a `schedule`). */
        setScheduleApproval: (
            id: string,
            require: boolean,
        ) => Promise<{ ok: boolean }>;
        /** This workspace's AgentInbox front door — who may reach into it. */
        getAgentAccess: (
            id: string,
        ) => Promise<{ access: WorkspaceAgentAccess; workspaces: string[] }>;
        /** Persist this workspace's AgentInbox front door. `workspaces` is only
         *  meaningful for `specific` and is ignored otherwise. */
        setAgentAccess: (
            id: string,
            access: WorkspaceAgentAccess,
            workspaces?: string[],
        ) => Promise<{ ok: boolean }>;
        /** This workspace's resolved per-bucket IssueWatch remediation policy
         *  (legacy single value applied to all buckets as the fallback). */
        getIssuewatchPolicy: (id: string) => Promise<IssuewatchPolicyBuckets>;
        /** Persist this workspace's per-bucket IssueWatch remediation policy. */
        setIssuewatchPolicy: (
            id: string,
            buckets: IssuewatchPolicyBuckets,
        ) => Promise<{ ok: boolean }>;
        /** This workspace's resolved IssueWatch granularity (defaults applied). */
        getIssuewatchGranularity: (id: string) => Promise<IssuewatchGranularity>;
        /** Persist this workspace's IssueWatch granularity (what to watch + ping). */
        setIssuewatchGranularity: (
            id: string,
            granularity: IssuewatchGranularity,
        ) => Promise<{ ok: boolean }>;
        /** This workspace's DESIGNATED IssueWatch handler set + the candidate agents
         *  to choose from (their live handle/action state), for the designation UI. */
        getIssuewatchHandlers: (id: string) => Promise<{
            designated: string[];
            agents: Array<{
                terminalId: string;
                label: string;
                handle: boolean;
                action: 'notify' | 'wake';
            }>;
        }>;
        /** Persist the designated IssueWatch handler set (empty = fan out to all
         *  handle-enabled agents). */
        setIssuewatchHandlers: (
            id: string,
            terminalIds: string[],
        ) => Promise<{ ok: boolean }>;
        /** Repo subfolder names under the workspace envelope (for Add Process cwd). */
        repos: (id: string) => Promise<string[]>;
        open: (id: string) => Promise<{ ok: boolean }>;
        /** Clone a remote git repo to parentPath/<folder>; returns the local path. */
        clone: (
            url: string,
            parentPath: string,
            folder?: string,
        ) => Promise<{ path: string }>;
        /** Reveal a workspace-relative path in the OS file manager (guarded). */
        reveal: (
            workspacePath: string,
            relPath: string,
        ) => Promise<{ ok: boolean; error?: string }>;
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
        /** Envelope member repos (project.json registry ∪ on-disk submodules). */
        reposList: (workspacePath: string) => Promise<EnvelopeReposResult>;
        /** Add a repo as a submodule under repos/<name> and register it. */
        repoAdd: (
            workspacePath: string,
            url: string,
            name: string,
        ) => Promise<RepoMutationResult>;
        /** Remove a repo (deinit + rm + unregister). Host repo is protected. */
        repoRemove: (
            workspacePath: string,
            name: string,
        ) => Promise<RepoMutationResult>;
        /** The envelope's `.ai/` knowledge folders + whether each exists. */
        knowledgeList: (workspacePath: string) => Promise<KnowledgeResult>;
        /** Scaffold a standard `.ai/<name>` knowledge folder. */
        knowledgeCreate: (
            workspacePath: string,
            name: string,
        ) => Promise<RepoMutationResult>;
    };
    tynn: {
        projects: () => Promise<TynnProject[]>;
        /** Owners the user may create a project under (personal first). */
        ownerOptions: () => Promise<OwnerOption[]>;
        /** Create a Tynn project (defaults to the personal account). Returns it
         *  in the same shape as `projects()` so it can back a new workspace. */
        createProject: (input: {
            name: string;
            owner_type?: 'user' | 'organization' | 'team';
            owner_id?: string;
            slug?: string;
        }) => Promise<TynnProject>;
        captureWish: (
            projectId: string,
            content: string,
            backendKind?: BackendKind,
        ) => Promise<{ id: string; backend: BackendKind }>;
        /** File feedback about GENIE ITSELF into a Tynn project (Tynn #249).
         *  Distinct from captureWish: a wish is work the user wants and lands in
         *  the backlog; feedback is a report about the tool and lands in Tynn's
         *  feedback pipeline. Never throws — it resolves with `ok:false` and a
         *  reason, so a form can show what went wrong instead of dying. */
        submitFeedback: (
            projectId: string,
            message: string,
            meta?: Record<string, string>,
            backendKind?: BackendKind,
        ) => Promise<{ ok: boolean; id?: string; error?: string }>;
        inbox: () => Promise<InboxPayload>;
        openInBrowser: (
            urlOrPath: string,
            backendKind?: BackendKind,
        ) => Promise<{ ok: boolean }>;
        /** Link a workspace to a Tynn project (writes the secret-free project.json block). */
        link: (
            workspacePath: string,
            link: { host?: string; owner?: string; project?: string; projectId?: string },
        ) => Promise<{ ok: boolean }>;
        /** Clear the workspace's Tynn project link (drops the project.json block). */
        unlink: (workspacePath: string) => Promise<{ ok: boolean }>;
        /**
         * Probe this workspace's Tynn MCP endpoint and report WHY it is or isn't
         * usable (main/mcp/tynn-health.ts). Read-only — `initialize` +
         * `tools/list` only, never a work-item tool, because the endpoint is the
         * user's production Tynn. The result also arrives on
         * `events.tynnHealthUpdate` for every other open window.
         */
        health: (
            workspaceId: string,
            workspacePath: string,
            workspaceName: string,
        ) => Promise<TynnHealth>;
        /** The last probe per workspace id, with no re-probe (boot warm-up). */
        healthAll: () => Promise<Record<string, TynnHealth>>;
        /** Where the workspace stands without minting anything (UI display). */
        provisionStatus: (workspacePath: string) => Promise<{
            status: 'unlinked' | 'signed-out' | 'already' | 'provision';
            link: { host?: string; owner?: string; project?: string; projectId?: string } | null;
        }>;
        /** Mint the agent token + write the workspace Agent MCP config. */
        provision: (
            workspacePath: string,
            force?: boolean,
        ) => Promise<{
            status: 'unlinked' | 'signed-out' | 'already' | 'provision' | 'error';
            agent?: { id: string; name: string };
            isOpsProject?: boolean;
            error?: string;
        }>;
        /** Ops-project repo reconcile plan (read-only). */
        opsPlan: (workspacePath: string) => Promise<{
            isOps: boolean;
            signedIn: boolean;
            toAdd: Array<{ name: string; url: string; projectId: string }>;
            toRemove: Array<{ name: string }>;
            missingLocally: Array<{ name: string; projectId: string }>;
        }>;
        /** Apply the user-approved add/remove subset (mutates the envelope). */
        opsApply: (
            workspacePath: string,
            approved: {
                add?: Array<{ name: string; url: string; projectId: string }>;
                remove?: string[];
            },
        ) => Promise<{ added: string[]; removed: string[]; errors: string[] }>;
        /** Ops-project WORKSPACE provisioning plan (read-only). For each governed
         *  child project: whether a local workspace exists, and the `*.agi` URL
         *  Genie would clone for a missing one. */
        opsProvisionPlan: (workspacePath: string) => Promise<{
            isOps: boolean;
            signedIn: boolean;
            parentPath: string;
            autoProvision: boolean;
            children: Array<{
                projectId: string;
                name: string;
                slug: string;
                status: 'present' | 'missing';
                cloneUrl: string | null;
                workspacePath?: string;
            }>;
        }>;
        /** Clone + register the approved child workspaces (mutates disk + db). */
        opsProvisionApply: (
            workspacePath: string,
            targets: Array<{
                projectId: string;
                name: string;
                slug: string;
                cloneUrl: string;
            }>,
        ) => Promise<{
            provisioned: Array<{ name: string; workspaceId: string; path: string }>;
            errors: string[];
        }>;
        /** The ops-auto-provision-workspaces toggle (default off). */
        opsAutoProvisionGet: () => Promise<{ on: boolean }>;
        opsAutoProvisionSet: (on: boolean) => Promise<{ on: boolean }>;
    };
    tynnHost: {
        get: () => Promise<string>;
    };
    app: {
        hideCapture: () => Promise<{ ok: boolean }>;
        getCurrentProject: () => Promise<{ id: string; name: string } | null>;
        /** The user's home directory (roots the synthetic System Workspace). */
        homeDir: () => Promise<string>;
        /** Open Settings. `fromRemote:true` (a remote/host window) restricts it to
         *  the connection-relevant subset (Appearance / Notifications / copy-paste). */
        showSettings: (fromRemote?: boolean) => Promise<{ ok: boolean }>;
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
    shell: {
        /** Open an http/https URL in the OS default browser (terminal links). */
        openExternal: (url: string) => Promise<{ ok: boolean }>;
    };
    docs: {
        list: () => Promise<DocEntry[]>;
        read: (slug: string) => Promise<string | null>;
    };
    /**
     * Workstation Knowledge Graph (Wish #87) — a local, cross-workspace memory
     * store. Nodes are markdown memories; `[[wikilink]]` refs between them are
     * edges. `openWindow` opens the standalone, Genie-skinned Knowledge Graph
     * window (renderer/pages/knowledge.tsx); the rest are the store's CRUD +
     * search + graph read that window drives. `source` is set main-side —
     * anything added here is `'user'`.
     */
    knowledge: {
        /** Full-text search across memories; results are pre-ranked by `score`. */
        search: (
            query: string,
            opts?: { limit?: number; tags?: string[] },
        ) => Promise<KnowledgeSearchResult[]>;
        /** Every memory (optionally filtered by tag / capped), newest first. */
        list: (opts?: { tag?: string; limit?: number }) => Promise<KnowledgeNode[]>;
        get: (id: string) => Promise<KnowledgeNode | null>;
        add: (input: KnowledgeInput) => Promise<KnowledgeNode>;
        update: (
            id: string,
            patch: Partial<KnowledgeInput>,
        ) => Promise<KnowledgeNode | null>;
        delete: (id: string) => Promise<{ ok: boolean }>;
        /** The whole store as nodes + edges, for the relationship view. */
        graph: () => Promise<KnowledgeGraphData>;
        /** Open the standalone Knowledge Graph window (the header button). */
        openWindow: () => Promise<{ ok: boolean }>;
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
        /** Drop a Process's recorded output tail (the log popover's "Clear log"). */
        clearLog: (id: string) => Promise<{ ok: boolean }>;
        /** Every process across every workspace (+ System) for the Task Manager. */
        list: () => Promise<ProcessListItem[]>;
    };
    /** Scheduled tasks — a Process whose spec carries `meta.schedule`. The
     *  schedule itself is edited through `terminalSpec.update` (it lives on the
     *  spec's meta); these are the runtime-only bits the Host owns. */
    schedule: {
        /** Per-task next-run instant + human description, keyed by spec id. The
         *  HOST formats the description — the renderer never parses cron. */
        info: () => Promise<Record<string, ScheduleInfo>>;
        /** Fire a scheduled task now, without disturbing its schedule. */
        runNow: (id: string) => Promise<{ ok: boolean }>;
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
        /**
         * Persist the grid's drag-reorder. `ids` is the full ordered list of
         * spec ids for ONE workspace; each index becomes that spec's
         * sort_order, which is what `list()` sorts by. Mirrors
         * `workspaces.reorder` for the sidebar.
         */
        reorder: (ids: string[]) => Promise<{ ok: boolean }>;
        /**
         * Create a SPECIALIZED (AI-TUI) terminal: main resolves the launch command
         * (`resolveAgentCommand` + the `agent_command_*` settings), spawns the pty,
         * submits the boot command, stamps the AgentInbox identity/scope onto the
         * spec meta, and joins the AgentInbox broker. Returns the persisted spec so the
         * renderer can select it into view.
         */
        createAgent: (input: {
            workspace_id: string | null;
            agent: AgentType;
            /** Required for `custom`; overrides the resolved command otherwise. */
            command?: string;
            cwd?: string;
            label?: string;
            /** Channel purpose (kebab, ≤6 words). */
            purpose: string;
            scope: AgentInboxScope;
            /** The chosen workspace ids when `scope === 'specific'`. */
            scope_workspaces?: string[];
            /** Opt-in wake-on-DM: a direct message wakes this agent when idle (issue #9). */
            wake_on_dm?: boolean;
            /** IssueWatch pings: participate in this workspace's IssueWatch deltas. */
            issuewatch_handle?: boolean;
            /** IssueWatch pings: react by glow (`notify`) or idle-wake (`wake`). */
            issuewatch_action?: 'notify' | 'wake';
        }) => Promise<{ ok: boolean; spec?: TerminalSpec; error?: string }>;
        /** Gracefully restart an agent terminal: reconnect its TUI to the current
         *  MCP rig (fresh tools/protocol) while resuming the conversation. Resolves
         *  to the old→new terminal ids, or `{ ok: false, error }` when the agent
         *  can't be resumed (non-claude, or no captured session). */
        restartAgent: (
            id: string,
        ) => Promise<
            | { ok: true; oldId: string; newId: string; agent: AgentType; command: string }
            | { ok: false; error: string }
        >;
    };
    /**
     * AgentInbox — the local inter-agent messaging network. Local-only in v1
     * (one Genie instance; no relay). The human panel reads the directory /
     * channels / history and posts as the human; live updates arrive on
     * `on.agentInboxPresence` / `on.agentInboxMessage`.
     */
    agentPulse: {
        /** Last-60s per-workspace byte buckets (index 0 = 59s ago … 59 = now),
         *  fetched once when the workspace menu opens to backfill each sparkline. */
        snapshot: () => Promise<{ pulses: Record<string, number[]> }>;
    };
    /** PendingQuestions inbox — the top-bar question icon's grouped list + answers. */
    questions: {
        list: () => Promise<{ groups: WorkspaceQuestionGroupSpec[]; count: number }>;
        answer: (id: string, answers: ForceAnswerSpec[]) => Promise<boolean>;
    };
    agentInbox: {
        /** Every discoverable agent (the directory pane). */
        directory: () => Promise<{ agents: AgentInboxAgentInfo[] }>;
        /** Every broadcast channel (`slug:purpose`). */
        channels: () => Promise<{ channels: AgentInboxChannelInfo[] }>;
        /** Every DM thread with messages — human↔agent AND agent↔agent. */
        dmThreads: () => Promise<{ threads: AgentInboxDmThreadInfo[] }>;
        /** Message history for a channel, an arbitrary DM `dmPair`, OR the
         *  human↔agent thread (`agentId`) — paginate via `before`. */
        history: (opts: {
            channelKey?: string;
            agentId?: string;
            dmPair?: [string, string];
            limit?: number;
            before?: number;
        }) => Promise<{ messages: AgentInboxMessage[] }>;
        /** Post as the human — to a channel (`channelKey`) or an agent (`toAgentId`),
         *  optionally with FILES. Attachment bytes ride the call (base64, straight
         *  from the browser file input) rather than as a host path: the panel needs
         *  no filesystem access, and on a remote window the human attaches from
         *  their OWN machine. All-or-nothing — a refused file sends nothing. */
        post: (input: {
            channelKey?: string;
            toAgentId?: string;
            text: string;
            attachments?: Array<{ filename: string; base64: string }>;
        }) => Promise<{ ok: boolean; error?: string }>;
        /** An attachment's BYTES, so the panel can save it client-side (a remote
         *  human gets the file on their machine, not the host's). Reads Genie's own
         *  content-addressed store — no filesystem egress. */
        attachmentBytes: (attachmentId: string) => Promise<{
            ok: boolean;
            error?: string;
            filename?: string;
            mime?: string;
            bytes?: number;
            base64?: string;
        }>;
        /** AGENT-LAG (genie #64) — how many messages this workstation's AGENTS
         *  have not received/ACKed. The header badge's signal: it answers "are my
         *  agents keeping up?", NOT "what haven't I read?" (that is client-side,
         *  see renderer/lib/agentinbox-view.ts). Live via `on.agentInboxLag`. */
        lag: () => Promise<{ count: number }>;
        /** Wipe a channel's history — the panel log AND the durable rows (genie
         *  #64). A HOST op: agent inboxes and ACK cursors are left untouched. */
        clearChannel: (channelKey: string) => Promise<{ ok: boolean; cleared: number }>;
        /** Delete a whole DM thread by its pair key (`<idA>|<idB>`, sorted — the
         *  key `dmThreads()` reports). Covers human↔agent and agent↔agent. */
        deleteThread: (pairKey: string) => Promise<{ ok: boolean; cleared: number }>;
        /** Wipe MANY conversations in one host call (genie #66 mass delete) —
         *  batches the same per-target ops, so one round trip instead of N. */
        wipeMany: (input: {
            channelKeys?: string[];
            pairKeys?: string[];
        }) => Promise<{ ok: boolean; cleared: number; channels: number; threads: number }>;
        /** Edit an agent's channel identity (purpose / scope) — re-emits presence. */
        updateChannel: (
            specId: string,
            patch: {
                purpose?: string;
                scope?: AgentInboxScope;
                scope_workspaces?: string[];
                /** Opt-in wake-on-DM (issue #9): a direct message wakes this agent when idle. */
                wake_on_dm?: boolean;
                /** IssueWatch pings: participate in this workspace's IssueWatch deltas. */
                issuewatch_handle?: boolean;
                /** IssueWatch pings: react by glow (`notify`) or idle-wake (`wake`). */
                issuewatch_action?: 'notify' | 'wake';
            },
        ) => Promise<{ ok: boolean; error?: string }>;
    };
    files: {
        listTree: (
            workspacePath: string,
            opts?: { maxDepth?: number; maxEntries?: number; root?: string; system?: boolean },
        ) => Promise<TreeNodeData[]>;
        read: (
            workspacePath: string,
            relPath: string,
            system?: boolean,
        ) => Promise<{ content: string; truncated: boolean }>;
        write: (
            workspacePath: string,
            relPath: string,
            content: string,
            system?: boolean,
        ) => Promise<{ ok: boolean }>;
        createFile: (
            workspacePath: string,
            relPath: string,
            system?: boolean,
        ) => Promise<{ ok: boolean }>;
        createFolder: (
            workspacePath: string,
            relPath: string,
            system?: boolean,
        ) => Promise<{ ok: boolean }>;
        rename: (
            workspacePath: string,
            fromRel: string,
            toRel: string,
            system?: boolean,
        ) => Promise<{ ok: boolean }>;
        duplicate: (
            workspacePath: string,
            relPath: string,
            system?: boolean,
        ) => Promise<{ ok: boolean; relPath: string }>;
        /** Copy an external OS path into a workspace folder; returns the new rel path. */
        importExternal: (
            workspacePath: string,
            srcAbs: string,
            destFolderRel: string,
            system?: boolean,
        ) => Promise<{ ok: boolean; relPath: string }>;
        /** OS path of a File from an external drag (webUtils.getPathForFile). */
        pathForFile: (file: File) => string;
        /** Read a LOCAL absolute file's bytes (base64) — the client half of a remote
         *  external-file drop (bytes shipped to the host to write into a folder). */
        readExternalBytes: (
            absPath: string,
        ) => Promise<{ name: string; base64: string }>;
        delete: (
            workspacePath: string,
            relPath: string,
            system?: boolean,
        ) => Promise<{ ok: boolean }>;
        gitStatus: (
            workspacePath: string,
            opts?: { ignored?: boolean },
        ) => Promise<GitStatusMap>;
        /** Start/stop live fs-watching of a workspace root; drives on.treeChanged. */
        watch: (workspacePath: string) => Promise<{ ok: boolean }>;
        unwatch: (workspacePath: string) => Promise<{ ok: boolean }>;
    };
    github: {
        status: () => Promise<{
            connected: boolean;
            username: string | null;
            needsReauth: boolean;
            reauthFailure: {
                code: string;
                occurredAt: number;
                message: string;
            } | null;
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
        /**
         * Install URL for the "Genie IDE" GitHub App. With no arg this is the
         * account chooser (personal + every installable org); pass a numeric
         * account id to pre-target the chooser at that account.
         */
        installUrl: (targetId?: number | null) => Promise<string>;
        disconnect: () => Promise<{ ok: boolean }>;
        user: () => Promise<{ login: string; name: string | null; avatar_url: string }>;
        /** Org accounts where the GitHub App is installed (for the owner picker). */
        orgs: () => Promise<
            Array<{
                login: string;
                avatar_url: string;
            }>
        >;
        /** Every account the App is installed on — personal AND orgs. Source of
         *  truth for "is Genie installed anywhere / on this account". */
        installations: () => Promise<
            Array<{
                login: string;
                avatar_url: string;
                id: number | null;
                isOrg: boolean;
            }>
        >;
        /** Resolve a source repo's owner (login + id + isOrg) so create/fork
         *  can target the SAME account the original repo lives in. */
        repoOwner: (
            owner: string,
            repo: string,
        ) => Promise<{ login: string; id: number | null; isOrg: boolean }>;
        createRepo: (opts: {
            name: string;
            owner?: string | null;
            ownerId?: number | null;
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
            intoOrgId?: number | null;
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
        /**
         * Current GitHub capability status: which GitHub-dependent features the
         * installed App's granted permissions allow, and which are gated off
         * for want of a permission. Drives the resolve modal + header warning.
         */
        capabilities: () => Promise<GithubCapabilities>;
        /** Whether a single GitHub-dependent capability is usable right now. */
        canAccess: (key: GithubCapabilityKey) => Promise<boolean>;
        /**
         * Force a re-detection (after a reconnect / the owner approving a
         * permission update on GitHub). Returns + broadcasts the fresh status,
         * so a resolved warning clears across every window.
         */
        recheckCapabilities: () => Promise<GithubCapabilities>;
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
            /** The terminal's workspace id. Used only on a relay REMOTE session,
             *  where it's tagged onto the term `open` frame so the host scopes the
             *  terminal to the grant's workspaces; ignored for a local pty spawn. */
            workspaceId?: string;
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
            cb: (payload: {
                id: string;
                workspaceLabel?: string;
                questions: ForceQuestionSpec[];
                /** How many other requests are still queued behind this one. */
                queued?: number;
            }) => void,
        ) => () => void;
        /** PendingQuestions v2 — the WHOLE pending queue (priority-ordered), so the
         *  modal can list every pending request + let the user pick which to answer. */
        onQueue: (
            cb: (payload: {
                pending: Array<{
                    id: string;
                    workspaceLabel?: string;
                    questions: ForceQuestionSpec[];
                    index: number;
                    priority?: 'low' | 'normal' | 'high' | 'urgent';
                    remoteHost?: string;
                }>;
            }) => void,
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
        /** PendingQuestions — a question was added / answered / deferred; refetch. */
        questionsChanged: (cb: () => void) => () => void;
        /** Customization: play a notification chime. The `sound` descriptor is
         *  resolved main-side from the per-alert setting (synth / bundled asset /
         *  custom data-URL); a legacy payload without it falls back to synth. */
        notifySound: (
            cb: (payload: {
                kind: string;
                sound?:
                    | { mode: 'synth' }
                    | { mode: 'asset'; name: string }
                    | { mode: 'data'; dataUrl: string };
            }) => void,
        ) => () => void;
        /** The tray "Task Manager…" item asks the master window to open it. */
        openTaskManager: (cb: () => void) => () => void;
        /** Issue Watch: per-workspace unread counts (by type) + per-workspace
         *  worst read detail (bucket + raw HTTP status/message, so the flyout
         *  can explain a silent-empty pill precisely) + whether the GitHub
         *  session is dead (drives the Reconnect CTA live, no reopen needed). */
        issueWatchUpdate: (
            cb: (payload: {
                counts: Record<string, WatchTypeCounts>;
                errors?: Record<string, WatchErrorDetail>;
                needsReauth?: boolean;
            }) => void,
        ) => () => void;
        /** A Tynn MCP health probe finished (pushed — this is never polled). */
        tynnHealthUpdate: (cb: (payload: TynnHealth) => void) => () => void;
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
        /** A setting changed (payload = changed keys) — live UI re-reads with no
         *  restart (e.g. a terminal's copy/paste mode). */
        settingsChanged: (cb: (changedKeys: string[]) => void) => () => void;
        /** Agent-integration MCP: a terminal asked for attention (imDone) or cleared. */
        terminalAttention: (
            cb: (payload: { id: string; on: boolean }) => void,
        ) => () => void;
        /** Agent-integration MCP: pulse a workspace row — a terminal in it called
         *  imDone (workspaceId is the synthetic System Workspace id for a
         *  System-Workspace terminal). A transient sidebar-level cue. */
        workspacePulse: (
            cb: (payload: { workspaceId: string }) => void,
        ) => () => void;
        /** AgentPulse — per-workspace real-time terminal-activity. `active` drives
         *  the rail-icon glow; `bytes` (since the last emit) feeds the live
         *  1-minute sparkline. */
        agentPulse: (
            cb: (payload: { workspaceId: string; active: boolean; bytes: number }) => void,
        ) => () => void;
        /** A workspace was "opened" (tray / menu / MCP) — focus it in the master
         *  window and open its in-app editor scoped to the workspace folder. */
        workspaceOpen: (
            cb: (payload: { workspaceId: string }) => void,
        ) => () => void;
        /** openFileForUser (MCP) — open a file in the workspace's built-in editor,
         *  reusing an open Code panel or opening a new one. Reply with
         *  api().editor.openFileResult(requestId, …). */
        editorOpenFile: (
            cb: (payload: {
                requestId: string;
                workspaceId: string;
                root: string;
                relPath: string;
                line?: number;
            }) => void,
        ) => () => void;
        /** A background Process changed status. */
        processStatus: (
            cb: (payload: { id: string; status: ProcessStatus }) => void,
        ) => () => void;
        /** A scheduled task was armed, fired, or disarmed — its next run moved. */
        scheduleNext: (
            cb: (payload: {
                id: string;
                nextAt: number | null;
                description: string | null;
            }) => void,
        ) => () => void;
        /** The set of terminal specs changed outside the renderer's own edits
         *  (e.g. an MCP-created process) — re-fetch the spec list to stay live. */
        terminalSpecsChanged: (cb: () => void) => () => void;
        /** The set of workspaces changed outside the renderer's own edits (e.g.
         *  MCP-provisioned child workspaces) — re-fetch the workspace list. */
        workspacesChanged: (cb: () => void) => () => void;
        /** A dev site or service was configured / started / stopped / removed
         *  (#234) — the rail's sites icon and any open Site Manager re-read.
         *  Push, never a poll: a site can come up long after boot (an image
         *  pull, or a Dockerfile build). */
        devServerChanged: (cb: () => void) => () => void;
        /** A live START tick for one dev site (Gap 2): `pulling → building →
         *  starting → ready|failed`, carrying the streaming build/pull log — so an
         *  open Site Manager card reflects a site coming up the moment Start is
         *  clicked. High-frequency; separate from the coarse `devServerChanged`. */
        devSiteProgress: (cb: (payload: DevSiteProgress) => void) => () => void;
        /** Per-tool progress from an in-flight toolchain install (#240): a `start`
         *  then a `done` (with status) for each tool the wizard installs. */
        toolchainProgress: (cb: (payload: ToolchainProgress) => void) => () => void;
        /** A file changed on disk in a watched workspace (an agent, a git op, a
         *  tool) — the Files panel re-lists its tree AND reloads ONLY the open
         *  tabs whose file is named in `changed` (forward-slashed rel paths). A
         *  null `changed` (too many, or an unnamed event) re-lists the tree only
         *  and reloads no open viewer. Debounced in main. */
        treeChanged: (
            cb: (payload: { workspacePath: string; changed: string[] | null }) => void,
        ) => () => void;
        /** Tier 3 detached-host status — fired on fallback to in-process. */
        terminalHostStatus: (
            cb: (payload: { message: string; level: 'info' | 'warn' }) => void,
        ) => () => void;
        /** A message landed for an agent whose input box Genie would not touch, so
         *  the notice was APPENDED there unsubmitted. Drives the top-centre toast.
         *  Optional — absent on the remote bridge (a local-prompt concern). */
        agentInboxIncoming?: (cb: (payload: { id: string }) => void) => () => void;
        /** Host-loss recovery (genie#203): main asks the renderer to remount these
         *  terminals so their create() rejoins the respawned host + replays
         *  scrollback. Optional — absent on the remote bridge (local-host concern). */
        terminalRecover?: (
            cb: (payload: { ids: string[] }) => void,
        ) => () => void;
        /** Host-loss recovery status (genie#203), for the recovery banner. */
        terminalRecoveryStatus?: (
            cb: (payload: {
                state: 'recovering' | 'recovered' | 'degraded';
            }) => void,
        ) => () => void;
        /**
         * Manual-quit terminal confirmation (T3). Main asks the master window to
         * pick which detached terminals to keep running vs shut down before quit.
         * Reply via app.quitDecision().
         */
        confirmQuitTerminals: (
            cb: (payload: {
                terminals: Array<{ id: string; pid: number; shell: string }>;
                destructive?: boolean;
            }) => void,
        ) => () => void;
        updaterStatus: (cb: (status: UpdaterStatus) => void) => () => void;
        updaterLog: (cb: (payload: { line: string }) => void) => () => void;
        /** GitHub capability status changed (boot check, connect, reconnect,
         *  disconnect, or an explicit recheck). The renderer raises/clears the
         *  resolve modal + header warning and re-gates features from this. */
        githubCapabilities: (
            cb: (payload: GithubCapabilities) => void,
        ) => () => void;
        /** AgentInbox: an agent joined / changed accessibility / went offline —
         *  the panel re-renders its directory + channel list live. */
        agentInboxPresence: (
            cb: (payload: AgentInboxPresenceEvent) => void,
        ) => () => void;
        /** AgentInbox: a new message (preview only) — the panel bumps its unread
         *  badge and, if the relevant thread is open, re-fetches history. */
        agentInboxMessage: (
            cb: (payload: AgentInboxMessageEvent) => void,
        ) => () => void;
        /** AgentInbox AGENT-LAG level changed (genie #64) — the header badge's
         *  count. A LEVEL, so it only fires on a transition. */
        agentInboxLag: (cb: (payload: { count: number }) => void) => () => void;
        /** AgentInbox: the human wiped a conversation (genie #64) — the panel
         *  drops its cached history + activity for that channel or DM pair. */
        agentInboxCleared: (
            cb: (payload: { scope: 'channel' | 'dm'; key: string }) => void,
        ) => () => void;
        /** AgentInbox (Track C): an urgent DM went unACKed past the window — the
         *  panel shows a "waiting on <agent>" oversight alert (cleared when the
         *  same event arrives with `resolved: true`). */
        agentInboxEscalation: (
            cb: (payload: AgentInboxEscalationEvent) => void,
        ) => () => void;
        /** Knowledge Graph: any change (add / update / delete / link), INCLUDING
         *  an agent's MCP write — the window re-fetches its list + graph so the
         *  view stays live. Returns an unsubscribe fn. */
        knowledgeChanged: (
            cb: (payload: {
                action: 'add' | 'update' | 'delete' | 'link';
                id?: string;
            }) => void,
        ) => () => void;
    };
}

declare global {
    interface Window {
        genie: GenieApi;
    }
}

let activeRemoteBridge: GenieApi | null = null;
let remoteBindingResolved = false;

/**
 * Bind THIS WINDOW's api() to local-or-remote ONCE, by the window's OWN binding —
 * NOT a global status swap. Multi-host coexistence depends on this: a HOST window
 * (opened by the factory, loaded with `?host=<connKey>`) routes api() to its host
 * over the bridge for its whole lifetime, while the LOCAL window — and every other
 * host window — is unaffected. There is no `onStatus`-driven global flip, so
 * opening or closing a host can NEVER turn another window remote.
 *
 * The URL `?host=` hint decides SYNCHRONOUSLY (so a host window never flashes the
 * local desktop before an async call resolves); we then confirm against main's
 * authoritative `myBinding()` once and correct any mismatch.
 */
/**
 * The binding mode this window should settle on, given the SYNCHRONOUS URL hint
 * (`?host=` ⇒ a host window) and main's AUTHORITATIVE `myBinding()` mode. PURE →
 * unit-testable (genie#50).
 *
 * A URL host window is authoritatively remote for its WHOLE lifetime and must
 * NEVER be flipped local here: a transient/mismatched `myBinding()` (the conn not
 * yet registered for this wcId, a reload changing the wcId, a dropped confirm)
 * would otherwise null the remote bridge, and `api().files.*` would then run on
 * the CLIENT against the host's POSIX path → `stat 'C:\data\…'` ENOENT on a Linux
 * host. If the host is genuinely gone, staying remote fails with a clear
 * connection error, not a wrong-filesystem read. The async confirm only ever
 * CORRECTS a no-hint window that main says is remote (local → remote).
 */
export function resolveBindingMode(
    isHostWindow: boolean,
    mainMode: 'local' | 'remote',
): 'local' | 'remote' {
    if (isHostWindow) return 'remote';
    return mainMode;
}

function ensureRemoteBinding(local: GenieApi): void {
    if (remoteBindingResolved) return;
    remoteBindingResolved = true;
    const isHostWindow =
        typeof window !== 'undefined' && /[?&]host=/.test(window.location?.search ?? '');
    if (isHostWindow) activeRemoteBridge = makeRemoteBridge(local);
    // Confirm against main (authoritative): a host window stays remote, the local
    // window stays local. Defensive — corrects a stale/absent URL hint. A URL host
    // window is NEVER flipped local by a transient/mismatched binding (genie#50).
    local.remote
        .myBinding()
        .then((b) => {
            activeRemoteBridge =
                resolveBindingMode(isHostWindow, b.mode) === 'remote'
                    ? makeRemoteBridge(local)
                    : null;
        })
        .catch(() => {});
}

/**
 * True when THIS window is a remote HOST window (opened by the host-window factory
 * with `?host=<connKey>`), driving another machine over the bridge. The same
 * synchronous URL signal `ensureRemoteBinding` seeds `api()` from — so callers can
 * cheaply decide "is the terminal here running on a remote host?" without an async
 * `myBinding()` round-trip.
 */
export function isRemoteWindow(): boolean {
    return typeof window !== 'undefined' && /[?&]host=/.test(window.location?.search ?? '');
}

/**
 * The connection key that scopes THIS window's CLIENT-LOCAL per-device state
 * (panel view layout — see `renderer/lib/view-state.ts`). A host window
 * (`?host=<connKey>`) uses that host's key; the local desktop window uses the
 * `'local'` sentinel. Derived SYNCHRONOUSLY from the same URL signal `api()`
 * binds from, so callers never need an async `remote.myBinding()` round-trip to
 * decide which layout bucket to read/write.
 */
export function currentConnKey(): string {
    if (typeof window === 'undefined') return 'local';
    const m = /[?&]host=([^&]*)/.exec(window.location?.search ?? '');
    return m && m[1] ? decodeURIComponent(m[1]) : 'local';
}

export function api(): GenieApi {
    if (typeof window === 'undefined' || !window.genie) {
        throw new Error(
            'window.genie unavailable — preload.ts did not run. Either the page is being rendered outside Electron (e.g. opened directly in a browser) or the preload script failed to compile. Check the Electron main-process console for a load error.',
        );
    }
    ensureRemoteBinding(window.genie);
    return activeRemoteBridge ?? window.genie;
}

/** Returns true when the preload bridge is wired and callable. */
export function hasGenieBridge(): boolean {
    return typeof window !== 'undefined' && !!window.genie;
}

/**
 * Synthetic "System Workspace" — a hardcoded sidebar entry that is NOT a real
 * workspace: it has no project.json and never enters the persisted workspace
 * store. Its `path` is the user's home directory, so terminals/editors opened
 * in it root there. It exists to host SYSTEM PROCESSES — background processes
 * not tied to any project, whose cwd is an arbitrary directory the user picks.
 *
 * The id is a fixed sentinel so the renderer can recognise it everywhere a
 * workspace id flows; it is never written to the DB. System Workspace
 * terminal specs persist with `workspace_id: null` (FK-safe — `__system__`
 * has no `workspaces` row) and a `meta.system === true` tag so the sidebar can
 * group them under the System Workspace rather than the generic Unattached
 * bucket.
 */
export const SYSTEM_WORKSPACE_ID = '__system__';

/** True for the synthetic System Workspace row (see {@link SYSTEM_WORKSPACE_ID}). */
export function isSystemWorkspace(ws: { id: string }): boolean {
    return ws.id === SYSTEM_WORKSPACE_ID;
}

/**
 * The workspace that OWNS a process spec — the lookup the process context menu's
 * "Edit…" needs. Mirrors the sidebar's own bucketing: a System Workspace process
 * persists UNATTACHED ({@link TerminalSpec.workspace_id} `null` + `meta.system`)
 * yet belongs to the System Workspace row, so resolve it there; every other spec
 * resolves by its `workspace_id`. Returns null when no owning workspace is present
 * (e.g. the System Workspace row is hidden), so the caller DECLINES rather than
 * opening a mis-targeted editor.
 *
 * Without the system-spec branch, `find(w => w.id === spec.workspace_id)` on a
 * global process (id `null`) matched nothing and the Edit menu silently did
 * nothing — the reported bug on a `reverb:start` process.
 */
export function processSpecWorkspace<W extends { id: string }>(
    spec: { workspace_id: string | null; meta?: { system?: boolean } | null },
    workspaces: W[],
): W | null {
    if (spec.workspace_id === null && spec.meta?.system === true) {
        return workspaces.find(isSystemWorkspace) ?? null;
    }
    return workspaces.find((w) => w.id === spec.workspace_id) ?? null;
}

/**
 * A workspace does NOT require a Tynn/Aionima project — associating one is
 * optional. When absent, `project_id`/`project_name` are empty, so display the
 * folder's leaf name instead of a blank. (The System Workspace keeps its own
 * non-empty project fields, so this only ever fills in for project-less rows.)
 */
export function workspaceDisplayName(
    ws: Pick<WorkspaceRow, 'project_name' | 'tynn_project_name' | 'path'>,
): string {
    const name = (ws.project_name || ws.tynn_project_name || '').trim();
    if (name) return name;
    const leaf = (ws.path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    return leaf || 'Workspace';
}

/** True when a workspace has no associated project (project association is optional). */
export function hasProjectAssociation(ws: Pick<WorkspaceRow, 'project_id'>): boolean {
    return !!ws.project_id && ws.project_id !== SYSTEM_WORKSPACE_ID;
}

/**
 * A workspace's AgentInbox slug — the base of the `slug:purpose` channel name.
 * Mirrors main's slug resolution FALLBACK: the envelope folder leaf (minus a
 * `.agi` suffix), else the kebab of the project name. This is the renderer-side
 * PREVIEW; the authoritative slug (a Tynn-linked project's real slug) is computed
 * on the host, which owns the backend project record.
 */
export function workspaceSlug(
    ws: Pick<WorkspaceRow, 'path' | 'project_name'>,
): string {
    const leaf = (ws.path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
    const base = leaf.replace(/\.agi$/i, '') || ws.project_name || '';
    return (
        base
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'workspace'
    );
}

/**
 * Build the in-memory System Workspace row. `homePath` is `os.homedir()` from
 * main (see `api().app.homeDir()`). Shaped as a `WorkspaceRow` so it slots into
 * the sidebar's workspace list without special-casing the renderer everywhere,
 * but it is never persisted and has no repos.
 */
export function makeSystemWorkspace(homePath: string): WorkspaceRow {
    return {
        id: SYSTEM_WORKSPACE_ID,
        backend: 'tynn',
        project_id: SYSTEM_WORKSPACE_ID,
        project_name: 'System',
        tynn_project_id: SYSTEM_WORKSPACE_ID,
        tynn_project_name: 'System',
        shape: 'simple',
        path: homePath,
        editor: null,
        editor_cmd: null,
        start_cmd: null,
        env_file: null,
        last_opened_at: null,
        created_by_genie: 0,
        mcp_enabled: 0,
        process_approval: 1,
        terminal_approval: 1,
        schedule_approval: 1,
    };
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
