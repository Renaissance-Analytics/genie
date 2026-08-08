/**
 * Minimal MCP (Model Context Protocol) JSON-RPC handler — just enough to host
 * Genie's agent-integration tools over HTTP without pulling the full SDK. Kept
 * pure (no I/O) so the initialize / tools/list / tools/call flow is unit-testable;
 * the HTTP binding + the per-terminal token registry live in server.ts.
 *
 * Each terminal gets its OWN endpoint whose URL carries a token that resolves to
 * the terminal id, so tools like `imDone` need no argument — the caller's
 * terminal is known from the endpoint. ctx carries that resolved id.
 */

import { GENIE_MCP_GUIDE } from './guide';
import type { QuestionPriority } from '../ask/question-priority';
import type {
    SetEnvRequest,
    SetEnvResult,
    CheckEnvRequest,
    CheckEnvResult,
} from '../env-store';
import type {
    AgentInboxScope,
    AgentInboxAgentInfo,
    AgentInboxAttachment,
    AgentInboxChannelInfo,
    AgentInboxMessage,
} from '../agentinbox/types';
import type {
    KnowledgeNode,
    KnowledgeSearchResult,
} from '../knowledge/types';

export type { SetEnvRequest, SetEnvResult, CheckEnvRequest, CheckEnvResult };
export type { AgentInboxScope, AgentInboxAgentInfo, AgentInboxChannelInfo, AgentInboxMessage };
export type { KnowledgeNode, KnowledgeSearchResult };

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: string | number | null;
    method: string;
    params?: unknown;
}

export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: string | number | null;
    result?: unknown;
    error?: { code: number; message: string };
}

/** One question in a ForceTheQuestion call (mirrors AskUserQuestion). */
export interface ForceQuestion {
    /** Short chip/tag label (≤ ~12 chars). */
    header: string;
    /** The full question text. */
    question: string;
    /** Allow selecting multiple options. Default false (single-select). */
    multiSelect?: boolean;
    /** 2–4 distinct choices. The UI always also offers a free-text note. */
    options: Array<{ label: string; description?: string }>;
}

/** The user's answer to one ForceTheQuestion question. */
export interface ForceAnswer {
    header: string;
    question: string;
    /** Labels the user selected (one for single-select, many for multi). */
    selected: string[];
    /** The always-available free-text note (empty string if untouched). */
    note: string;
}

export interface ForceQuestionResult {
    /** True if the user dismissed the modal without answering. */
    cancelled: boolean;
    answers: ForceAnswer[];
    /**
     * PendingQuestions UX — an agent-facing NOTICE on a cancelled question, set
     * when the modal was never actually shown to the user so the agent isn't left
     * thinking it was a deliberate refusal. Two cases: the user is in DND (the
     * question dropped into the top-bar inbox to answer at leisure), or the modal
     * couldn't be displayed (also routed to the inbox). `cancelled` is true
     * alongside it; the MCP tool returns this text instead of "user dismissed".
     */
    dndMessage?: string;
    /**
     * PendingQuestions UX — true when the question was DEFERRED (DND or a modal that
     * couldn't show) rather than answered inline. The answer, when the user gives it
     * in the top-bar flyout, is delivered LATER to the asking agent's AgentInbox
     * (ping/poll/pull) — so a deferred ForceTheQuestion is not a dead end. `cancelled`
     * is true alongside it; `questionId` correlates the pulled answer to this ask.
     */
    deferred?: boolean;
    /** The deferred question's id — echoed in the AgentInbox delivery so the agent
     *  can match a pulled answer back to the ForceTheQuestion call that asked it. */
    questionId?: string;
}

/** One repo in a workspace map (a member submodule, or the lone simple repo). */
export interface WorkspaceRepoInfo {
    /** Directory name under repos/ (or the basename for a simple workspace). */
    name: string;
    /** Absolute path to the repo's local checkout. */
    path: string;
    /** GitHub owner from the origin remote, if parseable. */
    owner: string | null;
    /** GitHub repo from the origin remote, if parseable. */
    repo: string | null;
    /** Which orientation files exist at the repo root. */
    orientation: {
        readme: boolean;
        agents: boolean;
        claude: boolean;
        /** Detected package manifests (package.json, composer.json, …). */
        manifests: string[];
    };
}

/**
 * The workspace map the `initializeWorkspace` tool hands a fresh agent. The
 * dep (wired in background.ts) does the filesystem + git I/O; the protocol just
 * formats this into guidance. Null when the terminal can't be mapped to a
 * workspace (e.g. an unattached terminal).
 */
export interface WorkspaceMap {
    /** Absolute path to the workspace root. */
    root: string;
    /** True when the root looks like a `.agi` envelope. */
    isAgiEnvelope: boolean;
    hasProjectJson: boolean;
    hasGitmodules: boolean;
    /** Absolute path to `.ai/knowledge` when present, else null. */
    knowledgeDir: string | null;
    /** Absolute path to the envelope's AGENTS.md / CLAUDE.md when present. */
    envelopeAgents: string | null;
    envelopeClaude: string | null;
    repos: WorkspaceRepoInfo[];
    /** The caller's Genie identity, Codex session hook, and installed workflow skills. */
    agentIntegration?: {
        agentType: string | null;
        agentId: string | null;
        chatSessionId: string | null;
        sessionBound: boolean;
        codexSessionHook: {
            configured: boolean;
            scriptPresent: boolean;
            /** Codex owns hook trust; Genie cannot inspect or bypass it. */
            trust: 'unknown';
        } | null;
        installedSkills: string[];
    };
    /** Health of the agent docs (AGENTS.md + Genie MCP section + CLAUDE sync). */
    docHealth?: {
        hasAgents: boolean;
        hasGenieSection: boolean;
        /** missing | symlink | broken-pointer | mirror | divergent */
        claude: string;
        claudeDivergent: boolean;
        healthy: boolean;
    };
}

/**
 * One IssueWatch feed item as the `checkIssues` tool reports it — a flattened
 * WatchItem joined with its repo. `kind` spans the five watched streams; the
 * three security kinds (`dependabot`/`code-scanning`/`secret-scanning`) are
 * aggregated into the {@link IssueWatchCounts.security} bucket but keep their
 * own kind here so the list can group/label them precisely.
 */
export interface IssueWatchItem {
    kind: 'issue' | 'pr' | 'dependabot' | 'code-scanning' | 'secret-scanning';
    owner: string;
    repo: string;
    number: number | null;
    title: string;
    url: string;
    /** Security severity (low|medium|high|critical), where the alert carries one. */
    severity?: string;
    /** True when updated since the workspace was last marked seen. */
    unread: boolean;
}

/** Per-bucket open-item tallies for a workspace (security = the three alert kinds). */
export interface IssueWatchCounts {
    issue: number;
    pr: number;
    /** dependabot + code-scanning + secret-scanning. */
    security: number;
}

/**
 * The IssueWatch snapshot for the caller's workspace, returned by `checkIssues`
 * and folded into the `imDone` response. `connected: false` means no GitHub
 * token is stored; `workspaceResolved: false` means the terminal couldn't be
 * mapped to a workspace.
 */
export interface IssueWatchSnapshot {
    connected: boolean;
    workspaceResolved: boolean;
    serviceState?: 'connecting' | 'connected' | 'signed-out' | 'disabled' | 'disconnected';
    /** False until Tynn has delivered this workspace at least once. */
    knownToServer?: boolean;
    counts: IssueWatchCounts;
    items: IssueWatchItem[];
    /** The user's PER-BUCKET remediation preference (workspace settings), folded
     *  into the imDone count line so the agent knows how to act on EACH bucket.
     *  Omitted (or every OPEN bucket 'surface') reports only; 'fix' /
     *  'fix-and-ship' ask the agent to remediate that bucket when idle. */
    policy?: {
        security: 'surface' | 'fix' | 'fix-and-ship';
        issue: 'surface' | 'fix' | 'fix-and-ship';
        pr: 'surface' | 'fix' | 'fix-and-ship';
    };
}

/** An MCP tool descriptor as `tools/list` returns it (core + plugin tools). */
export interface McpToolDescriptor {
    name: string;
    description: string;
    inputSchema: unknown;
}

/** The MCP `content` result of a `tools/call` (used by the plugin fall-through). */
export interface McpToolCallResult {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}

export interface McpContext {
    /** The terminal id this endpoint is bound to (from the URL token). */
    terminalId: string;
    serverName: string;
    serverVersion: string;
    /** Side effect for the imDone tool — pulse the caller's terminal. */
    onImDone: (terminalId: string) => void;
    /**
     * Resolve the caller's workspace and return its IssueWatch snapshot (open
     * Issues / PRs / security alerts + per-bucket counts) for the `checkIssues`
     * tool AND the counts appended to the `imDone` response. Does the terminal→
     * workspace + db/cache I/O (kept out of this pure module).
     */
    checkIssues: (terminalId: string) => Promise<IssueWatchSnapshot>;
    /** True when the caller's workspace is an Ops project. Gates the ops-only
     *  `provisionWorkspaces` tool out of tools/list for non-Ops workspaces. */
    isOpsProject: (terminalId: string) => Promise<boolean>;
    /**
     * Raise an OS-level always-on-top modal asking the user one or more
     * questions; resolves with their answers (or cancelled). Powers
     * ForceTheQuestion.
     */
    onForceQuestion: (
        terminalId: string,
        questions: ForceQuestion[],
        priority?: QuestionPriority,
    ) => Promise<ForceQuestionResult>;
    /**
     * Map the caller's workspace (root + repos + orientation files) so the
     * `initializeWorkspace` tool can hand a fresh agent a learning plan. Does
     * the filesystem/git I/O (kept out of this pure module). Null when the
     * terminal can't be resolved to a workspace.
     */
    describeWorkspace: (terminalId: string) => Promise<WorkspaceMap | null>;
    /**
     * Manage the caller's workspace background processes (the Genie Processes
     * feature) for the manageProcess tool: list / create / start / stop /
     * restart. Resolves the workspace from the terminal (same fallback as the
     * other tools). Does the db + supervisor I/O (kept out of this pure module).
     */
    manageProcess: (
        terminalId: string,
        req: ManageProcessRequest,
    ) => Promise<ManageProcessResult>;
    /**
     * Provision Genie workspaces for an Ops project's governed children (the
     * provisionWorkspaces tool): a read-only `status` view, or a `provision`
     * action that clones + registers the missing child workspaces. Honours the
     * ops_auto_provision_workspaces toggle — when OFF it blocks on the user's
     * approval (like manageProcess's gate), when ON it provisions directly.
     * Gated to Ops workspaces. Does the Tynn + git + db I/O (kept out here).
     */
    provisionWorkspaces: (
        terminalId: string,
        req: ProvisionWorkspacesRequest,
    ) => Promise<ProvisionWorkspacesResult>;
    /**
     * Serve a repo's dev server from a container in the caller's workspace
     * sandbox and route it at `<name>.gen` (the manageSite tool, #234 P2):
     * detect / list / create / start / stop / restart / status / logs / open /
     * remove. Does the container-runtime + db + Genie-Browser I/O (kept out of
     * this pure module).
     */
    manageSite: (terminalId: string, req: ManageSiteRequest) => Promise<ManageSiteResult>;
    /**
     * Give the caller's workspace a backing service — Postgres, Redis, MySQL,
     * Meilisearch, MinIO, Mailpit, or any image (the manageService tool, #234
     * P3): catalog / list / add / start / stop / status / logs / remove /
     * connection / dedicated. Engines are SHARED per (engine, major version)
     * with a per-workspace database + role + credentials, reference-counted.
     * Does the container-runtime + db I/O (kept out of this pure module).
     * Optional: absent contributes no tool.
     */
    manageService?: (
        terminalId: string,
        req: ManageServiceRequest,
    ) => Promise<ManageServiceResult>;
    /**
     * Is the container Dev Server usable on this machine at all?
     *
     * Gates `manageSite` OUT of `tools/list` when no Docker/Podman is present —
     * the same discipline as the Ops gate on `provisionWorkspaces`, and FAIL
     * CLOSED for the same reason: a tool an agent cannot possibly succeed with
     * is worse than an absent one, because every failure looks like a bug in the
     * agent's own call. Optional: absent contributes no tool.
     */
    devServerAvailable?: (terminalId: string) => Promise<boolean>;
    /**
     * Drive terminals in the caller's workspace OR a workspace it governs (the
     * manageTerminals tool): spawn a pty, write input/keystrokes, read recent
     * output (from a bounded ring buffer), list, kill. create/write are
     * approval-gated per the target workspace's terminal-approval toggle; read/
     * list are read-only. Does the pty + db + gate + cross-workspace
     * authorization I/O (kept out of this pure module).
     */
    manageTerminals: (
        terminalId: string,
        req: ManageTerminalsRequest,
    ) => Promise<ManageTerminalsResult>;
    /**
     * Launch + control a coding agent inside a terminal (the runAgent tool),
     * layered on manageTerminals: start (spawn a terminal + launch claude/codex/
     * custom by its configurable command), send (write a prompt), read (its
     * output), stop. start/send are approval-gated; read is read-only. Does the
     * same pty + gate + authorization I/O.
     */
    runAgent: (
        terminalId: string,
        req: RunAgentRequest,
    ) => Promise<RunAgentResult>;
    /**
     * Full workspace management for an agent (the manageWorkspaces tool): a
     * read-only `status`/`list`, plus `open` / `activate` / `remove` for the
     * caller's own workspace or a governed child. `remove` only UNREGISTERS a
     * workspace from Genie — it never deletes anything on disk. Honours the
     * same cross-workspace authorization.
     */
    manageWorkspaces: (
        terminalId: string,
        req: ManageWorkspacesRequest,
    ) => Promise<ManageWorkspacesResult>;
    /**
     * Local inter-agent messaging (the AgentInbox `agentinbox` tool): discover peers
     * (scope-filtered), DM, channel broadcast, long-poll receive, accessibility.
     * Resolves the caller's AgentInbox identity from the terminal (lazily joining a
     * plain terminal). `receive` + `wait` blocks (long-poll) — server.ts routes it
     * over the SSE keepalive path, like ForceTheQuestion.
     */
    agentInbox: (terminalId: string, req: AgentInboxRequest) => Promise<AgentInboxResult>;
    /**
     * A concise "you have N unread AgentInbox message(s)" nudge for the caller's terminal,
     * folded into the `imDone` response so waiting AgentInbox messages surface at
     * a TURN BOUNDARY (Track A) — the point an agent hands back — without ever
     * writing into its pty. Returns null when there's nothing unread (or the
     * terminal isn't an AgentInbox agent). Optional: consumers that don't wire it just
     * omit the line.
     */
    agentInboxMailLine?: (terminalId: string) => string | null;
    /**
     * The workstation Knowledge Graph (the `knowledge` tool): a workstation-wide,
     * local knowledge/memory store shared across every workspace on this Genie.
     * `search` (FTS keyword retrieval), `get`, `add` (source `agent`), `list`,
     * `link`. Not workspace-scoped — any agent reads/writes the one shared store.
     * Does the sqlite + FTS I/O (kept out of this pure module).
     */
    knowledge: (terminalId: string, req: KnowledgeToolRequest) => Promise<KnowledgeToolResult>;
    /**
     * Open a file in Genie's built-in editor FOR THE USER (the openFileForUser
     * tool): resolve the caller's workspace from the terminal (incl the System
     * workspace), resolve the path (workspace-relative against the root, or
     * absolute), then surface it on the Floor — REUSING an editor panel already
     * open for that workspace, or opening a new one. Benign display action (no
     * gate). Does the workspace/path resolution + the renderer round-trip.
     */
    openFileForUser: (
        terminalId: string,
        req: OpenFileRequest,
    ) => Promise<OpenFileResult>;
    /** Upsert a KEY=value into the caller's workspace `.env` (default) or a repo
     *  `.env` (the `setEnv` tool). Resolves the workspace from the terminal. */
    setEnv: (terminalId: string, req: SetEnvRequest) => SetEnvResult;
    /** Presence/value lookup of a key in the workspace (default) or a repo `.env`
     *  (the `checkEnv` tool), with secret obfuscation by default. */
    checkEnv: (terminalId: string, req: CheckEnvRequest) => CheckEnvResult;
    /**
     * The namespaced tool descriptors contributed by ENABLED plugins (the
     * Plugin System seam, §5.1). Concatenated into `tools/list` AFTER the core
     * tools. Optional + FAIL-CLOSED: absent, or throwing, contributes nothing —
     * a bad/erroring plugin can never remove or corrupt a core tool. Each name
     * is already namespaced (`${namespace}.${tool}`).
     */
    pluginTools?: () => McpToolDescriptor[];
    /**
     * The fall-through for a namespaced plugin tool call (§5.1): resolve the
     * owning enabled plugin, run its handler in the plugin's configured process,
     * and return the MCP result. Contained — it returns an `isError` result
     * rather than throwing, so a bad plugin never sinks the JSON-RPC transport.
     */
    dispatchPluginTool?: (
        name: string,
        args: Record<string, unknown>,
        terminalId: string,
    ) => Promise<McpToolCallResult>;
}

/** A managed background process as the manageProcess tool reports it. */
export interface ManagedProcessInfo {
    id: string;
    label: string;
    command: string;
    /** running | stopped | crashed | restarting | failed | (unknown) */
    status: string;
    autostart: boolean;
    /** cwd relative to the workspace root, or '' for the root. */
    cwd: string;
    /** False when the task is suspended (a disabled scheduled task never fires). */
    enabled: boolean;
    // --- scheduled tasks only (absent on an ordinary process) --------------
    /** The 5-field cron expression. Its PRESENCE means "this is a scheduled task". */
    schedule?: string;
    /** Human rendering of {@link schedule}, e.g. "Daily at 03:00". */
    scheduleDescription?: string;
    scheduleKind?: 'command' | 'agent-nudge';
    /** ISO timestamp of the armed next occurrence; absent when not armed. */
    nextRunAt?: string;
    /** ISO timestamp the last run started. */
    lastRunAt?: string;
    lastRunStatus?: 'ok' | 'failed' | 'skipped';
    /** True while the task is waiting on the user's approval (created, not armed). */
    pendingApproval?: boolean;
}

export interface ManageProcessRequest {
    action:
        | 'list'
        | 'create'
        | 'start'
        | 'stop'
        | 'restart'
        | 'enable'
        | 'disable'
        | 'delete'
        | 'run-now';
    /** create: human label. */
    label?: string;
    /** create: the command line the runner executes. */
    command?: string;
    /** create: a repo subfolder name (repos/<repo>) to run in, else the root. */
    repo?: string;
    /** create: start now + on every launch. Default false. */
    autostart?: boolean;
    /**
     * create: a 5-field cron expression (min hour day-of-month month day-of-week)
     * in the HOST's local time. Supplying it makes the process a SCHEDULED TASK —
     * it runs one-shot on each occurrence instead of as a long-running service.
     */
    schedule?: string;
    /** create + schedule: what a fire does. Default 'command'. */
    scheduleKind?: 'command' | 'agent-nudge';
    /** create + schedule_kind 'agent-nudge': the terminal to nudge. */
    nudgeTerminalId?: string;
    /** create + schedule_kind 'agent-nudge': the AgentInbox agent id to nudge. */
    nudgeAgentId?: string;
    /** create + schedule_kind 'agent-nudge': the prompt delivered on each fire. */
    prompt?: string;
    /** The target process id (the `id` from a prior list) for every non-create action. */
    id?: string;
    /** Deprecated alias for {@link id}, kept for back-compat (issue #7). */
    processId?: string;
}

export interface ManageProcessResult {
    ok: boolean;
    /** Set when ok is false (bad workspace, missing args, unknown id, …). */
    error?: string;
    /** The workspace's processes after the action (always returned on ok). */
    processes: ManagedProcessInfo[];
    /** The process the action targeted/created, when applicable. */
    affectedId?: string;
}

/** One governed child + its local workspace status (provisionWorkspaces). */
export interface OpsChildInfo {
    /** The child's Tynn project id. */
    projectId: string;
    /** The child's Tynn project name. */
    name: string;
    /** present = a local workspace already exists; missing = none yet. */
    status: 'present' | 'missing';
    /** For a missing child: the `*.agi` URL Genie would clone (null if unresolvable). */
    cloneUrl: string | null;
    /**
     * For a missing child with a cloneUrl: whether that repo actually EXISTS on
     * the remote (probed). 'exists' → provisionable; 'not-found' → the envelope
     * was never published — use action 'scaffold'; 'auth-required' → reachable
     * but this Genie's git credentials can't see it; 'unknown' → probe was
     * inconclusive (still attempted on provision). Null when not probed.
     */
    remote?: 'exists' | 'not-found' | 'auth-required' | 'unknown' | null;
    /** The child's registered SOURCE repo (what scaffold builds around), if any. */
    sourceRepoUrl?: string | null;
}

export interface ProvisionWorkspacesRequest {
    /** `status` = read-only list; `provision` = clone existing envelopes;
     *  `scaffold` = CREATE missing envelopes from each child's source repo. */
    action: 'status' | 'provision' | 'scaffold';
}

export interface ProvisionWorkspacesResult {
    ok: boolean;
    /** Set when ok is false (not an ops project, signed out, user denied, …). */
    error?: string;
    /** True only when the caller's workspace is an Ops project. */
    isOps: boolean;
    /** Every governed child + its local status (all actions return it). */
    children: OpsChildInfo[];
    /** provision: the children whose workspace was cloned + registered (by name). */
    provisioned?: string[];
    /** scaffold: the children whose envelope was created + published (by name). */
    scaffolded?: string[];
    /** provision/scaffold: per-child failures (best-effort — one bad child doesn't abort). */
    errors?: string[];
}

// --- manageSite (the Hosting Manager's sites) --------------------------------

/** One hosted site as the `manageSite` tool reports it. */
export interface DevSiteInfo {
    /** The opaque id every non-create action takes back. */
    id: string;
    /** The site's name inside its workspace (a DNS label). */
    name: string;
    /** The browser-facing `.gen` name. */
    genName: string;
    /** The repo subfolder it runs in, or '' for the workspace root. */
    repo: string;
    runMode: string;
    kind: 'http' | 'tcp';
    enabled: boolean;
    /** Whether `<name>.gen` is exposed to real external browsers (story #238). */
    browserExposed?: boolean;
    /** running | stopped | failed */
    state: string;
    /** Whether the published port ACCEPTED a connection. `running` only says
     *  the container is up; this says the production server has bound. */
    ready?: boolean;
    /** The port inside the container. */
    port?: number;
    /** The loopback port the runtime published on the host. */
    hostPort?: number;
    /** The routable origin through the Genie Browser (http sites). */
    origin?: string;
    /** The direct loopback origin (curl, a local browser, another program). */
    localOrigin?: string;
    /** What is being hosted: php | node | static | python | go | rust. */
    stack?: string;
    /** The production server holding the port: frankenphp | node | nginx |
     *  gunicorn | uvicorn | binary. */
    server?: string;
    /** The PRODUCTION BUILD that runs before the server starts. LEGACY — the
     *  sandbox-serve model runs no build. */
    build?: Array<{ label: string; command: string[]; optional?: boolean }>;
    /** The USER-CONTROLLED startup argv Genie runs against the LIVE source inside
     *  the workspace sandbox (`["npm","run","dev"]`, `["php","artisan","serve"]`,
     *  a binary — whatever you choose). This is the model: no forced dev server,
     *  no build. Supersedes {@link serve}. */
    command?: string[];
    /** LEGACY (pre-sandbox-serve): the production server's literal argv. Read as a
     *  fallback for {@link command} for sites saved before the rework. */
    serve?: string[];
    image?: string;
    /** The last build's log. Present on a start that built, success or not — a
     *  failed build is the most common reason a site does not come up. */
    buildLog?: string;
    /** Extra BROWSER-FACING surfaces, as they ended up. A raw one (gRPC/TCP)
     *  carries the stable `hostPort` a client dials. */
    exposed?: Array<{ name: string; protocol: string; genName: string; hostPort?: number }>;
    /** The stored environment, so the human Edit form can prefill it. */
    env?: Record<string, string>;
    /** The Host header sent upstream, when overridden from the `.gen` name. */
    upstreamHost?: string;
    /** The transient start stage, present ONLY while a start is in flight:
     *  `pulling` → `building` → `starting` → `ready`|`failed`. A settled row omits
     *  it — read `state`/`ready` then. Surfaces observable startup (Gap 2). */
    phase?: 'pulling' | 'building' | 'starting' | 'ready' | 'failed';
    error?: string;
}

/** One way a repo could be built and served — a production recipe's offer. */
export interface DevSiteRunOption {
    runMode: string;
    stack?: string;
    /** The production server this would use. */
    server?: string;
    /** The repo file that produced this option. */
    source: string;
    reason: string;
    /** The production build, in order. */
    build?: Array<{ label: string; command: string[]; optional?: boolean }>;
    /** The production server's literal argv. */
    serve?: string[];
    /** The image the SERVER runs in, when it is not the workspace dev image. */
    image?: string;
    port?: number;
    /** False when something load-bearing here was guessed. */
    confident: boolean;
    /** Present when `confident` is false: what you must supply or check. */
    needs?: string;
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
    /** Target workspace. Omit for your own; an Ops agent may pass a governed one. */
    workspaceId?: string;
    /** create: the site name (a DNS label) — also the first `.gen` label. */
    name?: string;
    /** create/detect: a repo subfolder (repos/<repo>); omit for the workspace root. */
    repo?: string;
    /** create: how it is built and served. Omit to take the recommendation, which
     *  is the DEV server run host-native (`host`) — no container, no build. Pass
     *  `recipe`/`dockerfile`/`compose`/`devcontainer` to opt INTO a production
     *  build+serve instead. */
    runMode?: 'dockerfile' | 'devcontainer' | 'compose' | 'recipe' | 'explicit' | 'host';
    /** create: the image the SERVER runs in. Omit for the workspace dev image. */
    image?: string;
    /** create: the PRODUCTION BUILD, in order. LEGACY — the sandbox-serve model
     *  runs no build. */
    build?: Array<{ label?: string; command: string[]; optional?: boolean }>;
    /** create/update: the USER-CONTROLLED startup argv (NOT a shell string) Genie
     *  runs against the LIVE source in the sandbox. The canonical way to start a
     *  site; supersedes {@link serve}. */
    command?: string[];
    /** create: LEGACY production server argv. Prefer {@link command}. */
    serve?: string[];
    /** create: the port the site's command listens on INSIDE the sandbox; Caddy
     *  fronts `.gen` to it over https. */
    port?: number;
    /**
     * create: HOST-NATIVE — point `<name>.gen` straight at a dev server already
     * running as a HOST process on `127.0.0.1:<hostPort>` (e.g. one you started with
     * `manageProcess`), with NO container and NO build. This is the way to just
     * "serve the repo the site points to": run the repo's own dev server on the host
     * and pass its port here. Mutually exclusive with `command`/`serve`/`image`/`build`.
     */
    hostPort?: number;
    /** create: extra BROWSER-FACING surfaces. Backend services never go here. */
    exposed?: Array<{ name: string; port: number; protocol: string; reason: string }>;
    env?: Record<string, string>;
    /** create: `http` (routable at `.gen`) or `tcp` (published + listed only). */
    kind?: 'http' | 'tcp';
    /** create: override the browser-facing `.gen` name. */
    genName?: string;
    /** create: the Host header sent upstream (default: the `.gen` name). */
    upstreamHost?: string;
    /** create: leave it defined but not started. Default true (start it). */
    enabled?: boolean;
    /**
     * create/update (story #238): expose `<name>.gen` to REAL external browsers
     * (Chrome/Edge), not just the in-app Testing Browser. Host-native sites only.
     * On first enable Genie installs its local CA + hosts entry + a host Caddy on
     * `:443` — a ONE-TIME admin prompt. Off by default (the in-app browser needs no
     * setup); turning it off leaves the site running, just not in an external browser.
     */
    browserExposed?: boolean;
    /** Every action except list/detect/create: the site `id` from a prior list. */
    id?: string;
    /** logs: how many lines. */
    tail?: number;
}

export interface ManageSiteResult {
    ok: boolean;
    /** Set when ok is false (no runtime, bad args, unknown id, …). */
    error?: string;
    /** The workspace's sites after the action (always returned on ok). */
    sites: DevSiteInfo[];
    /** The site the action targeted/created. */
    affectedId?: string;
    /** detect/create: every way the repo could be built + served, best first. */
    options?: DevSiteRunOption[];
    /** create: which option was applied, when none was supplied. */
    applied?: DevSiteRunOption;
    /** logs: the container log tail. */
    logs?: string;
    /**
     * create: what Genie did about the framework's Host-header allowlist.
     *
     * A hosted site is addressed as `<name>.gen`, and Django checks that header
     * against `ALLOWED_HOSTS` — answering a 400 from a container that is up,
     * bound and probed healthy. This says whether Genie SOLVED it (something the
     * framework definitely reads) or merely DOCUMENTED it (the repo has to
     * change), so an agent stops guessing at a wall it was told had been
     * removed. Most stacks are now `not-needed`: host allowlists are largely
     * dev-server features, and these sites are served the production way.
     */
    hostAllowlist?: {
        framework: string;
        status: 'solved' | 'documented' | 'not-needed';
        note: string;
        /** On `documented`: the one-field escape, via `upstreamHost`. */
        upstreamHostFallback?: string;
    };
    /** Which container runtime is driving, or why none is. */
    runtime?: { kind: string; version?: string; installHint?: string };
}

// --- manageService (the Dev Server's backing services, #234 P3) --------------

/**
 * One reachable surface of a service, from BOTH sides of the boundary.
 *
 * The distinction is the thing an agent most often gets wrong. `host`/`port`
 * are how a container ON THE WORKSPACE NETWORK dials the engine — its container
 * name, on its real port. `hostPort`/`localAddress` are how THIS MACHINE dials
 * it — loopback, on the published port. A connection string built from the
 * second and handed to a container fails every time.
 */
export interface DevServiceEndpoint {
    /** `postgres`, `s3`, `console`, `smtp`, … */
    name: string;
    kind: 'http' | 'tcp';
    /** From inside the workspace: the engine's container name. */
    host: string;
    /** From inside the workspace: the port the engine really listens on. */
    port: number;
    /** From this machine: the published loopback port. */
    hostPort?: number;
    /** From this machine, ready to paste. */
    localAddress?: string;
}

/** One service as the `manageService` tool reports it. */
export interface DevServiceInfo {
    /** The opaque id every non-add action takes back. */
    id: string;
    engine: string;
    version: string;
    /** `<engine>-<version>` — the unit engines are SHARED by. */
    engineKey: string;
    /** True when this workspace opted out of sharing and runs its own. */
    dedicated: boolean;
    enabled: boolean;
    /** running | stopped | failed */
    state: string;
    /** Whether the engine answered its own readiness check. */
    ready?: boolean;
    /** How many workspaces currently hold this engine (1 when dedicated). */
    holders?: number;
    endpoints?: DevServiceEndpoint[];
    /** The per-workspace names carved out of the engine: the database / role /
     *  ACL user / index prefix, and the DNS form used for an S3 bucket. */
    namespace?: { identifier: string; dnsName: string };
    /** The env keys injected into this workspace's site containers. */
    envKeys?: string[];
    error?: string;
}

/** One engine the catalog offers. */
export interface DevServiceCatalogEntry {
    engine: string;
    label: string;
    summary: string;
    versions: string[];
    defaultVersion: string;
    /** False for the generic escape hatch, which is always dedicated. */
    shared: boolean;
    /** sql-database-role | redis-acl | namespace | none — how a workspace's
     *  slice is carved out, and therefore how strong the isolation is. */
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
        | 'remove'
        | 'connection'
        | 'dedicated'
        /** MACHINE-level: every engine on this workstation, and who holds it. */
        | 'inventory';
    /** Target workspace. Omit for your own; an Ops agent may pass a governed one. */
    workspaceId?: string;
    /** add: which engine (see the `catalog` action). */
    engine?: string;
    /** add: the engine version. Omit for the catalog default. */
    version?: string;
    /** add / dedicated: run this workspace's OWN container instead of sharing. */
    dedicated?: boolean;
    /** add, `custom` engine only: the image to run. */
    image?: string;
    /** add, `custom` engine only: the port it listens on inside the container. */
    port?: number;
    /** add, `custom` engine only: extra environment for the container. */
    env?: Record<string, string>;
    /** add: leave it defined but not started. Default true (start it). */
    enabled?: boolean;
    /** remove: also delete the engine's data volume. Only honoured when no
     *  other workspace is using it. */
    purge?: boolean;
    /** Every action except catalog/list/add: the service `id` from a list. */
    id?: string;
    /** logs: how many lines. */
    tail?: number;
}

/**
 * One shared engine on this MACHINE, as `inventory` reports it.
 *
 * `installed`, `state` and `holders` are three INDEPENDENT facts and every pair
 * of them occurs: an image pulled once and never started (installed, absent); an
 * engine brought up by the container runtime's restart policy before Genie
 * opened (running, zero holders); a workspace that has it defined but disabled
 * (configured, not held). Flattening them into one status is how an agent stops
 * a container five other workspaces are using.
 */
export interface DevServiceEngineInfo {
    /** The CONTAINER's identity — the engine key, or `<engineKey>@<workspaceId>`
     *  for a dedicated one. What a machine-level action names. */
    recordKey: string;
    /** `<engine>-<major>` — the SHARING unit. */
    engineKey: string;
    engine: string;
    version: string;
    label: string;
    image: string;
    containerName: string;
    /** The image is on this machine. Established WITHOUT downloading anything. */
    installed: boolean;
    /** running | stopped | absent. `absent` means no container at all. */
    state: string;
    containerId?: string;
    dedicated: boolean;
    ownerWorkspaceId?: string;
    /** Workspaces holding it RIGHT NOW — the live reference count. */
    holders: number;
    /** Workspaces that have it configured at all, enabled or not. */
    configured: number;
    /** WHO. `holders: 6` is a number; this is the answer. */
    workspaces: string[];
}

export interface ManageServiceResult {
    ok: boolean;
    /** Set when ok is false (no runtime, bad args, unknown id, …). */
    error?: string;
    /** The workspace's services after the action (always returned on ok). */
    services: DevServiceInfo[];
    /** The service the action targeted/created. */
    affectedId?: string;
    /** catalog: every engine on offer. */
    catalog?: DevServiceCatalogEntry[];
    /** inventory: every engine on THIS MACHINE, and who is holding it. */
    engines?: DevServiceEngineInfo[];
    /** logs: the engine's log tail. */
    logs?: string;
    /** connection: the env this workspace's site containers are given. */
    env?: Record<string, string>;
    /** Which container runtime is driving, or why none is. */
    runtime?: { kind: string; version?: string; installHint?: string };
}

// --- manageTerminals ---------------------------------------------------------

/** One terminal as the manageTerminals tool reports it. */
export interface ManagedTerminalInfo {
    id: string;
    /** Spec label, or '' for an ad-hoc terminal with no spec. */
    label: string;
    /** cwd relative to the workspace root, or '' for the root. */
    cwd: string;
    /** True when this terminal is currently running an agent (via runAgent). */
    agent?: 'claude' | 'codex' | 'custom' | null;
    /** The captured AI chat-session uuid for an agent terminal, or null. */
    chatSessionId?: string | null;
}

export interface ManageTerminalsRequest {
    action: 'create' | 'write' | 'read' | 'list' | 'kill';
    /**
     * Target workspace. Omit to act on the caller's own workspace; pass a
     * workspace id the caller GOVERNS (Ops → child) to act there. Any other id
     * is rejected.
     */
    workspaceId?: string;
    /** create (optional): a repo subfolder name (repos/<repo>) to spawn in. */
    repo?: string;
    /** create (optional): an absolute or workspace-relative cwd (overrides repo). */
    cwd?: string;
    /** create (optional): a human label for the new terminal. */
    label?: string;
    /** write | read | kill: the target terminal id (from a prior create/list). */
    id?: string;
    /** write: the text to send to the terminal. By default it is SUBMITTED (a
     *  carriage return is appended; a multi-line body is wrapped in bracketed-
     *  paste markers with the Enter delivered separately so a TUI submits it).
     *  Set `submit:false` to type without submitting. Any trailing newline you
     *  include is ignored — the submit is the appended Enter, never an in-band
     *  newline. */
    data?: string;
    /** write (optional, default true): append an Enter to submit `data`. When
     *  false, the text is delivered with no trailing Enter (type, don't run). */
    submit?: boolean;
    /** write (optional): deliver a single named keypress on its own (no text
     *  needed) — `enter` (submit/clear a stuck buffer), `escape`, or `ctrl-c`. */
    key?: string;
    /** read (optional): continue from this cursor (from a prior read) for "what's
     *  new". Omit for the most recent output. */
    cursor?: number;
    /** read (optional): instead of a cursor, return the last N bytes. */
    bytes?: number;
    /** read (optional): strip ANSI/escape sequences and return readable plain
     *  text instead of raw redraw frames. */
    strip?: boolean;
}

export interface ManageTerminalsResult {
    ok: boolean;
    /** Set when ok is false (denied, bad workspace, unknown id, missing args, …). */
    error?: string;
    /** The target workspace's terminals after the action (always on ok). */
    terminals: ManagedTerminalInfo[];
    /** The terminal the action targeted/created, when applicable. */
    affectedId?: string;
    /** read: the output bytes for this read. */
    data?: string;
    /** read: the cursor to pass to the NEXT read to continue from here. */
    cursor?: number;
    /** read: true when some output was evicted by the buffer cap before this read. */
    dropped?: boolean;
}

// --- runAgent ----------------------------------------------------------------

export type AgentType = 'claude' | 'codex' | 'custom';

export interface RunAgentRequest {
    action: 'start' | 'send' | 'read' | 'stop' | 'restart';
    /** Target workspace (own, or a governed child). Same rules as manageTerminals. */
    workspaceId?: string;
    /** start: which agent CLI to launch. Default 'claude'. */
    agent?: AgentType;
    /** start (custom, or to override): the exact command line to run. Required
     *  for `custom` unless a custom command is configured in Settings. */
    command?: string;
    /** start (optional): a repo subfolder (repos/<repo>) to launch in. */
    repo?: string;
    /** start (optional): an absolute or workspace-relative cwd (overrides repo). */
    cwd?: string;
    /** send | read | stop: the agent terminal id (returned by a prior start). */
    id?: string;
    /** send: the prompt/text to deliver to the running agent. By default it is
     *  SUBMITTED — a multi-line prompt is wrapped in bracketed-paste markers and
     *  the Enter is delivered separately (outside the paste) so the agent's TUI
     *  receives a distinct Enter and submits, instead of leaving it parked as a
     *  "[Pasted text]" buffer. Set `submit:false` to load the prompt without
     *  sending. Empty is allowed when `submit` or `key` is requested (to submit
     *  or clear a stuck buffer). */
    prompt?: string;
    /** send (optional, default true): append an Enter to submit `prompt`. When
     *  false, the prompt is loaded into the agent's input without submitting. */
    submit?: boolean;
    /** send (optional): deliver a single named keypress on its own (no prompt
     *  needed) — `enter` (submit/clear a stuck buffer), `escape`, or `ctrl-c`. */
    key?: string;
    /** read (optional): continue from this cursor (from a prior read). */
    cursor?: number;
    /** read (optional): instead of a cursor, return the last N bytes. */
    bytes?: number;
    /** read (optional): strip ANSI/escape sequences and return readable plain
     *  text instead of raw redraw frames. */
    strip?: boolean;
}

export interface RunAgentResult {
    ok: boolean;
    /** Set when ok is false (denied, no command configured, unknown id, …). */
    error?: string;
    /** start: the new agent terminal's id. */
    id?: string;
    /** start: the agent type launched. */
    agent?: AgentType;
    /** start: the resolved command line that was launched. */
    command?: string;
    /** read: the output bytes for this read. */
    data?: string;
    /** read: the cursor to continue from. */
    cursor?: number;
    /** read: true when buffered output was evicted before this read. */
    dropped?: boolean;
}

// --- manageWorkspaces --------------------------------------------------------

/** One workspace as the manageWorkspaces tool reports it. */
export interface ManagedWorkspaceInfo {
    id: string;
    name: string;
    path: string;
    /** Relationship to the caller: its own workspace, or a governed child. */
    relation: 'self' | 'governed';
}

export interface ManageWorkspacesRequest {
    /**
     * - `list` / `status`: read-only — the caller's workspace + every workspace
     *   it governs.
     * - `open`: open (focus) a workspace window.
     * - `activate`: make a workspace the active one in Genie.
     * - `remove`: UNREGISTER a workspace from Genie (never deletes disk).
     */
    action: 'list' | 'status' | 'open' | 'activate' | 'remove';
    /** Target workspace for open/activate/remove (own or governed). */
    workspaceId?: string;
}

export interface ManageWorkspacesResult {
    ok: boolean;
    /** Set when ok is false (denied, unknown id, …). */
    error?: string;
    /** The caller's workspace + governed children (always on ok). */
    workspaces: ManagedWorkspaceInfo[];
    /** The workspace the action targeted, when applicable. */
    affectedId?: string;
}

// --- agentinbox -----------------------------------------------------------------

export interface AgentInboxRequest {
    /** Public actions plus the Codex SessionStart hook's late identity bind. */
    action:
        | 'list'
        | 'send'
        | 'receive'
        | 'receipts'
        | 'saveAttachment'
        | 'registerSession'
        | 'setAccessibility'
        | 'join'
        | 'leave';
    /** send: DM this agent id (mutually exclusive with `channel`). */
    to?: string;
    /** send/join/leave: a channel — a bare purpose (own workspace) or `slug:purpose`. */
    channel?: string;
    /** send: the message body. */
    text?: string;
    /** send (optional): also nudge a DM target's terminal glow (no pty injection). */
    interrupt?: boolean;
    /** receive (optional): page from this cursor (a prior receive's `cursor`). */
    cursor?: number;
    /** receive (optional): LONG-POLL until a message arrives / you leave / timeout. */
    wait?: boolean;
    /** receive (optional): long-poll window in ms (default ~55s, capped). */
    timeoutMs?: number;
    /** setAccessibility: who can see/DM you. */
    scope?: AgentInboxScope;
    /** setAccessibility (scope `specific`): the workspace ids you're visible to. */
    workspaces?: string[];
    /** setAccessibility (optional): change your channel purpose (re-keys the room). */
    purpose?: string;
    /** setAccessibility (optional): opt in/out of wake-on-DM — a DM to you when idle
     *  injects a nudge to start a turn (issue #9). Default off. */
    wakeOnDm?: boolean;
    /** registerSession: the generated Codex session id from SessionStart stdin. */
    sessionId?: string;
    /** receipts (optional): how many recent sent DMs to report (default 20, cap 100). */
    limit?: number;
    /** send (optional): files to attach — paths inside the SENDER's workspace.
     *  Each is read (workspace-confined, size-capped) and its BYTES stored, so
     *  the recipient never needs access to the sender's disk. */
    attachments?: string[];
    /** saveAttachment: the attachment id from a received message. */
    attachmentId?: string;
    /** saveAttachment (optional): where to write it, inside the CALLER's
     *  workspace. A folder (or a trailing slash) means "land in here". */
    path?: string;
    /** saveAttachment (optional): replace an existing file at that path. */
    overwrite?: boolean;
}

/** One sent-DM read-receipt (AgentInbox `receipts`): the message + whether SEEN. */
export interface AgentInboxReceipt {
    seq: number;
    id: string;
    to: string;
    text: string;
    ts: number;
    seen: boolean;
}

export interface AgentInboxResult {
    ok: boolean;
    /** Set when ok is false (bad args, unreachable target, unknown channel, …). */
    error?: string;
    /** list / setAccessibility: the caller's own agent info. */
    self?: AgentInboxAgentInfo;
    /** list: the peers discoverable by the caller (scope-filtered). */
    agents?: AgentInboxAgentInfo[];
    /** list / join / leave: the caller's channels. */
    channels?: AgentInboxChannelInfo[];
    /** receive: the new messages since the cursor. */
    messages?: AgentInboxMessage[];
    /** receive: the cursor to pass to the NEXT receive. */
    cursor?: number;
    /** send: how many recipients the message reached. On a CHANNEL send this also
     *  rides an `ok: false` result — a broadcast nobody received is a failure, not
     *  a quiet success (genie #65), and the caller still needs the count. */
    delivered?: number;
    /** send (channel): the channel key the message resolved to. */
    channel?: string;
    /** send (channel): the sender was NOT a member and `send` re-added it — its
     *  membership had lapsed, so anything it "reported" in between went nowhere. */
    rejoined?: boolean;
    /** receipts: the caller's recent sent DMs, each with a `seen` flag. */
    receipts?: AgentInboxReceipt[];
    /** send: the files that were stored and attached (echoed back so the sender
     *  can confirm what actually rode the message). */
    attachments?: AgentInboxAttachment[];
    /** saveAttachment: where the file landed, relative to the caller's workspace. */
    savedPath?: string;
    /** saveAttachment: how many bytes were written. */
    savedBytes?: number;
}

// --- knowledge ---------------------------------------------------------------

export interface KnowledgeToolRequest {
    /** `search`, `get`, `add`, `list`, `link`. */
    action: 'search' | 'get' | 'add' | 'list' | 'link';
    /** search: the query text. */
    query?: string;
    /** search / list: cap the number returned. */
    limit?: number;
    /** search (optional): restrict hits to nodes carrying ALL of these tags. */
    tags?: string[];
    /** list (optional): restrict to nodes carrying this tag. */
    tag?: string;
    /** get: the node id. */
    id?: string;
    /** add: the node title (required). */
    title?: string;
    /** add: the markdown body — its `[[wikilink]]`s become edges. */
    body?: string;
    /** add (optional): explicit link targets (a node id, title, or slug). */
    links?: string[];
    /** link: the source node id. */
    from?: string;
    /** link: the target (a node id, title, or slug). */
    to?: string;
}

export interface KnowledgeToolResult {
    ok: boolean;
    /** Set when ok is false (missing args, unknown id, …). */
    error?: string;
    /** search: the ranked hits. */
    results?: KnowledgeSearchResult[];
    /** get: the resolved node, or null when not found. */
    node?: KnowledgeNode | null;
    /** add: the new node's id. */
    id?: string;
    /** list: the nodes. */
    nodes?: KnowledgeNode[];
}

// --- openFileForUser ---------------------------------------------------------

export interface OpenFileRequest {
    /** The file to open — workspace-relative (preferred) or absolute. For the
     *  System workspace, an absolute/system path. */
    path: string;
    /** Optional 1-based line to reveal. */
    line?: number;
}

export interface OpenFileResult {
    ok: boolean;
    /** Set when ok is false (no workspace, file missing, bad path, …). */
    error?: string;
    /** The resolved absolute path that was opened (on ok). */
    file?: string;
    /** The workspace the file was opened in (incl the System workspace). */
    workspaceId?: string;
    /** True when an editor panel already open for the workspace was reused. */
    reused?: boolean;
    /** True when a NEW editor panel was opened (none was open to reuse). */
    openedNew?: boolean;
}

const TERMINAL_ID_PROP = {
    terminalId: {
        type: 'string',
        description:
            "The terminal to act on. Pass the value of your GENIE_TERMINAL_ID environment variable so Genie targets exactly THIS terminal. It is only optional when the workspace has a SINGLE terminal; with several, omitting it is an ERROR rather than a guess — Genie will not pick one for you.",
    },
} as const;

const IMDONE_TOOL = {
    name: 'imDone',
    description:
        "Signal that the agent has finished its work in THIS terminal. Genie pulses the terminal's glow in the workspace rail, the flyout row, and the panel border until you focus it. Pass `terminalId` (from your GENIE_TERMINAL_ID env) to target this exact terminal. Required whenever the workspace has more than one terminal.",
    inputSchema: {
        type: 'object',
        properties: { ...TERMINAL_ID_PROP },
        additionalProperties: false,
    },
};

const CHECK_ISSUES_TOOL = {
    name: 'checkIssues',
    description:
        "Get a detailed list of the open GitHub Issues, Pull Requests, and SECURITY ALERTS (Dependabot, Code-scanning, Secret-scanning) that Genie's IssueWatch is tracking for THIS terminal's workspace — across every repo in the workspace. Use it to see what needs attention before you finish, or whenever you want the current open items with their numbers, titles, severities, and URLs. Read-only. (The same per-bucket counts are also appended to every `imDone` response.) Pass `terminalId` (your GENIE_TERMINAL_ID) for exact workspace resolution; required when the workspace has more than one terminal.",
    inputSchema: {
        type: 'object',
        properties: { ...TERMINAL_ID_PROP },
        additionalProperties: false,
    },
};

const OPEN_FILE_TOOL = {
    name: 'openFileForUser',
    description:
        "Open a file in Genie's BUILT-IN editor for the USER to look at — surfaces it on the Floor in a Code panel. This REUSES an editor panel already open for this workspace (adds the file as a tab and focuses it — or just focuses the tab if the file is already open); if no editor panel is open for the workspace, it opens a NEW one with the file loaded. Use it to put a file in front of the user (a change you made, a result, something to review) instead of only describing it. Benign DISPLAY action — like imDone it just surfaces something, so there is NO approval prompt. `path` is workspace-relative (preferred) or absolute; for the System workspace pass an absolute/system path. A relative path resolves against the WORKSPACE ROOT (not your shell's cwd) and keeps its full subdirectory path; an absolute path inside ANOTHER Genie workspace opens in THAT workspace's editor, and one no workspace owns opens in the System workspace. Optional `line` reveals a 1-based line. Pass `terminalId` (your GENIE_TERMINAL_ID) for exact workspace resolution; required when the workspace has more than one terminal. Available to System-workspace agents too.",
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            path: {
                type: 'string',
                description:
                    'The file to open — workspace-relative (preferred) or absolute. System-workspace agents pass an absolute/system path.',
            },
            line: {
                type: 'number',
                description: 'Optional 1-based line number to reveal.',
            },
        },
        required: ['path'],
        additionalProperties: false,
    },
};

const ENV_TARGET_PROP = {
    target: {
        type: 'string',
        description:
            "Which `.env` to act on. Omit (or 'workspace') for the workspace root `.env`; pass a REPO NAME for `repos/<name>/.env`. Resolved within the workspace (no traversal).",
    },
} as const;

const SET_ENV_TOOL = {
    name: 'setEnv',
    description:
        "Upsert a KEY=value into the workspace's `.env` (default) or a repo's `.env` (`target` = repo name → `repos/<name>/.env`). PRESERVES other lines + comments and CREATES the gitignored `.env` if absent. Use it to record a secret/config the workspace needs (e.g. an API token a tool reads via ${KEY}) — `.env` is gitignored, so this never commits a secret. Returns which `.env` was written. Pass `terminalId` (your GENIE_TERMINAL_ID) for exact workspace resolution. Available to System-workspace agents too.",
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            key: {
                type: 'string',
                description: 'The env var name (A–Z, 0–9, _; starts with a letter or _).',
            },
            value: { type: 'string', description: 'The value to store.' },
            ...ENV_TARGET_PROP,
        },
        required: ['key', 'value'],
        additionalProperties: false,
    },
};

const CHECK_ENV_TOOL = {
    name: 'checkEnv',
    description:
        "Check a key in the workspace's `.env` (default) or a repo's `.env` (`target`). By DEFAULT it's a PRESENCE check (returns `exists` — does the key have a value?) and does NOT reveal the value. Pass `value:true` to return the value — but a value detected as a SECRET (key name like *TOKEN/*SECRET/*PASSWORD/*KEY/*API_KEY, or a token-shaped value) is OBFUSCATED to its last 4 chars (e.g. ••••••3f2a) unless you pass `force:true`. Non-secret values return in full. Use the presence check to decide whether you still need to set something; only `force` a secret when you genuinely need the literal. Pass `terminalId` (your GENIE_TERMINAL_ID) for exact workspace resolution. Available to System-workspace agents too.",
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            key: { type: 'string', description: 'The env var name to look up.' },
            value: {
                type: 'boolean',
                description: 'Return the value (default false → presence check only).',
            },
            force: {
                type: 'boolean',
                description: 'Return the FULL value even for a detected secret (default false → obfuscated).',
            },
            ...ENV_TARGET_PROP,
        },
        required: ['key'],
        additionalProperties: false,
    },
};

const GUIDE_TOOL = {
    name: 'genieGuide',
    description:
        'Return the running Genie version, then the full usage guide for the Genie MCP server (what each tool does, when to use it, and the zero-setup per-terminal contract). Call this to answer "what Genie version am I on", or when you want details beyond the brief in AGENTS.md.',
    inputSchema: {
        type: 'object',
        properties: { ...TERMINAL_ID_PROP },
        additionalProperties: false,
    },
};

/**
 * Workspace orientation is exposed BOTH ways: as an MCP prompt for clients with
 * prompt UIs and as a normal tool for clients such as Codex that surface MCP
 * tools but do not give the user a prompt picker.
 */
export const INITIALIZE_WORKSPACE_PROMPT_NAME = 'initializeWorkspace';
const INITIALIZE_WORKSPACE_TOOL = {
    name: INITIALIZE_WORKSPACE_PROMPT_NAME,
    description:
        'Orient yourself in the current Genie workspace. Returns a map of the .agi envelope and every repo (paths, GitHub refs, orientation files), followed by a numbered learning plan. Call this first in a fresh or newly converted workspace.',
    inputSchema: {
        type: 'object',
        properties: { ...TERMINAL_ID_PROP },
        additionalProperties: false,
    },
};
const INITIALIZE_WORKSPACE_PROMPT = {
    name: INITIALIZE_WORKSPACE_PROMPT_NAME,
    title: 'Initialize workspace',
    description:
        'Orient in this Genie workspace: a map of the .agi envelope + every repo (paths, GitHub refs, orientation files) and a numbered plan for learning the project. Run this on first boot of a fresh/converted workspace.',
    // No required arguments; terminal is resolved from the connection.
    arguments: [],
};

const MANAGE_PROCESS_TOOL = {
    name: 'manageProcess',
    description:
        "Manage this workspace's background processes AND scheduled tasks (Genie's Processes feature). Two shapes, one tool: a PROCESS is a long-running service (dev server, queue worker, SSR) supervised with status + crash auto-restart; a SCHEDULED TASK is the same thing with a `schedule` — it runs one-shot on a cron schedule instead of staying up, and because it lives on the Host it fires whether or not anyone has Genie open, and survives restarts. WHERE THEY RUN: on the HOST machine, NOT inside a workspace container — so a process's `localhost` is the HOST, and a sandboxed `manageSite` site does NOT share its network: reach a host process from a site at `${GENIE_HOST_GATEWAY}:<port>` (an env var manageSite injects), never `127.0.0.1`. Running a process INSIDE a workspace container is not available yet. Actions: `list` (everything + status; scheduled rows also carry `schedule`, `scheduleDescription`, `nextRunAt`, `lastRunAt`, `lastRunStatus`); `create` (register one — needs `label`, plus `command` for a process, optional `repo` to run inside repos/<repo>, optional `autostart` to start it now and on every launch; add `schedule` to make it a scheduled task); `start` / `stop` / `restart` (a service, by `id` from a prior list); `enable` / `disable` (suspend a task without deleting it — a disabled task never fires); `delete`; `run-now` (fire a scheduled task immediately without disturbing its schedule). SCHEDULING: `schedule` is a standard 5-field cron expression — minute hour day-of-month month day-of-week — in the HOST's local timezone, supporting `*`, `*/step`, `a-b` ranges and `a,b,c` lists (e.g. `*/15 * * * *` every 15 minutes, `0 3 * * *` daily at 03:00, `0 9 * * 1-5` weekday mornings). Set `scheduleKind` to `agent-nudge` (with `prompt` and `nudgeTerminalId` or `nudgeAgentId`) to have each fire deliver a prompt to an agent through AgentInbox instead of running a command — the nudge goes to the agent's inbox and only wakes the terminal when it is provably idle, so it can never interrupt a live turn. If a fire comes due while the previous run is still going it is SKIPPED, not overlapped, and runs missed while the Host was down are NOT caught up. SAFETY: creating a scheduled task is APPROVAL-GATED — when the workspace requires it (the default), it blocks on an OS modal showing the command and the recurrence until the user approves; deny means nothing is created. Returns the resulting process list. Pass `terminalId` (your GENIE_TERMINAL_ID) for exact workspace resolution; required when the workspace has more than one terminal.",
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            action: {
                type: 'string',
                enum: [
                    'list',
                    'create',
                    'start',
                    'stop',
                    'restart',
                    'enable',
                    'disable',
                    'delete',
                    'run-now',
                ],
                description: 'What to do.',
            },
            label: {
                type: 'string',
                description: 'create: a human label for the process or scheduled task.',
            },
            command: {
                type: 'string',
                description:
                    'create: the command line the runner executes (e.g. "npm run dev"). Required unless `scheduleKind` is "agent-nudge".',
            },
            repo: {
                type: 'string',
                description:
                    'create (optional): a repo subfolder name to run inside (repos/<repo>); omit to run at the workspace root.',
            },
            autostart: {
                type: 'boolean',
                description:
                    'create (optional): start now and on every launch. Default false. Ignored for a scheduled task — its schedule decides when it runs.',
            },
            schedule: {
                type: 'string',
                description:
                    'create (optional): a 5-field cron expression in the HOST\'s local time — "minute hour day-of-month month day-of-week". Supplying it makes this a SCHEDULED TASK. Supports `*`, `*/step`, `a-b`, `a,b,c`. Examples: "*/15 * * * *" (every 15 min), "0 3 * * *" (daily 03:00), "30 6 * * 1" (Mondays 06:30).',
            },
            scheduleKind: {
                type: 'string',
                enum: ['command', 'agent-nudge'],
                description:
                    'create + `schedule` (optional): "command" (default) runs `command` on each fire; "agent-nudge" delivers `prompt` to an agent through AgentInbox instead.',
            },
            prompt: {
                type: 'string',
                description:
                    'create + `scheduleKind: "agent-nudge"`: the prompt text delivered to the agent on every fire.',
            },
            nudgeTerminalId: {
                type: 'string',
                description:
                    'create + `scheduleKind: "agent-nudge"`: the terminal id to nudge. Prefer this — it is the stable handle.',
            },
            nudgeAgentId: {
                type: 'string',
                description:
                    'create + `scheduleKind: "agent-nudge"`: the AgentInbox agent id to nudge, when the terminal id is not known.',
            },
            id: {
                type: 'string',
                description:
                    'Every action except `list` and `create`: the target id — the `id` field from a `list` result, passed back verbatim.',
            },
            processId: {
                type: 'string',
                description: 'Deprecated alias for `id` (kept for back-compat). Prefer `id`.',
            },
        },
        required: ['action'],
        additionalProperties: false,
    },
};

const PROVISION_WORKSPACES_TOOL = {
    name: 'provisionWorkspaces',
    description:
        "Provision Genie workspaces for the child projects this Ops project governs. ONLY usable from an Ops project's workspace (returns an error elsewhere). An Ops project governs other (child) projects, each with its own `*.agi` envelope repo; this tool stands up a local Genie workspace for any governed child that doesn't have one yet. Actions: `status` (read-only — every governed child with status `present`/`missing`, the `*.agi` URL for each missing one, and `remote` — whether that repo actually EXISTS: `exists` → provisionable, `not-found` → the envelope was never published (use `scaffold`), `auth-required` → this Genie's git credentials can't reach it); `provision` (clone + register a workspace for every missing child whose envelope exists); `scaffold` (for each `remote:'not-found'` child with a registered source repo: build its `<slug>.agi` envelope locally around that source repo, CREATE the GitHub repo, push, and register the workspace — always blocks on your approval in Genie). It's provision-only — it never removes extra or un-governed workspaces. `provision` approval honours the `ops_auto_provision_workspaces` setting; `scaffold` ALWAYS asks. Pass `terminalId` (your GENIE_TERMINAL_ID) for exact workspace resolution; required when the workspace has more than one terminal.",
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            action: {
                type: 'string',
                enum: ['status', 'provision', 'scaffold'],
                description:
                    "status: list governed children + workspace status + whether each missing envelope exists remotely. provision: clone the missing child workspaces whose envelopes exist (honouring the approval toggle). scaffold: create + publish the envelopes that DON'T exist yet from each child's source repo (always approval-gated).",
            },
        },
        required: ['action'],
        additionalProperties: false,
    },
};

const MANAGE_SITE_TOOL = {
    name: 'manageSite',
    description:
        "HOST a repo the way you DEVELOP it — Genie runs its DEV server as a HOST process against the LIVE source (NO container, NO build) and serves it at a stable `https://<name>.gen` origin reachable whether the viewer is on this machine or connected remotely. DEFAULT is dev + host-native — 'just serve the repo the site points to', the way Herd did (Docker is only for services and the opt-in production recipe): a bare `create {name}` detects the stack and runs its OWN dev server — PHP/Laravel → `php artisan serve`; Node (Vite/Next/Nuxt) → the repo's own `npm run dev`; Django → `manage.py runserver`; Go → `go run .`. To be explicit: `command`+`port` runs YOUR dev server; `hostPort` points `.gen` at a dev server you ALREADY run (e.g. one started with `manageProcess`). A PRODUCTION build+serve is OPT-IN via `runMode:'recipe'` (composer --no-dev + FrankenPHP over public/, `npm run build` + next start / nginx over dist/, gunicorn, a Go binary — in a container); a repo's own Dockerfile is `runMode:'dockerfile'`. Actions: `detect` (read a repo and return every build+serve recipe it could use, each with `confident` and, when it is a guess, `needs`); `list` (every site + live state); `create` (define one and host it — `name` (a DNS label) plus either an explicit `build` + `serve` + `port`, or nothing at all to take the detected recipe; optional `repo` to host repos/<repo>, `image`, `env`, `exposed`, `kind`); `update` (edit an existing site by `id` — pass only the fields to change: `name`/`genName`, `port`, `env`, `build`/`serve`, `image`, `runMode`, `exposed`, `upstreamHost`, `kind`; a RUNNING site is rebuilt/restarted only when the change requires it, and left as-is otherwise); `start` / `stop` / `restart` / `status` (by `id` from a prior list); `logs` (the container's log tail); `open` (show the site in the Genie Browser for the user); `remove` (stop it and forget the definition). READ THE RESULT: a failed BUILD is the most common reason a site does not come up, and `buildLog` carries it — a required build step that fails means the site is deliberately NOT started, because serving the previous build while every health signal reads green is worse than not serving. `state:'running'` means the CONTAINER is up; `ready:true` means the published port actually accepted a connection. `origin` is the routable `https://<name>.gen`; `localOrigin` is the direct loopback origin for curl. SERVICES — a host-native dev server runs ON THE HOST, so it reaches a `manageProcess` service and the managed DB/cache on `127.0.0.1:<published port>` — the host-form env (`DATABASE_URL`, …) Genie injects into it, the same env terminals get. (A container-recipe site instead reaches services on the workspace network by engine name; there its `localhost` is the sandbox and a host `manageProcess` service is at `${GENIE_HOST_GATEWAY}:<port>`.) A DATABASE OR CACHE IS NEVER EXPOSED — shared engines are workstation-hosted and reached on the workspace network through the env `manageService` injects (`DATABASE_URL`, …). Only what the BROWSER itself connects to is exposed, via `exposed:[{name,port,protocol,reason}]`: a websocket on the app's own port needs nothing (it upgrades over the existing carrier), one on another port gets `<name>.<site>.gen`, and gRPC/TCP get a STABLE loopback port. A surface that cannot say why the browser needs it is REFUSED. BINDING: bind the dev server to the `port` you give (on `127.0.0.1` or `0.0.0.0`) — a server on a random port `.gen` can't find is the common mistake; a container-recipe server must bind `0.0.0.0`. HOST ALLOWLISTS: upstream is sent `Host: <name>.gen`; Django checks it (`ALLOWED_HOSTS`), so either add the `.gen` name there or pass `upstreamHost:'localhost'`. Host-native dev hosting needs NO Docker; the OPT-IN production recipe (runMode `recipe`/`dockerfile`) and services do — when neither is usable that path's result carries the install hint. `command`, `build` and `serve` are literal argv ([\"npm\",\"run\",\"dev\"]), never shell strings. Pass `terminalId` (your GENIE_TERMINAL_ID) for exact workspace resolution; required when the workspace has more than one terminal.",
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            action: {
                type: 'string',
                enum: [
                    'list',
                    'detect',
                    'create',
                    'update',
                    'start',
                    'stop',
                    'restart',
                    'status',
                    'logs',
                    'open',
                    'remove',
                ],
                description: 'What to do.',
            },
            workspaceId: {
                type: 'string',
                description:
                    'The workspace to act in. Omit for YOUR OWN. An Ops agent may pass a workspace it governs.',
            },
            name: {
                type: 'string',
                description:
                    'create: the site name — a DNS label (`web`, `api`). Becomes the first label of `<name>.<workspace>.gen`. update: rename the site (moves its `.gen` and, if running, its container).',
            },
            repo: {
                type: 'string',
                description:
                    'create/detect (optional): a repo subfolder to run inside (repos/<repo>); omit for the workspace root.',
            },
            runMode: {
                type: 'string',
                enum: ['dockerfile', 'devcontainer', 'compose', 'recipe', 'explicit'],
                description:
                    "create (optional): how it is built and served. OMIT to take the recommendation — the repo's DEV server run HOST-NATIVE (`host`): a host process against live source, no container, no build. `host` runs `command` (or the detected dev command) as a HOST process on `port`. `recipe` opts INTO the detected stack's PRODUCTION build+serve (in a container); `dockerfile` builds the repo's own Dockerfile and runs the image's CMD; `explicit` uses exactly the `build`/`serve`/`image` you pass. `devcontainer` and `compose` are not runnable yet.",
            },
            image: {
                type: 'string',
                description:
                    "create (optional): the image the SERVER runs in — often NOT the one the build ran in (a PHP site builds with Composer and serves from FrankenPHP; a front end builds with npm and serves from nginx). Omit to serve from Genie's multi-language workspace dev image.",
            },
            build: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        label: { type: 'string', description: 'A short human label for this step.' },
                        command: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'LITERAL ARGV, not a shell string.',
                        },
                        optional: {
                            type: 'boolean',
                            description:
                                'A non-zero exit is reported but does NOT fail the build. For steps that are correct to attempt and normal to fail, like collectstatic on a project with no STATIC_ROOT.',
                        },
                    },
                    required: ['command'],
                },
                description:
                    "create (optional): the PRODUCTION BUILD, in order, run in the workspace sandbox before the server starts. A required step that fails means the site is NOT started. Omit to take the detected recipe's build.",
            },
            command: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'create/update: the USER-CONTROLLED startup argv Genie runs against the LIVE source inside the workspace sandbox — LITERAL ARGV, not a shell string: ["npm","run","dev"], ["php","artisan","serve","--host=0.0.0.0"], a binary, anything. Genie makes NO assumptions (no forced dev server, no build). The command must bind `port` on loopback inside the sandbox; Caddy fronts `.gen` to it over https. This is the canonical way to start a site.',
            },
            serve: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'create: LEGACY production server argv (LITERAL ARGV). Read as a fallback for `command` for sites saved before the sandbox-serve rework — prefer `command`.',
            },
            port: {
                type: 'number',
                description:
                    'create: the port the site\'s `command` listens on INSIDE the sandbox (on loopback). Caddy reverse-proxies `<name>.gen` to it over https.',
            },
            exposed: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'A DNS label — becomes `<name>.<site>.gen`.',
                        },
                        port: { type: 'number', description: 'The port INSIDE the container.' },
                        protocol: { type: 'string', enum: ['http', 'ws', 'grpc', 'tcp'] },
                        reason: {
                            type: 'string',
                            description:
                                'REQUIRED: why the BROWSER must reach this. A surface with no reason is refused.',
                        },
                    },
                    required: ['name', 'port', 'protocol', 'reason'],
                },
                description:
                    "create (optional): extra BROWSER-FACING surfaces only. A database, cache or internal API the server calls is NOT one — those are reached on the workspace network through injected env and must never be listed here. A `ws` on the site's own port needs no entry at all: it already upgrades over the `.gen` carrier.",
            },
            env: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description:
                    "create (optional): environment for the container. Merged OVER the recipe's own env and over the services env, so a value you pin always wins.",
            },
            kind: {
                type: 'string',
                enum: ['http', 'tcp'],
                description:
                    "create (optional): `http` (default) is routed at `<name>.gen`; `tcp` is published to loopback and listed, but the browser has nothing to open.",
            },
            genName: {
                type: 'string',
                description:
                    'create (optional): override the browser-facing name. Must end `.gen`. Default `<name>.<workspace>.gen`.',
            },
            upstreamHost: {
                type: 'string',
                description:
                    "create (optional): the Host header sent to the app. Defaults to the `.gen` name so origins line up; set `localhost` when a framework's host allowlist rejects it — served in production, that is Django's ALLOWED_HOSTS.",
            },
            enabled: {
                type: 'boolean',
                description:
                    'create (optional): default true — define, BUILD and serve it. Pass false to define it without building or starting.',
            },
            browserExposed: {
                type: 'boolean',
                description:
                    'create/update (optional): expose `<name>.gen` to REAL external browsers (Chrome/Edge), not just the in-app Testing Browser. Host-native sites only. First enable installs Genie’s local CA + hosts entry + a host Caddy on :443 — a one-time admin prompt. Off by default.',
            },
            id: {
                type: 'string',
                description:
                    'Every action except list/detect/create: the target site `id`, passed back verbatim from a `list` result.',
            },
            tail: {
                type: 'number',
                description: 'logs (optional): how many lines of the container log to return.',
            },
        },
        required: ['action'],
        additionalProperties: false,
    },
};

const MANAGE_SERVICE_TOOL = {
    name: 'manageService',
    description:
        "Give this workspace a backing SERVICE — Postgres, MySQL, Redis, Meilisearch, MinIO (S3), Mailpit, Reverb (WebSockets/broadcasting), or any image — and get back how to connect to it. These are the same engines a hosted site runs against, so a site served by `manageSite` is backed the way production is. THE MODEL, because it changes what you should expect: an engine is WORKSTATION-hosted and SHARED per (engine, major version) across every workspace that asks for it, and each workspace gets its OWN database + role + credentials on it. Ten workspaces on Postgres 16 run ONE postgres container, not ten; a workspace's role cannot reach another workspace's database. The engine starts when the first workspace acquires it and stops when the last one releases it. A workspace that genuinely needs hard isolation (a custom config, an extension, destructive testing) flips `dedicated` and gets its own container — note that shared and dedicated have SEPARATE data volumes, so flipping does not move data. Actions: `catalog` (every engine on offer, its versions, and how strongly each isolates); `inventory` (MACHINE-level — every engine on this WORKSTATION: whether its image is on disk, whether a container exists and is up, how many workspaces hold it right now and WHICH, plus the dedicated ones. Needs no workspace. Read this BEFORE stopping or removing anything: `installed`, `state` and `holders` are three independent facts, and stopping a shared engine stops it for every workspace holding it); `list` (this workspace's services + live state); `add` (`engine` plus optional `version` — defines it, starts the engine, creates this workspace's database/role/credentials, and attaches the engine to this workspace's network); `start` / `stop` / `status` (by `id` from a prior list); `logs` (the engine's log tail); `connection` (the connection surface + the exact env keys injected into this workspace's sites); `dedicated` (flip one service between shared and its own container); `remove` (release it, and with `purge` drop the engine's data volume — refused while another workspace still holds it). READ THE RESULT: `endpoints` carries TWO surfaces and they are not interchangeable — `host`+`port` is how a CONTAINER on this workspace's network dials the engine (its container name, its real port), `localAddress` is how a program on THIS MACHINE dials it (loopback, published port). A connection string built from the second and used inside a container fails every time. A service is BACKEND: it is never given a browser-facing name and never published to the browser, so do not try to expose one through `manageSite`. `envKeys` are already injected into this workspace's hosted sites (`manageSite`), and into their BUILD steps too, so an app served there needs no `.env` edit. Meilisearch, MinIO, Mailpit and Reverb are NAMESPACE-isolated, not credential-isolated: workspaces share the master key/secret and are separated by index prefix / bucket / inbox / Reverb app (each workspace gets its own app whose secret is derived from the shared master, so a site can broadcast but never forge another workspace's app). `custom` takes `image` + `port` + `env` and is always dedicated. Requires Docker or Podman; when neither is usable the result carries the install hint. Pass `terminalId` (your GENIE_TERMINAL_ID) for exact workspace resolution; required when the workspace has more than one terminal.",
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            action: {
                type: 'string',
                enum: [
                    'catalog',
                    'list',
                    'add',
                    'start',
                    'stop',
                    'status',
                    'logs',
                    'remove',
                    'connection',
                    'dedicated',
                    'inventory',
                ],
                description: 'What to do.',
            },
            workspaceId: {
                type: 'string',
                description:
                    'The workspace to act in. Omit for YOUR OWN. An Ops agent may pass a workspace it governs.',
            },
            engine: {
                type: 'string',
                enum: [
                    'postgres',
                    'mysql',
                    'redis',
                    'meilisearch',
                    'minio',
                    'mailpit',
                    'reverb',
                    'custom',
                ],
                description: 'add: which engine. Run `catalog` first if unsure.',
            },
            version: {
                type: 'string',
                description:
                    'add (optional): the engine version, e.g. "16". Omit for the catalog default. This is part of the SHARING key — workspaces on different versions get different containers.',
            },
            dedicated: {
                type: 'boolean',
                description:
                    "add / dedicated: run this workspace's OWN container instead of sharing the engine. Separate data volume — flipping does not move existing data.",
            },
            image: {
                type: 'string',
                description: 'add, `custom` engine only: the image to run.',
            },
            port: {
                type: 'number',
                description:
                    'add, `custom` engine only: the port it listens on INSIDE the container.',
            },
            env: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: 'add, `custom` engine only: environment for the container.',
            },
            enabled: {
                type: 'boolean',
                description:
                    'add (optional): default true — define AND start it. Pass false to define it without starting.',
            },
            purge: {
                type: 'boolean',
                description:
                    "remove (optional): also delete the engine's data volume. Ignored while another workspace still holds the engine.",
            },
            id: {
                type: 'string',
                description:
                    'Every action except catalog/list/add: the target service `id`, passed back verbatim from a `list` result.',
            },
            tail: {
                type: 'number',
                description: 'logs (optional): how many lines of the engine log to return.',
            },
        },
        required: ['action'],
        additionalProperties: false,
    },
};

const TARGET_WORKSPACE_PROP = {
    workspaceId: {
        type: 'string',
        description:
            "The workspace to act in. Omit to act in YOUR OWN workspace. An Ops agent may pass the id of a workspace it GOVERNS (a child project) to act there; any other workspace is rejected.",
    },
} as const;

const MANAGE_TERMINALS_TOOL = {
    name: 'manageTerminals',
    description:
        "Spawn and drive TERMINALS — real shell sessions — in your own workspace, or (for an Ops agent) a workspace you govern. This EXECUTES ARBITRARY CODE: `create` opens a pty, `write` sends input (by default it SUBMITS — an Enter is appended; pass `submit:false` to type without running), and the shell does whatever you tell it. Use it to run builds/tests/scripts and to operate interactive tools. Actions: `create` (spawn a terminal — optional `repo` (repos/<repo>) or `cwd`, optional `label`; returns its id + recent output); `write` (send `data` to terminal `id` — submitted by default; or deliver a single `key` (`enter`/`escape`/`ctrl-c`) on its own, e.g. a bare Enter to submit/clear a stuck buffer); `read` (recent output of `id` — pass a `cursor` from a prior read for just-what's-new, or `bytes` for the last N bytes; add `strip:true` for plain text with ANSI/escape codes removed); `list` (terminals in the workspace); `kill` (terminate `id`). Multi-line input is wrapped in bracketed paste with the Enter delivered separately, so it submits cleanly to a TUI. SAFETY: `create` and `write` are APPROVAL-GATED — when the target workspace requires approval (the default), each blocks on an OS modal until the user approves; when the user has turned approval OFF they run immediately. `read` and `list` never prompt. Output is read from a bounded buffer (oldest bytes age out), so a `read` after a long-running command may report `dropped:true`.",
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            ...TARGET_WORKSPACE_PROP,
            action: {
                type: 'string',
                enum: ['create', 'write', 'read', 'list', 'kill'],
                description: 'What to do.',
            },
            repo: {
                type: 'string',
                description:
                    'create (optional): a repo subfolder to spawn inside (repos/<repo>); omit for the workspace root.',
            },
            cwd: {
                type: 'string',
                description:
                    'create (optional): an absolute or workspace-relative working directory (overrides `repo`).',
            },
            label: {
                type: 'string',
                description: 'create (optional): a human label for the new terminal.',
            },
            id: {
                type: 'string',
                description: 'write | read | kill: the target terminal id (from a create/list).',
            },
            data: {
                type: 'string',
                description:
                    'write: text to send. By default it is SUBMITTED (an Enter is appended; multi-line is wrapped in bracketed paste with the Enter outside it). Set `submit:false` to type without running. May be empty when `submit` or `key` is given.',
            },
            submit: {
                type: 'boolean',
                description:
                    'write (optional, default true): append an Enter to submit `data`. false = type without running.',
            },
            key: {
                type: 'string',
                enum: ['enter', 'escape', 'ctrl-c'],
                description:
                    'write (optional): deliver a single keypress on its own (no `data` needed) — `enter` to submit/clear a stuck buffer, `escape`, or `ctrl-c`.',
            },
            cursor: {
                type: 'number',
                description: 'read (optional): continue from this cursor (from a prior read) for new output.',
            },
            bytes: {
                type: 'number',
                description: 'read (optional): return the last N bytes instead of using a cursor.',
            },
            strip: {
                type: 'boolean',
                description:
                    'read (optional): strip ANSI/escape sequences and return readable plain text instead of raw redraw frames.',
            },
        },
        required: ['action'],
        additionalProperties: false,
    },
};

const RUN_AGENT_TOOL = {
    name: 'runAgent',
    description:
        "Launch and control a CODING AGENT (claude / codex / a custom CLI) inside a terminal — in your own workspace or one you govern. This SPAWNS AN AUTONOMOUS AGENT that can itself read, write, and run code, so it is high-power. A thin layer over manageTerminals. Actions: `start` (open a terminal and launch the agent — `agent` is 'claude' | 'codex' | 'custom', default 'claude'; the actual CLI command is configurable in Genie Settings, or pass an explicit `command` (required for 'custom' unless a custom command is configured); optional `repo`/`cwd`; returns the agent terminal's `id` + the launched command); `send` (deliver a `prompt` to the running agent `id` — SUBMITTED by default, even multi-line: the prompt is wrapped in bracketed paste with the Enter delivered separately so the agent's TUI submits it instead of leaving it parked as a pasted buffer; pass `submit:false` to load without sending, or `key` (`enter`/`escape`/`ctrl-c`) to deliver a bare keypress — e.g. a lone `enter` to submit or clear a stuck multi-line buffer); `read` (its output — `cursor` for new output, or `bytes` for the last N; add `strip:true` for plain text with escape codes removed); `stop` (terminate the agent `id`); `restart` (GRACEFULLY relaunch the agent `id` — resumes the SAME conversation via `--resume` in a fresh terminal, so its TUI reconnects to the current MCP rig / `.mcp.json` after a genie update WITHOUT losing context; claude-only, needs a captured session; returns the NEW terminal `id`). SAFETY: `start`, `send`, and `restart` are APPROVAL-GATED — when the target workspace requires approval (the default) each blocks on an OS modal showing exactly what will launch/run until the user approves; OFF runs immediately. `read` never prompts.",
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            ...TARGET_WORKSPACE_PROP,
            action: {
                type: 'string',
                enum: ['start', 'send', 'read', 'stop', 'restart'],
                description: 'What to do.',
            },
            agent: {
                type: 'string',
                enum: ['claude', 'codex', 'custom'],
                description: "start: which agent CLI to launch. Default 'claude'.",
            },
            command: {
                type: 'string',
                description:
                    "start: the exact command line to launch. Required for 'custom' unless a custom command is configured in Settings; overrides the configured command for claude/codex.",
            },
            repo: {
                type: 'string',
                description: 'start (optional): a repo subfolder (repos/<repo>) to launch in.',
            },
            cwd: {
                type: 'string',
                description: 'start (optional): an absolute or workspace-relative cwd (overrides `repo`).',
            },
            id: {
                type: 'string',
                description: 'send | read | stop | restart: the agent terminal id (from a prior start).',
            },
            prompt: {
                type: 'string',
                description:
                    'send: the prompt/text to deliver to the running agent. SUBMITTED by default (multi-line is wrapped in bracketed paste with the Enter delivered separately so a TUI submits it). Set `submit:false` to load without sending. May be empty when `submit` or `key` is given.',
            },
            submit: {
                type: 'boolean',
                description:
                    'send (optional, default true): append an Enter to submit `prompt`. false = load it into the input without sending.',
            },
            key: {
                type: 'string',
                enum: ['enter', 'escape', 'ctrl-c'],
                description:
                    'send (optional): deliver a single keypress on its own (no `prompt` needed) — `enter` to submit/clear a stuck buffer, `escape`, or `ctrl-c`.',
            },
            cursor: {
                type: 'number',
                description: 'read (optional): continue from this cursor (from a prior read).',
            },
            bytes: {
                type: 'number',
                description: 'read (optional): return the last N bytes instead of a cursor.',
            },
            strip: {
                type: 'boolean',
                description:
                    'read (optional): strip ANSI/escape sequences and return readable plain text instead of raw redraw frames.',
            },
        },
        required: ['action'],
        additionalProperties: false,
    },
};

const MANAGE_WORKSPACES_TOOL = {
    name: 'manageWorkspaces',
    description:
        "Manage Genie WORKSPACES you can act on — your own and (for an Ops agent) the ones you govern. Actions: `list` / `status` (read-only — every workspace you may act on, with its id, name, path, and whether it's your own or a governed child); `open` (open/focus a workspace's window); `activate` (make a workspace the active one in Genie); `remove` (UNREGISTER a workspace from Genie — this only removes it from Genie's list, it NEVER deletes anything on disk). Targets are limited to your own workspace or one you govern; any other is rejected. To CREATE/clone missing child workspaces for an Ops project, use `provisionWorkspaces` instead.",
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            ...TARGET_WORKSPACE_PROP,
            action: {
                type: 'string',
                enum: ['list', 'status', 'open', 'activate', 'remove'],
                description: 'What to do.',
            },
        },
        required: ['action'],
        additionalProperties: false,
    },
};

const AGENTINBOX_TOOL = {
    name: 'agentinbox',
    description:
        "Coordinate with OTHER AI agents running in this Genie instance — AgentInbox, a LOCAL inter-agent messaging network. Discover peer agents (in your workspace, or across the workstation when they allow it), DM them 1:1, broadcast on shared CHANNELS, and ATTACH FILES to a message. Delivery is PULL-based — you FETCH messages; they're never injected mid-turn (which would corrupt it). To await a reply, make ONE blocking `receive` with `wait:true` rather than polling in a loop — it returns the moment a message lands. Actions (`action`): `list` (discovery — returns YOUR agent info `self`, the peers you can reach `agents`, and your `channels`); `send` (message a peer with `to` = their agentId, OR broadcast with `channel` = a purpose like `frontend` (your workspace's room) or `slug:purpose` (another workspace's) — needs `text`; optional `interrupt:true` also glows a DM target's terminal so they notice; optional `attachments` = paths in YOUR workspace to send as files); `receive` (fetch NEW messages — pass a `cursor` from a prior receive to page forward; set `wait:true` to LONG-POLL until a message arrives (optional `timeoutMs`), so you can block waiting for a peer's reply; each message carries `attachments` metadata when files rode it); `saveAttachment` (write a received file into YOUR workspace — `attachmentId` from the message, optional `path` and `overwrite`); `receipts` (read-receipts for the DMs YOU sent — each with a `seen` flag that's true once the recipient has received it, so you can tell 'queued' from 'seen' and decide whether to escalate; optional `limit`, default 20); `setAccessibility` (`scope` — who may DM you: `self` your workspace only (default) / `specific` + `workspaces` a chosen set / `all` the whole workstation / `none` nobody, but you STAY LISTED to peers as unreachable so they can find you and ask / `hidden` nobody, and you're omitted from discovery entirely; optional `purpose` renames your channel); `join`/`leave` (`channel`) to opt in/out of a channel. Attachments are BYTE COPIES stored by Genie, not path references — the recipient may be in a different workspace and never sees your disk. You can only attach files inside your OWN workspace and only save into YOUR OWN; files are size-capped and natively-executable types (.exe/.msi/.bat/…) are refused at both ends. Your identity, accessibility AND channel memberships are remembered across restarts — a channel you joined stays joined until you `leave` it. A channel `send` that reaches NOBODY comes back `ok:false` with `delivered:0` (the text is still kept in the channel history for the human): treat that as NOT REPORTED — check `list` for who's in the room, or DM someone with `to`. Local-only — no relay, no cross-host.",
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            action: {
                type: 'string',
                enum: [
                    'list',
                    'send',
                    'receive',
                    'receipts',
                    'saveAttachment',
                    'registerSession',
                    'setAccessibility',
                    'join',
                    'leave',
                ],
                description: 'What to do.',
            },
            to: {
                type: 'string',
                description: 'send: the recipient agent id (DM). Mutually exclusive with `channel`.',
            },
            attachments: {
                type: 'array',
                items: { type: 'string' },
                description:
                    "send (optional): files to attach — paths inside YOUR OWN workspace (relative, or absolute within it). Genie reads each one and stores its BYTES, so the recipient gets a real copy even though it can't see your disk. Size-capped; natively-executable types (.exe/.msi/.bat/…) are refused. One bad path fails the whole send.",
            },
            attachmentId: {
                type: 'string',
                description:
                    "saveAttachment: the `id` of an attachment from a message you received (or sent). Only someone the message reached can fetch its bytes — the id alone isn't access.",
            },
            path: {
                type: 'string',
                description:
                    'saveAttachment (optional): where to write it, inside YOUR OWN workspace. A folder (or a trailing slash) means "land in here" under the original filename; omit it entirely to save at the workspace root. Escapes (`..`, another workspace, a system path) are refused.',
            },
            overwrite: {
                type: 'boolean',
                description:
                    'saveAttachment (optional): replace an existing file at that path. Default false — a save that would clobber a file fails instead.',
            },
            limit: {
                type: 'number',
                description: 'receipts (optional): how many recent sent DMs to report (default 20, cap 100).',
            },
            wakeOnDm: {
                type: 'boolean',
                description:
                    'setAccessibility (optional): opt in/out of wake-on-DM. When ON, a DM that arrives while you are IDLE (turn ended, prompt empty) injects a one-line nudge so you start a turn and see it — instead of the DM sitting unread until you next act. Fail-safe: never fires mid-turn. Default off.',
            },
            sessionId: {
                type: 'string',
                description:
                    'registerSession: the generated Codex session id supplied by its SessionStart hook.',
            },
            channel: {
                type: 'string',
                description:
                    'send/join/leave: a channel — a bare purpose (`frontend` → your workspace room) or `slug:purpose` (another workspace).',
            },
            text: { type: 'string', description: 'send: the message body.' },
            interrupt: {
                type: 'boolean',
                description:
                    'send (optional): also nudge a DM target — glows their terminal so they notice. Never injected into their pty.',
            },
            cursor: {
                type: 'number',
                description: 'receive (optional): page from this cursor (a prior receive returned it).',
            },
            wait: {
                type: 'boolean',
                description:
                    "receive (optional): LONG-POLL — block until a message arrives, you leave, or the timeout. Delivery WAKES this call the instant a message lands, so ONE blocking call is the right way to await a peer's reply — do NOT sit in a poll loop calling receive over and over. Only re-call if it returns empty (timed out) and you still want to wait.",
            },
            timeoutMs: {
                type: 'number',
                description:
                    'receive (optional): long-poll window in ms (default ~4min, cap 10min). Pass a LARGE value when you expect a slow reply — blocking once beats repeated short polls.',
            },
            scope: {
                type: 'string',
                enum: ['none', 'self', 'specific', 'all', 'hidden'],
                description:
                    "setAccessibility: who may DM you — self (your workspace, default) / specific (a chosen set) / all (the workstation) / none (nobody — but you remain LISTED to peers as unreachable, so they can discover you and request access) / hidden (nobody, and you're omitted from discovery entirely). Your workspace's own access setting still applies on top: it decides which workspaces may reach yours at all.",
            },
            workspaces: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'setAccessibility (scope `specific`): the workspace ids you allow — limited to ones you govern (∪ your own).',
            },
            purpose: {
                type: 'string',
                description: 'setAccessibility (optional): rename your channel purpose (kebab; re-keys your room).',
            },
        },
        required: ['action'],
        additionalProperties: false,
    },
};

const KNOWLEDGE_TOOL = {
    name: 'knowledge',
    description:
        "Read + write Genie's workstation KNOWLEDGE GRAPH — a workstation-wide, LOCAL knowledge/memory store shared across EVERY workspace on this Genie instance (one store, not per-workspace). Use it to STASH durable, reusable context as small markdown \"memory\" nodes and RETRIEVE it on demand — so shared, system-wide knowledge lives here instead of bloating every workspace's AGENTS.md/CLAUDE.md. Nodes link to each other with `[[wikilink]]` references in their body (each becomes a graph edge). Actions (`action`): `search` (keyword retrieval — needs `query`; optional `limit`, `tags` to restrict to nodes carrying ALL those tags — returns ranked `{ id, title, snippet, score, tags }` hits; USE THIS FIRST to check what's already known); `get` (`id` → the full node incl. its linked node ids); `add` (create a node — needs `title`, optional markdown `body` (put `[[wikilink]]`s to related nodes in it), optional `tags`, optional explicit `links` (ids/titles/slugs) → returns the new `id`); `list` (recent nodes — optional `tag`, `limit`); `link` (add an edge from node `from` to `to` (an id, title, or slug)). Search is keyword-based and always available (no setup). Prefer searching before adding a duplicate, and cross-link related memories with `[[wikilink]]`s so the graph stays connected.",
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            action: {
                type: 'string',
                enum: ['search', 'get', 'add', 'list', 'link'],
                description: 'What to do.',
            },
            query: { type: 'string', description: 'search: the text to search for.' },
            limit: {
                type: 'number',
                description: 'search / list (optional): cap the number of results.',
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'search (optional): restrict hits to nodes carrying ALL of these tags.',
            },
            tag: {
                type: 'string',
                description: 'list (optional): restrict to nodes carrying this tag.',
            },
            id: { type: 'string', description: 'get: the node id to fetch.' },
            title: { type: 'string', description: 'add: the node title (required).' },
            body: {
                type: 'string',
                description:
                    'add: the markdown body. Put `[[wikilink]]` references to related nodes in it — each becomes a graph edge.',
            },
            links: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'add (optional): explicit link targets (a node id, title, or slug) — edges in addition to the body\'s `[[wikilink]]`s.',
            },
            from: { type: 'string', description: 'link: the source node id.' },
            to: {
                type: 'string',
                description: 'link: the target to link to (a node id, title, or slug).',
            },
        },
        required: ['action'],
        additionalProperties: false,
    },
};

/**
 * Format a workspace map into the agent-facing orientation: a numbered learning
 * plan (envelope docs first, then each repo's README/AGENTS/CLAUDE + manifest,
 * then how they relate, then summarize back) followed by a machine-parseable
 * JSON block of the map. The repos are framed as the PRIMARY resource.
 */
export function formatWorkspaceMap(map: WorkspaceMap): string {
    const lines: string[] = [];
    lines.push('# Genie workspace — orientation');
    lines.push('');
    lines.push(
        map.isAgiEnvelope
            ? `This is a \`.agi\` envelope at ${map.root}. The repos under \`repos/\` are the PRIMARY resource — learn them first.`
            : `This is a simple (single-repo) workspace at ${map.root}.`,
    );
    lines.push('');

    if (map.repos.length === 0) {
        lines.push('No repos detected yet. Once repos are added, re-run this tool.');
    } else {
        lines.push(
            `## Repos (${map.repos.length}) — the main thing to learn`,
        );
        for (const r of map.repos) {
            const gh = r.owner && r.repo ? ` (${r.owner}/${r.repo})` : '';
            const has = [
                r.orientation.readme && 'README',
                r.orientation.agents && 'AGENTS.md',
                r.orientation.claude && 'CLAUDE.md',
                r.orientation.manifests.length
                    ? `manifest: ${r.orientation.manifests.join(', ')}`
                    : null,
            ]
                .filter(Boolean)
                .join(' · ');
            lines.push(`- **${r.name}**${gh} — ${r.path}`);
            if (has) lines.push(`  has: ${has}`);
        }
    }
    lines.push('');

    lines.push('## How to learn this workspace');
    let n = 1;
    if (map.envelopeAgents || map.envelopeClaude) {
        lines.push(
            `${n++}. Read the envelope's ${
                map.envelopeAgents ? 'AGENTS.md' : 'CLAUDE.md'
            } at the root for the project-wide overview.`,
        );
    }
    if (map.knowledgeDir) {
        lines.push(
            `${n++}. Skim \`.ai/knowledge\` (${map.knowledgeDir}) for shared notes and design docs.`,
        );
    }
    lines.push(
        `${n++}. For EACH repo above, read its README, then its AGENTS.md/CLAUDE.md (if present), then its manifest — to learn its stack, purpose, and available scripts. The repos are the primary resource.`,
    );
    lines.push(
        `${n++}. Note how the repos relate (which is the host/app, which are packages it consumes).`,
    );
    lines.push(
        `${n++}. Set up an on-finish hook so imDone fires automatically every time you hand back — if your harness supports one (Claude Code: a \`Stop\` hook in \`.claude/settings.json\`; Codex: \`notify\` in \`~/.codex/config.toml\`). Wire it to POST a tools/call for imDone to \`$GENIE_MCP_URL\` (passing \`$GENIE_TERMINAL_ID\`). Configure this in YOUR harness's own config yourself — Genie won't edit it. Call \`genieGuide\` for the exact curl snippet. Skip if your harness has no such hook.`,
    );
    lines.push(
        `${n++}. Briefly summarize back to the user what this workspace is and what each repo does, then ask what they'd like to work on.`,
    );

    const integration = map.agentIntegration;
    if (integration) {
        const hookHealthy =
            integration.agentType !== 'codex' ||
            (integration.codexSessionHook?.configured === true &&
                integration.codexSessionHook.scriptPresent === true);
        const healthy = integration.sessionBound && hookHealthy;
        lines.push('');
        lines.push(`## Agent integration — ${healthy ? 'healthy' : 'needs attention'}`);
        if (integration.agentType === 'codex') {
            lines.push(
                integration.sessionBound
                    ? `- Codex session is bound to the existing AgentInbox identity (\`${integration.agentId}\`).`
                    : '- Codex session is not yet bound to its AgentInbox identity. Restart Codex after Genie syncs the workspace integration.',
            );
            const hook = integration.codexSessionHook;
            lines.push(
                hook?.configured && hook.scriptPresent
                    ? '- Codex SessionStart hook is configured and its registration script is present.'
                    : '- Codex SessionStart integration is incomplete. Re-sync Agent MCP for this workspace in Genie settings.',
            );
            lines.push(
                '- Hook trust cannot be verified by Genie. If Codex reports hooks awaiting review, use `/hooks` once; Genie never bypasses trust.',
            );
        } else if (integration.sessionBound) {
            lines.push(`- Session is bound to AgentInbox identity \`${integration.agentId}\`.`);
        } else {
            lines.push('- This agent session is not bound to an AgentInbox identity.');
        }
        lines.push(
            integration.installedSkills.length
                ? `- Focused Genie skills installed: ${integration.installedSkills.map((s) => `\`${s}\``).join(', ')}.`
                : '- No generated Genie workflow skills were detected.',
        );
    }

    // Doc health — flag anything the user may want repaired (the repair is
    // idempotent and available from Genie's Settings → Agent MCP).
    const h = map.docHealth;
    if (h && !h.healthy) {
        lines.push('');
        lines.push('## Doc health — needs attention');
        if (!h.hasAgents) lines.push('- AGENTS.md is MISSING.');
        else if (!h.hasGenieSection) {
            lines.push('- AGENTS.md is missing the Genie MCP section.');
        }
        if (h.claudeDivergent) {
            lines.push(
                '- CLAUDE.md is a SEPARATE, divergent file (not a link/mirror of AGENTS.md) — it may have richer content; do NOT assume it matches AGENTS.md.',
            );
        } else if (h.claude === 'broken-pointer') {
            lines.push(
                '- CLAUDE.md is a broken one-liner (literally "AGENTS.md") and carries no instructions.',
            );
        } else if (h.claude === 'missing') {
            lines.push('- CLAUDE.md is MISSING.');
        }
        lines.push(
            'Run Genie → Settings → Agent MCP → "Repair workspace docs" to fix these (a divergent CLAUDE.md is reported, never clobbered).',
        );
    }

    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(map, null, 2));
    lines.push('```');
    return lines.join('\n');
}

/**
 * The concise IssueWatch counts line appended to an `imDone` response (and
 * usable standalone), e.g. `IssueWatch — issues:3, PR:1, sec:3`. Returns null
 * when there's nothing to report (not connected, no workspace, or zero items),
 * so callers can omit the line entirely rather than print a noisy "none".
 */
export function formatIssueCountsLine(snap: IssueWatchSnapshot): string | null {
    if (!snap.connected || !snap.workspaceResolved) return null;
    if (snap.knownToServer === false) {
        return 'IssueWatch — unknown / not tracking this workspace yet';
    }
    const { issue, pr, security } = snap.counts;
    if (!issue && !pr && !security) return null;
    const base = `IssueWatch — issues:${issue}, PR:${pr}, sec:${security}`;
    // Fold the user's PER-BUCKET remediation preference in so the count line
    // actually steers the agent per bucket. Only buckets with something OPEN get a
    // directive; security is listed first (fix it first — NO bandaids). When every
    // OPEN bucket is 'surface' (or there's no policy at all) the bare counts are
    // kept — backward compatible with the old single-'surface' behaviour.
    const policy = snap.policy;
    if (!policy) return base;
    const active = [
        { label: 'security', count: security, mode: policy.security },
        { label: 'issues', count: issue, mode: policy.issue },
        { label: 'PRs', count: pr, mode: policy.pr },
    ].filter((b) => b.count > 0);
    if (active.every((b) => b.mode === 'surface')) return base;
    const describe = (mode: 'surface' | 'fix' | 'fix-and-ship'): string =>
        mode === 'fix-and-ship'
            ? 'fix at the ROOT CAUSE (NO bandaids) and ship right away'
            : mode === 'fix'
                ? 'fix at the ROOT CAUSE (NO bandaids), then report before shipping'
                : 'surface only (hold)';
    const parts = active.map((b) => `${b.label}: ${describe(b.mode)}`);
    return `${base} · remediation — ${parts.join('; ')} (act on these when no other work is in progress).`;
}

/**
 * PURE. The one-line headline above a `manageSite` result.
 *
 * It leads with the distinction an agent most often gets wrong: a container that
 * is `running` is not the same as a dev server that has BOUND its port. So when
 * a site is running but not ready, the headline says so and says what to do
 * about it, instead of handing back an origin that will 502.
 */
export function manageSiteSummary(result: ManageSiteResult): string {
    if (!result.ok) {
        const hint = result.runtime?.installHint;
        return `manageSite failed: ${result.error ?? 'unknown error'}${hint ? ` ${hint}` : ''}`;
    }
    const target = result.affectedId
        ? result.sites.find((s) => s.id === result.affectedId)
        : undefined;
    if (target) {
        if (target.state === 'failed') {
            return `${target.name} could not start: ${target.error ?? 'unknown error'}`;
        }
        if (target.state !== 'running') {
            return `${target.name} is ${target.state}.`;
        }
        const where = target.origin ?? target.localOrigin ?? '';
        return target.ready
            ? `${target.name} is serving at ${where}.`
            : `${target.name}'s container is up, but nothing is listening on port ${
                  target.port ?? '?'
              } yet — it may still be starting. Check \`logs\`, then \`status\` again before reporting it live.`;
    }
    const running = result.sites.filter((s) => s.state === 'running').length;
    return `${result.sites.length} site${result.sites.length === 1 ? '' : 's'} in this workspace, ${running} running.`;
}

/**
 * PURE. The one-line headline above a `manageService` result.
 *
 * It leads with the two-sided connection surface, because that is the thing an
 * agent gets wrong: the engine's CONTAINER NAME is how the workspace's own
 * containers reach it, and LOOPBACK is how this machine does. Giving only one
 * of them produces a connection string that works in exactly one of the two
 * places somebody will paste it.
 *
 * It also names the holder count, because "three workspaces share this engine"
 * is the sentence that explains why stopping it is not a local decision.
 */
export function manageServiceSummary(result: ManageServiceResult): string {
    if (!result.ok) {
        const hint = result.runtime?.installHint;
        return `manageService failed: ${result.error ?? 'unknown error'}${hint ? ` ${hint}` : ''}`;
    }
    if (result.catalog) {
        return `${result.catalog.length} engines available: ${result.catalog
            .map((e) => `${e.engine} (${e.versions.join(', ')})`)
            .join('; ')}.`;
    }

    const target = result.affectedId
        ? result.services.find((s) => s.id === result.affectedId)
        : undefined;
    if (target) {
        const name = `${target.engine} ${target.version}`;
        if (target.state === 'failed') {
            return `${name} could not start: ${target.error ?? 'unknown error'}`;
        }
        if (target.state !== 'running') return `${name} is ${target.state}.`;
        if (target.ready === false) {
            return `${name}'s container is up but it is NOT ready yet — it may still be initialising. Check \`logs\`, then \`status\` again before connecting.`;
        }
        const primary = target.endpoints?.[0];
        const shared =
            target.dedicated || !target.holders || target.holders < 2
                ? ''
                : ` Shared by ${target.holders} workspaces.`;
        if (!primary) return `${name} is running.${shared}`;
        return (
            `${name} is ready — from this workspace's containers: ${primary.host}:${primary.port}` +
            (primary.localAddress ? `; from this machine: ${primary.localAddress}` : '') +
            (target.envKeys?.length ? `. Injected as ${target.envKeys.join(', ')}` : '') +
            `.${shared}`
        );
    }

    if (result.engines) {
        // The machine-level read's headline has to carry the machine-level
        // facts, or an agent parses JSON to learn the one thing it asked for.
        const up = result.engines.filter((e) => e.state === 'running');
        const held = up.filter((e) => e.holders > 0).length;
        const detail = up
            .map((e) => `${e.engine} ${e.version} (${e.holders} holder${e.holders === 1 ? '' : 's'})`)
            .join('; ');
        return (
            `${up.length} engine${up.length === 1 ? '' : 's'} running on this machine` +
            (detail ? `: ${detail}` : '') +
            `. ${result.engines.length} known, ${held} in use. ` +
            'Stopping a SHARED engine stops it for every workspace holding it.'
        );
    }

    const running = result.services.filter((s) => s.state === 'running').length;
    return `${result.services.length} service${
        result.services.length === 1 ? '' : 's'
    } in this workspace, ${running} running.`;
}

/**
 * The concise AgentInbox nudge folded into an `imDone` response (Track A). Turns
 * an unread summary into e.g. `📬 2 unread AgentInbox message(s) from claude·general,
 * codex — call agentinbox(action:"receive") before you stop.` Returns null when nothing is
 * waiting, so the line is omitted rather than printing a noisy "0".
 */
export function formatAgentInboxMailLine(unread: { count: number; fromLabels: string[] }): string | null {
    if (!unread || unread.count <= 0) return null;
    const who = unread.fromLabels.length ? ` from ${unread.fromLabels.join(', ')}` : '';
    const n = unread.count;
    return `📬 ${n} unread AgentInbox message${n === 1 ? '' : 's'}${who} — call agentinbox(action:"receive") to read ${n === 1 ? 'it' : 'them'} before you stop.`;
}

/** Human label for a feed item kind (used in the grouped checkIssues list). */
const ISSUE_KIND_GROUP: Record<IssueWatchItem['kind'], string> = {
    issue: 'Issues',
    pr: 'Pull Requests',
    dependabot: 'Dependabot alerts',
    'code-scanning': 'Code scanning alerts',
    'secret-scanning': 'Secret scanning alerts',
};

/** Stable display order for the grouped sections. */
const ISSUE_KIND_ORDER: IssueWatchItem['kind'][] = [
    'issue',
    'pr',
    'dependabot',
    'code-scanning',
    'secret-scanning',
];

/**
 * Format an IssueWatch snapshot into a scannable, agent-facing list grouped by
 * kind (Issues / PRs / Dependabot / Code scanning / Secret scanning), each item
 * showing its repo, number, title, severity (for security alerts), unread flag,
 * and URL. Explains clearly when GitHub isn't connected, the terminal maps to
 * no workspace, or there's simply nothing open.
 */
export function formatIssueWatchFeed(snap: IssueWatchSnapshot): string {
    if (!snap.workspaceResolved) {
        return "IssueWatch — couldn't resolve this terminal to a Genie workspace. Pass your GENIE_TERMINAL_ID as `terminalId`, or run this from a terminal inside a workspace.";
    }
    if (!snap.connected) {
        const reason = {
            'signed-out': 'Genie is signed out of Tynn. Sign in to Tynn from Genie Settings.',
            disabled: 'IssueWatch is disabled by the Tynn account entitlement. Manage it at https://tynn.ai/account/issuewatch.',
            connecting: 'Genie is still connecting to the Tynn IssueWatch stream.',
            disconnected: 'The Tynn IssueWatch transport disconnected after startup. Check Tynn broadcasting and network connectivity.',
            connected: 'Genie is connected to the Tynn IssueWatch stream and loading this workspace\'s issues.',
        }[snap.serviceState ?? 'disconnected'];
        return `IssueWatch — unavailable: ${reason} Genie GitHub access is not required.`;
    }
    if (snap.knownToServer === false) {
        return "IssueWatch — Tynn isn't tracking this workspace yet. The feed is unknown, not all-clear; wait for the first server delivery or verify this workspace is registered for IssueWatch.";
    }
    if (snap.items.length === 0) {
        return 'IssueWatch — nothing open across this workspace\'s repos (no Issues, PRs, or security alerts).';
    }
    const { issue, pr, security } = snap.counts;
    const lines: string[] = [
        `IssueWatch — ${issue} issue(s), ${pr} PR(s), ${security} security alert(s) across this workspace's repos:`,
    ];
    for (const kind of ISSUE_KIND_ORDER) {
        const group = snap.items.filter((i) => i.kind === kind);
        if (group.length === 0) continue;
        lines.push('');
        lines.push(`## ${ISSUE_KIND_GROUP[kind]} (${group.length})`);
        for (const it of group) {
            const num = it.number !== null ? `#${it.number}` : '';
            const sev = it.severity ? ` [${it.severity}]` : '';
            const slug = `${it.owner}/${it.repo}`;
            const unread = it.unread ? ' (new)' : '';
            lines.push(`- ${slug} ${num}${sev} ${it.title}${unread}`);
            lines.push(`  ${it.url}`);
        }
    }
    return lines.join('\n');
}

/** One MCP prompt message (the subset we emit: a single text content part). */
export interface PromptMessage {
    role: 'user' | 'assistant';
    content: { type: 'text'; text: string };
}

/**
 * Build the prompts/get messages for the initializeWorkspace prompt. The user
 * invokes the prompt; we return an assistant-authored orientation (the same map
 * + plan formatWorkspaceMap produces) so the agent receives it as context.
 */
export function workspacePromptMessages(map: WorkspaceMap | null): PromptMessage[] {
    if (!map) {
        return [
            {
                role: 'assistant',
                content: {
                    type: 'text',
                    text: "Couldn't resolve this terminal to a Genie workspace. Open this prompt from a terminal inside a workspace and try again.",
                },
            },
        ];
    }
    return [
        {
            role: 'assistant',
            content: { type: 'text', text: formatWorkspaceMap(map) },
        },
    ];
}

const FORCE_QUESTION_TOOL = {
    name: 'ForceTheQuestion',
    description:
        'Ask the user one or more questions via an OS-level, always-on-top modal that floats above every window (not just Genie) and demands an answer before the user continues. Use this when you are blocked and need a decision only the user can make. Batch ALL your open questions into a SINGLE call — each question can offer its own choices, and every question additionally accepts a free-text note, so there is no reason to call this tool more than once in a row. Blocks until the user answers or dismisses; returns the selected option(s) and note for each question.',
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            questions: {
                type: 'array',
                minItems: 1,
                maxItems: 4,
                description: 'The questions to ask (1–4). Batch them — do not call repeatedly.',
                items: {
                    type: 'object',
                    properties: {
                        header: {
                            type: 'string',
                            description: 'Very short label shown as a chip (≤ 12 chars).',
                        },
                        question: {
                            type: 'string',
                            description:
                                'The full question text shown to the user. Rendered as MARKDOWN — write a short lead sentence, then structure detail with blank-line paragraphs, bullet/numbered lists, and **bold** for the key facts. Never pack everything into one run-on paragraph.',
                        },
                        multiSelect: {
                            type: 'boolean',
                            description: 'Allow selecting multiple options. Default false.',
                        },
                        options: {
                            type: 'array',
                            minItems: 2,
                            maxItems: 4,
                            description: 'The 2–4 choices for this question.',
                            items: {
                                type: 'object',
                                properties: {
                                    label: { type: 'string' },
                                    description: {
                                        type: 'string',
                                        description: 'Optional explanation of the choice.',
                                    },
                                },
                                required: ['label'],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ['header', 'question', 'options'],
                    additionalProperties: false,
                },
            },
            priority: {
                type: 'string',
                enum: ['low', 'normal', 'high', 'urgent'],
                description:
                    'Queue priority (default normal). Genie is multi-agent, so several ForceTheQuestion asks can be pending at once; a higher-priority one is answered sooner — but it NEVER preempts the question the user is currently answering. Reserve `urgent` for genuinely blocking asks.',
            },
        },
        required: ['questions'],
        additionalProperties: false,
    },
};

const ok = (id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id: id ?? null,
    result,
});
const err = (
    id: JsonRpcRequest['id'],
    code: number,
    message: string,
): JsonRpcResponse => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/**
 * Handle one JSON-RPC message. Returns the response, or null for notifications
 * (methods with no id / the `notifications/*` namespace) which get a bare 202.
 */
export async function handleMcpMessage(
    msg: JsonRpcRequest,
    ctx: McpContext,
): Promise<JsonRpcResponse | null> {
    // Notifications (e.g. notifications/initialized) carry no id and want no body.
    if (msg.id === undefined || msg.id === null) {
        if (msg.method?.startsWith('notifications/')) return null;
    }

    switch (msg.method) {
        case 'initialize':
            return ok(msg.id, {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: {
                    tools: { listChanged: false },
                    prompts: { listChanged: false },
                },
                serverInfo: { name: ctx.serverName, version: ctx.serverVersion },
                // MCP-native "how to use this server" channel. Mirrors genieGuide.
                instructions: GENIE_MCP_GUIDE,
            });

        case 'notifications/initialized':
            return null;

        case 'ping':
            return ok(msg.id, {});

        case 'tools/list': {
            // `provisionWorkspaces` is meaningful ONLY for an Ops project's
            // workspace (it stands up workspaces for the project's governed
            // children); a non-Ops caller just gets a "not an ops project" error.
            // List it ONLY for an Ops caller — fail CLOSED (omit it) on any error
            // so a non-Ops / uncertain workspace never sees the ops tool.
            const isOps = await ctx.isOpsProject(ctx.terminalId).catch(() => false);
            // Enabled-plugin tools ride the SAME list, namespaced, AFTER the core
            // tools. Fail CLOSED: a throwing plugin registry contributes nothing
            // (never poisons the core surface — same discipline as the ops gate).
            let pluginTools: McpToolDescriptor[] = [];
            try {
                pluginTools = ctx.pluginTools?.() ?? [];
            } catch {
                pluginTools = [];
            }
            // `manageSite` now hosts DEV sites HOST-NATIVE (no container), so it is
            // ALWAYS available — an agent can serve a repo with just Node/PHP on the
            // host. Only the OPT-IN production recipe and `manageService` need a
            // container runtime; the probe (fail CLOSED) gates ONLY manageService, so
            // a machine with no Docker never sees a tool whose every call would fail.
            const hasContainerRuntime = await (
                ctx.devServerAvailable?.(ctx.terminalId) ?? Promise.resolve(false)
            ).catch(() => false);
            return ok(msg.id, {
                tools: [
                    IMDONE_TOOL,
                    CHECK_ISSUES_TOOL,
                    FORCE_QUESTION_TOOL,
                    MANAGE_PROCESS_TOOL,
                    ...(isOps ? [PROVISION_WORKSPACES_TOOL] : []),
                    MANAGE_SITE_TOOL,
                    ...(hasContainerRuntime && ctx.manageService ? [MANAGE_SERVICE_TOOL] : []),
                    MANAGE_TERMINALS_TOOL,
                    RUN_AGENT_TOOL,
                    MANAGE_WORKSPACES_TOOL,
                    AGENTINBOX_TOOL,
                    KNOWLEDGE_TOOL,
                    OPEN_FILE_TOOL,
                    SET_ENV_TOOL,
                    CHECK_ENV_TOOL,
                    INITIALIZE_WORKSPACE_TOOL,
                    GUIDE_TOOL,
                    ...pluginTools,
                ],
            });
        }

        case 'prompts/list':
            return ok(msg.id, { prompts: [INITIALIZE_WORKSPACE_PROMPT] });

        case 'prompts/get': {
            const name = (msg.params as { name?: string } | undefined)?.name;
            if (name !== INITIALIZE_WORKSPACE_PROMPT_NAME) {
                return err(msg.id, -32602, `Unknown prompt: ${String(name)}`);
            }
            const map = await ctx.describeWorkspace(ctx.terminalId);
            return ok(msg.id, {
                description: INITIALIZE_WORKSPACE_PROMPT.description,
                messages: workspacePromptMessages(map),
            });
        }

        case 'tools/call': {
            const params = (msg.params ?? {}) as {
                name?: string;
                arguments?: {
                    questions?: ForceQuestion[];
                    priority?: QuestionPriority;
                } & Partial<ManageProcessRequest>;
            };
            if (params.name === 'imDone') {
                ctx.onImDone(ctx.terminalId);
                // Fold the caller's workspace IssueWatch counts into the response
                // so every "done" surfaces what's still open (issues/PRs/security
                // alerts) without a second call. Best-effort: a snapshot failure
                // never sinks the imDone ack.
                let countsLine: string | null = null;
                try {
                    countsLine = formatIssueCountsLine(
                        await ctx.checkIssues(ctx.terminalId),
                    );
                } catch {
                    /* best-effort — the glow is the point, counts are a bonus */
                }
                // Track A — surface any waiting AgentInbox mail at this turn
                // boundary so a queued ping actually LANDS (agents call imDone at
                // every finish). No pty injection — it rides the tool response.
                let mailLine: string | null = null;
                try {
                    mailLine = ctx.agentInboxMailLine?.(ctx.terminalId) ?? null;
                } catch {
                    /* best-effort */
                }
                const base =
                    'Done — this terminal is now glowing in Genie until you focus it.';
                const extras = [countsLine, mailLine].filter(Boolean).join('\n');
                return ok(msg.id, {
                    content: [
                        {
                            type: 'text',
                            text: extras ? `${base}\n\n${extras}` : base,
                        },
                    ],
                });
            }
            if (params.name === 'checkIssues') {
                const snap = await ctx.checkIssues(ctx.terminalId);
                return ok(msg.id, {
                    content: [{ type: 'text', text: formatIssueWatchFeed(snap) }],
                });
            }
            if (params.name === 'genieGuide') {
                // The version otherwise only reaches an agent through `initialize`'s
                // serverInfo, which most harnesses swallow. Lead with it so asking
                // the guide also answers "which Genie build am I on".
                return ok(msg.id, {
                    content: [
                        {
                            type: 'text',
                            text: `Genie version: ${ctx.serverVersion}\n\n${GENIE_MCP_GUIDE}`,
                        },
                    ],
                });
            }
            if (params.name === INITIALIZE_WORKSPACE_PROMPT_NAME) {
                const map = await ctx.describeWorkspace(ctx.terminalId);
                const text = workspacePromptMessages(map)
                    .map((message) => message.content.text)
                    .join('\n\n');
                return ok(msg.id, {
                    content: [{ type: 'text', text }],
                });
            }
            if (params.name === 'manageProcess') {
                const a = params.arguments ?? {};
                const action = a.action;
                const ACTIONS: ReadonlyArray<ManageProcessRequest['action']> = [
                    'list',
                    'create',
                    'start',
                    'stop',
                    'restart',
                    'enable',
                    'disable',
                    'delete',
                    'run-now',
                ];
                if (!action || !ACTIONS.includes(action)) {
                    return err(
                        msg.id,
                        -32602,
                        `manageProcess requires \`action\`: ${ACTIONS.join(' | ')}.`,
                    );
                }
                const result = await ctx.manageProcess(ctx.terminalId, {
                    action,
                    label: a.label,
                    command: a.command,
                    repo: a.repo,
                    autostart: a.autostart,
                    schedule: a.schedule,
                    scheduleKind: a.scheduleKind,
                    prompt: a.prompt,
                    nudgeTerminalId: a.nudgeTerminalId,
                    nudgeAgentId: a.nudgeAgentId,
                    // `list` reports each process keyed `id`, so accept `id` as the
                    // primary field (what callers naturally copy back); `processId`
                    // stays a back-compat alias. This mismatch was issue #7.
                    processId: a.id ?? a.processId,
                });
                const summary = result.ok
                    ? `${result.processes.length} process${result.processes.length === 1 ? '' : 'es'} in this workspace${
                          result.affectedId ? ` (acted on ${result.affectedId})` : ''
                      }.`
                    : `manageProcess failed: ${result.error ?? 'unknown error'}`;
                return ok(msg.id, {
                    content: [
                        {
                            type: 'text',
                            text: `${summary}\n\n${JSON.stringify(result, null, 2)}`,
                        },
                    ],
                });
            }
            if (params.name === 'manageSite') {
                const a = (params.arguments ?? {}) as Partial<ManageSiteRequest>;
                const ACTIONS: ReadonlyArray<ManageSiteRequest['action']> = [
                    'list',
                    'detect',
                    'create',
                    'update',
                    'start',
                    'stop',
                    'restart',
                    'status',
                    'logs',
                    'open',
                    'remove',
                ];
                if (!a.action || !ACTIONS.includes(a.action)) {
                    return err(
                        msg.id,
                        -32602,
                        `manageSite requires \`action\`: ${ACTIONS.join(' | ')}.`,
                    );
                }
                const result = await ctx.manageSite(ctx.terminalId, {
                    action: a.action,
                    workspaceId: a.workspaceId,
                    name: a.name,
                    repo: a.repo,
                    runMode: a.runMode,
                    image: a.image,
                    build: a.build,
                    command: a.command,
                    serve: a.serve,
                    port: a.port,
                    exposed: a.exposed,
                    env: a.env,
                    kind: a.kind,
                    genName: a.genName,
                    upstreamHost: a.upstreamHost,
                    enabled: a.enabled,
                    browserExposed: a.browserExposed,
                    id: a.id,
                    tail: a.tail,
                });
                return ok(msg.id, {
                    content: [
                        {
                            type: 'text',
                            text: `${manageSiteSummary(result)}\n\n${JSON.stringify(result, null, 2)}`,
                        },
                    ],
                });
            }
            if (params.name === 'manageService') {
                const a = (params.arguments ?? {}) as Partial<ManageServiceRequest>;
                const ACTIONS: ReadonlyArray<ManageServiceRequest['action']> = [
                    'catalog',
                    'list',
                    'add',
                    'start',
                    'stop',
                    'status',
                    'logs',
                    'remove',
                    'connection',
                    'dedicated',
                    'inventory',
                ];
                if (!a.action || !ACTIONS.includes(a.action)) {
                    return err(
                        msg.id,
                        -32602,
                        `manageService requires \`action\`: ${ACTIONS.join(' | ')}.`,
                    );
                }
                if (!ctx.manageService) {
                    return err(
                        msg.id,
                        -32601,
                        'The Genie Dev Server is not running in this process, so services cannot be managed here.',
                    );
                }
                const result = await ctx.manageService(ctx.terminalId, {
                    action: a.action,
                    workspaceId: a.workspaceId,
                    engine: a.engine,
                    version: a.version,
                    dedicated: a.dedicated,
                    image: a.image,
                    port: a.port,
                    env: a.env,
                    enabled: a.enabled,
                    purge: a.purge,
                    id: a.id,
                    tail: a.tail,
                });
                return ok(msg.id, {
                    content: [
                        {
                            type: 'text',
                            text: `${manageServiceSummary(result)}\n\n${JSON.stringify(result, null, 2)}`,
                        },
                    ],
                });
            }
            if (params.name === 'provisionWorkspaces') {
                const a = params.arguments ?? {};
                const action = (a as Partial<ProvisionWorkspacesRequest>).action;
                if (action !== 'status' && action !== 'provision' && action !== 'scaffold') {
                    return err(
                        msg.id,
                        -32602,
                        'provisionWorkspaces requires `action`: status | provision | scaffold.',
                    );
                }
                const result = await ctx.provisionWorkspaces(ctx.terminalId, {
                    action,
                });
                let summary: string;
                if (!result.ok) {
                    summary = `provisionWorkspaces failed: ${result.error ?? 'unknown error'}`;
                } else if (!result.isOps) {
                    summary =
                        'This workspace is not an Ops project — provisionWorkspaces only works from an Ops project that governs child projects.';
                } else {
                    const missing = result.children.filter((c) => c.status === 'missing').length;
                    const present = result.children.length - missing;
                    const unscaffolded = result.children.filter(
                        (c) => c.status === 'missing' && c.remote === 'not-found',
                    ).length;
                    const head = `${result.children.length} governed child project${
                        result.children.length === 1 ? '' : 'ren'
                    } — ${present} present, ${missing} missing${
                        unscaffolded
                            ? ` (${unscaffolded} with NO published envelope — needs action:"scaffold")`
                            : ''
                    }.`;
                    const tail =
                        action === 'provision'
                            ? ` Provisioned ${result.provisioned?.length ?? 0}${
                                  result.errors?.length ? `, ${result.errors.length} error(s)` : ''
                              }.`
                            : action === 'scaffold'
                              ? ` Scaffolded ${result.scaffolded?.length ?? 0}${
                                    result.errors?.length ? `, ${result.errors.length} error(s)` : ''
                                }.`
                              : '';
                    summary = head + tail;
                }
                return ok(msg.id, {
                    content: [
                        {
                            type: 'text',
                            text: `${summary}\n\n${JSON.stringify(result, null, 2)}`,
                        },
                    ],
                });
            }
            if (params.name === 'manageTerminals') {
                const a = (params.arguments ?? {}) as Partial<ManageTerminalsRequest>;
                const action = a.action;
                if (
                    action !== 'create' &&
                    action !== 'write' &&
                    action !== 'read' &&
                    action !== 'list' &&
                    action !== 'kill'
                ) {
                    return err(
                        msg.id,
                        -32602,
                        'manageTerminals requires `action`: create | write | read | list | kill.',
                    );
                }
                const result = await ctx.manageTerminals(ctx.terminalId, {
                    action,
                    workspaceId: a.workspaceId,
                    repo: a.repo,
                    cwd: a.cwd,
                    label: a.label,
                    id: a.id,
                    data: a.data,
                    submit: a.submit,
                    key: a.key,
                    cursor: a.cursor,
                    bytes: a.bytes,
                    strip: a.strip,
                });
                const summary = result.ok
                    ? action === 'read'
                        ? `Read ${result.data?.length ?? 0} byte(s)${result.dropped ? ' (some earlier output was dropped)' : ''}.`
                        : `${result.terminals.length} terminal${result.terminals.length === 1 ? '' : 's'} in the workspace${
                              result.affectedId ? ` (acted on ${result.affectedId})` : ''
                          }.`
                    : `manageTerminals failed: ${result.error ?? 'unknown error'}`;
                return ok(msg.id, {
                    content: [
                        {
                            type: 'text',
                            text: `${summary}\n\n${JSON.stringify(result, null, 2)}`,
                        },
                    ],
                });
            }
            if (params.name === 'runAgent') {
                const a = (params.arguments ?? {}) as Partial<RunAgentRequest>;
                const action = a.action;
                if (
                    action !== 'start' &&
                    action !== 'send' &&
                    action !== 'read' &&
                    action !== 'stop' &&
                    action !== 'restart'
                ) {
                    return err(
                        msg.id,
                        -32602,
                        'runAgent requires `action`: start | send | read | stop | restart.',
                    );
                }
                const result = await ctx.runAgent(ctx.terminalId, {
                    action,
                    workspaceId: a.workspaceId,
                    agent: a.agent,
                    command: a.command,
                    repo: a.repo,
                    cwd: a.cwd,
                    id: a.id,
                    prompt: a.prompt,
                    submit: a.submit,
                    key: a.key,
                    cursor: a.cursor,
                    bytes: a.bytes,
                    strip: a.strip,
                });
                let summary: string;
                if (!result.ok) {
                    summary = `runAgent failed: ${result.error ?? 'unknown error'}`;
                } else if (action === 'start') {
                    summary = `Launched ${result.agent ?? 'agent'} (${result.command ?? ''}) as terminal ${result.id ?? '?'}.`;
                } else if (action === 'read') {
                    summary = `Read ${result.data?.length ?? 0} byte(s)${result.dropped ? ' (some earlier output was dropped)' : ''}.`;
                } else {
                    summary = `runAgent ${action} ok${result.id ? ` (${result.id})` : ''}.`;
                }
                return ok(msg.id, {
                    content: [
                        {
                            type: 'text',
                            text: `${summary}\n\n${JSON.stringify(result, null, 2)}`,
                        },
                    ],
                });
            }
            if (params.name === 'manageWorkspaces') {
                const a = (params.arguments ?? {}) as Partial<ManageWorkspacesRequest>;
                const action = a.action;
                if (
                    action !== 'list' &&
                    action !== 'status' &&
                    action !== 'open' &&
                    action !== 'activate' &&
                    action !== 'remove'
                ) {
                    return err(
                        msg.id,
                        -32602,
                        'manageWorkspaces requires `action`: list | status | open | activate | remove.',
                    );
                }
                const result = await ctx.manageWorkspaces(ctx.terminalId, {
                    action,
                    workspaceId: a.workspaceId,
                });
                const summary = result.ok
                    ? `${result.workspaces.length} workspace${result.workspaces.length === 1 ? '' : 's'} you can act on${
                          result.affectedId ? ` (acted on ${result.affectedId})` : ''
                      }.`
                    : `manageWorkspaces failed: ${result.error ?? 'unknown error'}`;
                return ok(msg.id, {
                    content: [
                        {
                            type: 'text',
                            text: `${summary}\n\n${JSON.stringify(result, null, 2)}`,
                        },
                    ],
                });
            }
            if (params.name === 'agentinbox') {
                const a = (params.arguments ?? {}) as Partial<AgentInboxRequest>;
                const action = a.action;
                if (
                    action !== 'list' &&
                    action !== 'send' &&
                    action !== 'receive' &&
                    action !== 'receipts' &&
                    action !== 'saveAttachment' &&
                    action !== 'registerSession' &&
                    action !== 'setAccessibility' &&
                    action !== 'join' &&
                    action !== 'leave'
                ) {
                    return err(
                        msg.id,
                        -32602,
                        'agentinbox requires `action`: list | send | receive | receipts | saveAttachment | registerSession | setAccessibility | join | leave.',
                    );
                }
                const result = await ctx.agentInbox(ctx.terminalId, {
                    action,
                    to: a.to,
                    channel: a.channel,
                    text: a.text,
                    interrupt: a.interrupt,
                    cursor: a.cursor,
                    wait: a.wait,
                    timeoutMs: a.timeoutMs,
                    scope: a.scope,
                    workspaces: a.workspaces,
                    purpose: a.purpose,
                    sessionId: a.sessionId,
                    wakeOnDm: a.wakeOnDm,
                    limit: a.limit,
                    attachments: a.attachments,
                    attachmentId: a.attachmentId,
                    path: a.path,
                    overwrite: a.overwrite,
                });
                let summary: string;
                if (!result.ok) {
                    summary = `agentinbox failed: ${result.error ?? 'unknown error'}`;
                } else if (action === 'list') {
                    // The directory now includes peers you can SEE but not message
                    // (`reachable: false`), so report both counts — "N agents" alone
                    // would imply you can DM all of them.
                    const found = result.agents ?? [];
                    const reachable = found.filter((x) => x.reachable).length;
                    const blocked = found.length - reachable;
                    summary =
                        `${reachable} agent(s) reachable` +
                        (blocked > 0 ? `, ${blocked} visible but unavailable` : '') +
                        `, ${result.channels?.length ?? 0} channel(s).`;
                } else if (action === 'receive') {
                    // Attachments are easy to miss inside a JSON blob, and a file
                    // an agent never notices is a file that was never sent — so
                    // the one-line summary says outright that one arrived.
                    const files = (result.messages ?? []).reduce(
                        (n, m) => n + (m.attachments?.length ?? 0),
                        0,
                    );
                    summary =
                        `${result.messages?.length ?? 0} new message(s).` +
                        (files > 0
                            ? ` ${files} file(s) attached — use saveAttachment with an attachment id to write one into your workspace.`
                            : '');
                } else if (action === 'send') {
                    // A lapsed membership is worth saying out loud even on a
                    // SUCCESSFUL send: it means the sender was out of the room for
                    // a while, so anything it "reported" in between went nowhere.
                    const files = result.attachments?.length ?? 0;
                    summary =
                        `Sent — delivered to ${result.delivered ?? 0} recipient(s).` +
                        (files > 0 ? ` ${files} file(s) attached.` : '') +
                        (result.rejoined
                            ? ` (You were no longer in ${result.channel} — rejoined.)`
                            : '');
                } else if (action === 'saveAttachment') {
                    summary = `Saved to ${result.savedPath} (${result.savedBytes ?? 0} bytes).`;
                } else if (action === 'receipts') {
                    const rs = result.receipts ?? [];
                    summary = `${rs.length} sent DM(s); ${rs.filter((r) => r.seen).length} seen.`;
                } else {
                    summary = `agentinbox ${action} ok.`;
                }
                return ok(msg.id, {
                    content: [
                        {
                            type: 'text',
                            text: `${summary}\n\n${JSON.stringify(result, null, 2)}`,
                        },
                    ],
                });
            }
            if (params.name === 'knowledge') {
                const a = (params.arguments ?? {}) as Partial<KnowledgeToolRequest>;
                const action = a.action;
                if (
                    action !== 'search' &&
                    action !== 'get' &&
                    action !== 'add' &&
                    action !== 'list' &&
                    action !== 'link'
                ) {
                    return err(
                        msg.id,
                        -32602,
                        'knowledge requires `action`: search | get | add | list | link.',
                    );
                }
                const result = await ctx.knowledge(ctx.terminalId, {
                    action,
                    query: a.query,
                    limit: a.limit,
                    tags: a.tags,
                    tag: a.tag,
                    id: a.id,
                    title: a.title,
                    body: a.body,
                    links: a.links,
                    from: a.from,
                    to: a.to,
                });
                let summary: string;
                if (!result.ok) {
                    summary = `knowledge failed: ${result.error ?? 'unknown error'}`;
                } else if (action === 'search') {
                    summary = `${result.results?.length ?? 0} result(s) for "${a.query ?? ''}".`;
                } else if (action === 'list') {
                    summary = `${result.nodes?.length ?? 0} node(s).`;
                } else if (action === 'get') {
                    summary = result.node ? `Node "${result.node.title}".` : 'No such node.';
                } else if (action === 'add') {
                    summary = `Added node ${result.id ?? '?'}.`;
                } else {
                    summary = 'Linked.';
                }
                return ok(msg.id, {
                    content: [
                        {
                            type: 'text',
                            text: `${summary}\n\n${JSON.stringify(result, null, 2)}`,
                        },
                    ],
                });
            }
            if (params.name === 'openFileForUser') {
                const a = (params.arguments ?? {}) as Partial<OpenFileRequest>;
                const p = typeof a.path === 'string' ? a.path.trim() : '';
                if (!p) {
                    return err(msg.id, -32602, 'openFileForUser requires a `path`.');
                }
                const result = await ctx.openFileForUser(ctx.terminalId, {
                    path: p,
                    line: typeof a.line === 'number' ? a.line : undefined,
                });
                const summary = result.ok
                    ? `Opened ${result.file ?? p} for the user — ${
                          result.reused
                              ? 'reused the editor panel already open for this workspace'
                              : 'opened a new editor panel'
                      }.`
                    : `openFileForUser failed: ${result.error ?? 'unknown error'}`;
                return ok(msg.id, {
                    content: [
                        {
                            type: 'text',
                            text: `${summary}\n\n${JSON.stringify(result, null, 2)}`,
                        },
                    ],
                });
            }
            if (params.name === 'setEnv') {
                const a = (params.arguments ?? {}) as Partial<SetEnvRequest>;
                const key = typeof a.key === 'string' ? a.key.trim() : '';
                if (!key) return err(msg.id, -32602, 'setEnv requires a `key`.');
                if (typeof a.value !== 'string') {
                    return err(msg.id, -32602, 'setEnv requires a string `value`.');
                }
                const result = ctx.setEnv(ctx.terminalId, {
                    key,
                    value: a.value,
                    target: typeof a.target === 'string' ? a.target : undefined,
                });
                const summary = result.ok
                    ? `Set ${key} in ${result.file}.`
                    : `setEnv failed: ${result.error ?? 'unknown error'}`;
                return ok(msg.id, {
                    content: [
                        { type: 'text', text: `${summary}\n\n${JSON.stringify(result, null, 2)}` },
                    ],
                });
            }
            if (params.name === 'checkEnv') {
                const a = (params.arguments ?? {}) as Partial<CheckEnvRequest>;
                const key = typeof a.key === 'string' ? a.key.trim() : '';
                if (!key) return err(msg.id, -32602, 'checkEnv requires a `key`.');
                const result = ctx.checkEnv(ctx.terminalId, {
                    key,
                    target: typeof a.target === 'string' ? a.target : undefined,
                    value: a.value === true,
                    force: a.force === true,
                });
                let summary: string;
                if (!result.ok) {
                    summary = `checkEnv failed: ${result.error ?? 'unknown error'}`;
                } else if (!result.exists) {
                    summary = `${key} is not set in ${result.file}.`;
                } else if (result.value !== undefined) {
                    summary = `${key} in ${result.file} = ${result.value}${
                        result.obfuscated ? ' (obfuscated — pass force:true for the full value)' : ''
                    }`;
                } else {
                    summary = `${key} is set in ${result.file}${result.isSecret ? ' (a secret)' : ''}.`;
                }
                return ok(msg.id, {
                    content: [
                        { type: 'text', text: `${summary}\n\n${JSON.stringify(result, null, 2)}` },
                    ],
                });
            }
            if (params.name === 'ForceTheQuestion') {
                const questions = params.arguments?.questions;
                if (!Array.isArray(questions) || questions.length === 0) {
                    return err(
                        msg.id,
                        -32602,
                        'ForceTheQuestion requires a non-empty `questions` array.',
                    );
                }
                const rawPriority = params.arguments?.priority;
                const priority: QuestionPriority | undefined =
                    rawPriority === 'low' ||
                    rawPriority === 'normal' ||
                    rawPriority === 'high' ||
                    rawPriority === 'urgent'
                        ? rawPriority
                        : undefined;
                const result = await ctx.onForceQuestion(ctx.terminalId, questions, priority);
                if (result.cancelled) {
                    // DEFERRED (DND / couldn't-show): the question is parked in the
                    // user's top-bar flyout. It is NOT a dead end — when they answer,
                    // the answer is delivered to THIS agent's AgentInbox (ping/poll/
                    // pull). Tell the agent to receive it there rather than treat the
                    // deferral as a refusal. A plain dismissal has neither flag.
                    const text = result.deferred
                        ? `${result.dndMessage ?? 'The user is in Do Not Disturb.'}\n\n` +
                          `Your question is waiting in the user's PendingQuestions flyout. When they answer, ` +
                          `the answer will be delivered to your AgentInbox — call agentinbox(action:"receive") ` +
                          `to pull it (questionId: ${result.questionId ?? 'unknown'}).`
                        : (result.dndMessage ??
                          'The user dismissed the question without answering.');
                    return ok(msg.id, { content: [{ type: 'text', text }] });
                }
                // Human-readable summary + a machine-parseable JSON block so the
                // agent can act on either.
                const lines = result.answers.map((a) => {
                    const sel = a.selected.length ? a.selected.join(', ') : '(no option chosen)';
                    const note = a.note.trim() ? ` — note: ${a.note.trim()}` : '';
                    return `• ${a.header}: ${sel}${note}`;
                });
                return ok(msg.id, {
                    content: [
                        {
                            type: 'text',
                            text: `${lines.join('\n')}\n\n${JSON.stringify(
                                { answers: result.answers },
                                null,
                                2,
                            )}`,
                        },
                    ],
                });
            }
            // Plugin fall-through (§5.1): a NAMESPACED name (`namespace.tool`)
            // routes to the plugin registry. A non-namespaced miss stays a core
            // "unknown tool" error (a plugin name always carries its namespace
            // dot), so a typo'd core tool still reports -32602. dispatchPluginTool
            // is contained (returns an isError result); the try/catch is a final
            // backstop so a bad plugin can never break the transport.
            if (ctx.dispatchPluginTool && typeof params.name === 'string' && params.name.includes('.')) {
                try {
                    const args = (params.arguments ?? {}) as Record<string, unknown>;
                    const result = await ctx.dispatchPluginTool(params.name, args, ctx.terminalId);
                    return ok(msg.id, { content: result.content, isError: result.isError });
                } catch (e) {
                    return err(
                        msg.id,
                        -32603,
                        `Plugin tool "${String(params.name)}" failed: ${
                            e instanceof Error ? e.message : String(e)
                        }`,
                    );
                }
            }
            return err(msg.id, -32602, `Unknown tool: ${String(params.name)}`);
        }

        default:
            return err(msg.id, -32601, `Method not found: ${msg.method}`);
    }
}
