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
import { agentProviders } from '../agents/registry';
import type { AgentProviderId } from '../agents/registry';
import type { QuestionPriority } from '../ask/question-priority';
import type { TerminalReadState } from '../terminal/read-buffer';
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
    MemoryClass,
} from '../knowledge/types';
// A VALUE, not a type: the advertised `class` enum is generated from it, so a
// class added to the store cannot ship without the tool offering it.
import { MEMORY_CLASSES } from '../knowledge/types';
import { formatGappDevStatus, gappDevBrief } from '../workspace/gapp-dev-status';
import type { GappDevStatus } from '../workspace/gapp-dev-status';
import type { AppCheckReport } from '../apps/checkup';

export type { SetEnvRequest, SetEnvResult, CheckEnvRequest, CheckEnvResult };
export type { AgentInboxScope, AgentInboxAgentInfo, AgentInboxChannelInfo, AgentInboxMessage };
export type { KnowledgeNode, KnowledgeSearchResult, MemoryClass };

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
    /**
     * Is this a GApp Development Workspace, and what is in it (genie#245)?
     *
     * OPTIONAL, and absence is not "no": an older host, or a workspace whose Tynn
     * link could not be resolved, simply has no answer — and orientation says
     * nothing rather than inventing one. Present-and-false IS an answer, and the
     * map stays silent about it too: a line on every ordinary workspace
     * announcing an absence is noise on the one surface a fresh agent reads
     * before it knows anything.
     */
    gappDev?: GappDevStatus;
}

/**
 * The four things an agent can do with the GApp its workspace BUILDS (genie#245).
 *
 * Deliberately the same two verbs a human gets in Workspace Settings, plus the
 * `status` an agent needs and a human does not (a human can see the ring; an
 * agent has to ask), plus the teardown a human gets by closing the window.
 * Anything wider — installing, publishing — is not here, because it is not
 * offered to the human either and a tool for it would be a promise the product
 * does not keep.
 */
export type ManageGappDevAction = 'status' | 'check' | 'preview' | 'close-preview';

export interface ManageGappDevRequest {
    action: ManageGappDevAction;
    /**
     * `close-preview`: which preview. Optional — a GDW's own preview is the
     * obvious default, and an agent that just opened one should not have to
     * remember an id to close it.
     */
    appId?: string;
}

export interface ManageGappDevResult {
    ok: boolean;
    action: ManageGappDevAction;
    /**
     * WHERE the agent is, on EVERY action.
     *
     * Not just on `status`: an agent that ran `check` and got findings back still
     * does not know it is in a GDW, and "the agent could not tell" is the exact
     * defect this surface exists to fix. Cheap to carry, and it means any single
     * call answers the question.
     */
    status: GappDevStatus;
    /** `check`: the full suite's report over the workspace folder. */
    check?: AppCheckReport;
    /** `preview` / `close-preview`: what happened to the window. */
    preview?: {
        appId?: string;
        /** `https://<slug>.preview.gen/` — where it is serving. */
        homeUrl?: string;
        /** It opened, but something did not come up. Distinct from a failure. */
        warnings?: string[];
    };
    /** Why it did not happen. Present exactly when `ok` is false. */
    error?: string;
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

/**
 * Per-bucket open-item tallies for a workspace (security = the three alert kinds).
 *
 * Three of the four are GitHub streams Tynn polled. `feedback` is not: it is
 * unresolved customer feedback recorded against the workspace's Tynn project,
 * counted server-side and carried on this same wire because the point of the
 * datapoint is that it reaches `imDone` (Tynn Wish #118) — the one message an
 * agent reliably sends when it stops.
 */
export interface IssueWatchCounts {
    issue: number;
    pr: number;
    /** dependabot + code-scanning + secret-scanning. */
    security: number;
    /**
     * Unresolved (`open`) project feedback in Tynn. NOT a GitHub item and NOT a
     * failure — work waiting on triage. It has no `items` here: an agent reads
     * the entries themselves through the Tynn `feedback` MCP tool.
     */
    feedback: number;
}

/**
 * The IssueWatch snapshot for the caller's workspace, returned by `checkIssues`
 * and folded into the `imDone` response. `connected: false` means no GitHub
 * token is stored; `workspaceResolved: false` means the terminal couldn't be
 * mapped to a workspace.
 */
export interface IssueWatchSnapshot {
    connected: boolean;
    /** Present only when a refresh was REQUESTED. Tynn owns the rate limit — one
     *  window per WORKSPACE shared by every agent and the human — so the cooldown
     *  is passed through untouched rather than recomputed here. */
    refresh?: {
        refreshed: boolean;
        reason: 'refreshed' | 'cooldown' | 'failed' | 'unavailable';
        error?: string;
        cooldown: { seconds: number; nextAllowedAt: string | null; label: string };
    };
    workspaceResolved: boolean;
    serviceState?: 'connecting' | 'connected' | 'signed-out' | 'disabled' | 'disconnected';
    /** False until Tynn has delivered this workspace at least once. */
    knownToServer?: boolean;
    counts: IssueWatchCounts;
    items: IssueWatchItem[];
    /** The user's PER-BUCKET remediation preference (workspace settings), folded
     *  into the imDone count line so the agent knows how to act on EACH bucket.
     *  Omitted (or every OPEN bucket 'surface') reports only; 'fix' /
     *  'fix-and-ship' ask the agent to remediate that bucket when idle.
     *
     *  Deliberately covers the three GITHUB buckets only. `fix` and
     *  `fix-and-ship` are verbs for a defect in the code; the response to
     *  feedback is triage (convert / resolve / discard), and whether a given
     *  complaint is worth acting on is a human judgement. Giving feedback a
     *  remediation mode would tell an agent to go and clear the list, which is
     *  the one behaviour this datapoint must not produce. */
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
    onThumbsUp?: (
        terminalId: string,
        reason: 'boot' | 'ack' | 'shutdown',
        to?: string,
    ) => Promise<{ ok: boolean; agentId?: string; error?: string }>;
    /**
     * Resolve the caller's workspace and return its IssueWatch snapshot (open
     * Issues / PRs / security alerts + per-bucket counts) for the `checkIssues`
     * tool AND the counts appended to the `imDone` response. Does the terminal→
     * workspace + db/cache I/O (kept out of this pure module).
     */
    checkIssues: (terminalId: string, opts: { refresh: boolean }) => Promise<IssueWatchSnapshot>;
    /** True when the caller's workspace is an Ops project. NO LONGER gates
     *  `provisionWorkspaces` out of tools/list — that tool is always advertised
     *  and its handler enforces Ops membership (genie #85); this capability is
     *  retained for callers that need the fact directly. */
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
     * Tell the agent whether it is in a GApp Development Workspace, and run the
     * app tools over it (manageGappDev). Does the db + filesystem I/O and, for a
     * preview, reaches the desktop window seam.
     *
     * Optional so a host that has not wired it advertises the tool and says so
     * on call, rather than pretending the workspace is not a GDW — the two are
     * different answers and only one of them is ever true.
     */
    manageGappDev?: (
        terminalId: string,
        req: ManageGappDevRequest,
    ) => Promise<ManageGappDevResult>;
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
    /** Persist a first-class AMS configuration without launching its TUI. */
    registerAgent?: (
        terminalId: string,
        req: RegisterAgentRequest,
    ) => Promise<RegisterAgentResult>;
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
    /** File feedback about Genie into the workspace's Tynn project (Tynn #249).
     *  OPTIONAL: a host that cannot reach a Tynn backend simply does not wire it,
     *  and the tool reports that plainly instead of the surface throwing. */
    submitFeedback?: (
        terminalId: string,
        message: string,
    ) => Promise<{ ok: boolean; id?: string; error?: string }>;
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
    /**
     * What a fire does. `flow` appears here but NOT in the create request below:
     * a flow's schedule is declared on its own canvas and reconciled into a spec,
     * so it can be listed and understood but never hand-created. A schedule
     * created by hand would be a second way to arm a flow, outside the
     * declaration that is supposed to be the only one.
     */
    scheduleKind?: 'command' | 'agent-nudge' | 'flow';
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
    /** The workspace this site belongs to — so an agent can correlate a site with
     *  its workspace's services/env when debugging (genie #169). */
    workspaceId: string;
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
    /** The loopback port this site is reached on from THIS machine: the sandbox's
     *  published Caddy port for a container site, the dev server's own port for a
     *  host-native one. What it SPEAKS differs — see {@link localOrigin}. */
    hostPort?: number;
    /** The routable origin through the Genie Browser (http sites). */
    origin?: string;
    /**
     * The origin that answers on THIS machine — in the protocol the port really
     * speaks (genie#195). A CONTAINER site's `hostPort` is the sandbox's Caddy: TLS,
     * routed by SNI, so this is `https://<genName>:<hostPort>` and a plain-http
     * request to it answers "Client sent an HTTP request to an HTTPS server". A
     * HOST-NATIVE site holds the port itself and speaks plain http, so this is
     * `http://127.0.0.1:<port>`. Use {@link localCurl} — the https form also needs
     * the `.gen` name pinned to loopback, since it resolves nowhere here.
     */
    localOrigin?: string;
    /** The exact command that reaches {@link localOrigin} from this machine, SNI
     *  and all. Curl THIS rather than building a URL from `hostPort`. */
    localCurl?: string;
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
    /** The stored image ref. Recorded, never used — there is no per-site container
     *  (genie#125/#191). */
    image?: string;
    /** The pull/start log while a site comes up, and the last one on a failure. */
    buildLog?: string;
    /** Extra BROWSER-FACING surfaces, as they ended up. A raw one (gRPC/TCP)
     *  carries the stable `hostPort` a client dials. */
    exposed?: Array<{ name: string; protocol: string; genName: string; hostPort?: number }>;
    /** The stored environment, so the human Edit form can prefill it. */
    env?: Record<string, string>;
    /** The Host header sent upstream, when overridden from the `.gen` name. */
    upstreamHost?: string;
    /** How Genie serves this host-native site (static/php), when it does — so the
     *  Edit form's serve-mode picker prefills. Absent ⇒ the repo's own dev server. */
    hostServe?: { mode: 'static' | 'php'; root: string; spa?: boolean; version?: string };
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
    /**
     * create/update: how it runs. Omit to take the recommendation — the repo's DEV
     * server run host-native (`host`): no container, no build. `explicit` runs
     * `command` inside the shared workspace sandbox.
     *
     * The four container modes are still IN the type because sites stored under them
     * exist, but passing one is REFUSED with a reason (genie#191): nothing here runs
     * `build` steps or a per-site `image`, so accepting one would record a production
     * build+serve that never happens. See `unrunnableRunModeReason`.
     */
    runMode?: 'dockerfile' | 'devcontainer' | 'compose' | 'recipe' | 'explicit' | 'host';
    /** create/update: RECORDED BUT NEVER USED — there is no per-site container
     *  (genie#125/#191). The result says so in `notes`. */
    image?: string;
    /** create/update: RECORDED BUT NEVER RUN — nothing executes a site build in this
     *  model (genie#191). The result says so in `notes`. */
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
    /**
     * create: serve this host-native site with GENIE's OWN web server instead of a
     * repo dev server — the agent declares a MODE and Genie renders the config, so
     * nobody hand-writes an nginx/Caddy server block. `static` serves a built
     * directory (`root`, e.g. `dist` or `dashboard/dist`), `spa` adding the
     * index.html fallback for client-side routing; `php` serves `public/` via a
     * FastCGI worker. `root` is repo-relative. No `command`/`port` needed — Genie
     * owns both the server and the port. For a repo's OWN dev server, or a service
     * you already run, use `command`+`port` or `hostPort` instead (a reverse-proxy,
     * no generated config).
     *
     * `version` (php only) PINS the engine version — omitted, the site follows the
     * machine default and moves with it; pinned to something Genie does not manage,
     * the start FAILS naming it rather than serving on a different runtime.
     *
     * update: pass `null` to CLEAR it — switch a static/php site back to running the
     * repo's own dev server (proxy). Omit the field to leave the serve mode untouched.
     */
    hostServe?: { mode: 'static' | 'php'; root: string; spa?: boolean; version?: string } | null;
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
    /**
     * The action was ACCEPTED and is still running — this call returned early
     * rather than hold the tool transport open to its 120s timeout (genie#194).
     * The site is NOT known to be live: poll `status` with {@link affectedId}
     * until its `phase` reaches `ready` or `failed`. `notes` says the same in
     * words. Absent ⇒ the result is the settled outcome.
     */
    pending?: boolean;
    /** The workspace's sites after the action (always returned on ok). */
    sites: DevSiteInfo[];
    /** The site the action targeted/created. */
    affectedId?: string;
    /** Things that happened alongside the action and would otherwise be silent:
     *  where an `env` was written, that an `image` is recorded but never used, that
     *  a start is still running. Advisory — never a substitute for `error`. */
    notes?: string[];
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
    /** This is the version whose connection this workspace's apps get. Only
     *  meaningful when the workspace holds two majors of one engine (#242 P3). */
    active?: boolean;
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
        /** Make THIS version the one this workspace's apps connect to, when the
         *  workspace holds more than one major of the same engine (#242 P3). */
        | 'active'
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
    /** A consequence the caller must know about even though the action SUCCEEDED
     *  — e.g. switching the active engine version leaves the old version's data
     *  behind, so the newly-active one starts empty (#242 P3). */
    note?: string;
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
    /** read: what an EMPTY read means (genie#217) — 'live' (the terminal really
     *  produced nothing), 'restored' (its buffer was missing and was rebuilt from
     *  the scrollback that survived in the pty host), or 'exited' (its pty is not
     *  running, so there is nothing to read at all). */
    state?: TerminalReadState;
}

// --- runAgent ----------------------------------------------------------------

export type AgentType = AgentProviderId;

/** One saved agent as the runAgent tool reports it (Tynn #254). */
export interface SavedAgentInfo {
    /** The canonical machine-facing id — `{provider}:{name}:{chat-id}`, or
     *  `{provider}:{name}` while the chat-id is not bound yet (Codex, pre-hook). */
    ref: string;
    provider: AgentType;
    /** The name this agent is reopened by. Human-facing surfaces show the
     *  provider's LOGO and this — never the chat-id. */
    name: string;
    /** Durable AMS configuration id. */
    id: string;
    /** Its current terminal binding, absent while dormant. */
    terminalId?: string;
    /** Is its TUI running right now? Not-live is dormant, not gone. */
    live: boolean;
    /** Harness-native AgentInbox adapter required by this provider. */
    transport?: 'claude-channel' | 'codex-app-server';
    /** Timestamp of the current boot's successful transport handshake. */
    transportVerifiedAt?: number;
    /** Actionable failure from the current boot's transport handshake. */
    transportError?: string;
    /** Set only after transport verification and the agent's thumbs-up. */
    readyAt?: number;
}

export interface RunAgentRequest {
    /**
     * - `start`: bring a SAVED agent up — REATTACHING to it when it already
     *   exists, rather than minting a second one. New configurations are created
     *   by `registerAgent`, never as a side effect of starting.
     * - `list`: read-only — the workspace's saved agents.
     * - the rest act on a running agent terminal by `id`.
     */
    action: 'start' | 'send' | 'read' | 'stop' | 'restart' | 'list';
    /** Target workspace (own, or a governed child). Same rules as manageTerminals. */
    workspaceId?: string;
    /**
     * start: the SAVED AGENT'S NAME — the half of its identity you reopen it by
     * (`tynn` in `claude:tynn`). Together with the provider it is the saved
     * config's key; deliberately chat-id-free, because Codex cannot know its
     * session id until its harness is running. Default `general` — the
     * workspace's unnamed agent, which is what every agent started before this
     * existed is called.
     */
    name?: string;
    /** @deprecated Registration moved to registerAgent. Ignored by the MCP dispatcher. */
    create?: boolean;
    /**
     * start: PRE-LOADED INSTRUCTIONS — a prompt delivered as part of startup
     * rather than typed afterwards. Applied on the launch line, so the agent has
     * it before its first turn.
     */
    instructions?: string;
    /** start: which agent CLI to launch. On a REATTACH it is the record that
     *  decides — this only disambiguates one name saved under two providers. On a
     *  create, omitting it takes the WORKSTATION default. */
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

export interface RegisterAgentRequest {
    workspaceId?: string;
    name: string;
    purpose: string;
    agent?: AgentType;
    avatar?: string;
    /** Workspace-relative folder. It must resolve inside the workspace root. */
    bootFolder?: string;
}

export interface RegisterAgentResult {
    ok: boolean;
    error?: string;
    agent?: {
        id: string;
        workspaceId: string;
        provider: AgentType;
        name: string;
        purpose: string;
        avatar?: string;
        bootFolder?: string;
    };
}

export interface RunAgentResult {
    ok: boolean;
    /** Set when ok is false (denied, no command configured, unknown id, …). */
    error?: string;
    /** start: the agent terminal's id — the SAME one on every reattach. */
    id?: string;
    /** start: the agent type launched. */
    agent?: AgentType;
    /** start: the resolved command line that was launched. */
    command?: string;
    /** start: the canonical ref — `{provider}:{name}:{chat-id}`, or
     *  `{provider}:{name}` until the harness binds its chat-id. */
    ref?: string;
    /** start: the saved agent's name. */
    name?: string;
    /** start: TRUE when this reattached to an existing TUI, FALSE on the
     *  registered agent's first launch. */
    reattached?: boolean;
    /** start: whether the harness chat id is already attached to the durable saved agent. */
    sessionBinding?: 'bound' | 'pending';
    /** list (and any start refusal that needs to show the alternatives): the
     *  workspace's saved agents. */
    agents?: SavedAgentInfo[];
    /** read: the output bytes for this read. */
    data?: string;
    /** read: the cursor to continue from. */
    cursor?: number;
    /** read: true when buffered output was evicted before this read. */
    dropped?: boolean;
    /** read: what an EMPTY read means — see ManageTerminalsResult.state. */
    state?: TerminalReadState;
}

// --- manageWorkspaces --------------------------------------------------------

/** One workspace as the manageWorkspaces tool reports it. */
export interface ManagedWorkspaceInfo {
    id: string;
    name: string;
    path: string;
    /** Relationship to the caller: its own workspace, a governed child, or — when
     *  this workspace is the designated WORKSTATION OPERATOR — any other
     *  workspace on this machine (Tynn #248). Kept distinct from `governed`
     *  because the caller does not own an `operator` workspace; it has authority
     *  over the machine, and blurring the two would misreport why it is
     *  reachable. */
    relation: 'self' | 'governed' | 'operator';
}

export interface ManageWorkspacesRequest {
    /**
     * - `list` / `status`: read-only — the caller's workspace + every workspace
     *   it governs.
     * - `open`: open (focus) a workspace window.
     * - `activate`: make a workspace the active one in Genie.
     * - `remove`: UNREGISTER a workspace from Genie (never deletes disk).
     * - `add`: REGISTER an existing folder as a workspace. Workstation OPERATOR
     *   only — it introduces a folder Genie did not know about to every surface
     *   that lists workspaces, which is a workstation-level act rather than one
     *   an agent's own workspace grants. The counterpart to `remove`: without it
     *   an operator could take a workspace off the list and never put one back.
     */
    action: 'list' | 'status' | 'open' | 'activate' | 'remove' | 'add';
    /** Target workspace for open/activate/remove (own or governed). */
    workspaceId?: string;
    /** `add`: the ABSOLUTE path of the folder to register. */
    path?: string;
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
        | 'registerTransport'
        | 'setAccessibility';
    /** send: DM this agent id. */
    to?: string;
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
    /** registerTransport: Genie-owned harness adapter readiness handshake. */
    transport?: 'claude-channel' | 'codex-app-server';
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
    /**
     * WHICH memory (Tynn #250) — `profile` | `episodic` | `procedural` |
     * `knowledge`.
     *
     * On `add`, the class the node is filed under (defaults to `knowledge`). On
     * `search` / `list`, restrict to that one class; absent covers every class,
     * so an existing caller finds exactly what it found before.
     */
    class?: MemoryClass;
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
        "Get a detailed list of the open GitHub Issues, Pull Requests, and SECURITY ALERTS (Dependabot, Code-scanning, Secret-scanning) that Genie's IssueWatch is tracking for THIS terminal's workspace — across every repo in the workspace, plus a count of the workspace's unresolved project FEEDBACK in Tynn. Use it to see what needs attention before you finish, or whenever you want the current open items with their numbers, titles, severities, and URLs. Read-only by default. Pass `refresh: true` to force IssueWatch to re-read GitHub NOW rather than waiting for the next server poll — the refreshed feed comes back in the SAME answer, together with when the next manual refresh is allowed. That window belongs to the WORKSPACE and is shared by every agent and the human, so a refresh can be REFUSED: that is a normal answer carrying the time remaining, not a failure, and the snapshot below it is still real. A refresh that FAILED costs nothing and may be retried at once. (The same per-bucket counts are also appended to every `imDone` response.) Feedback is NOT a GitHub item and NOT a failure — it is people's input waiting on triage; read the entries with the Tynn `feedback` tool, and leave the judgement of what is worth acting on to a human. Pass `terminalId` (your GENIE_TERMINAL_ID) for exact workspace resolution; required when the workspace has more than one terminal.",
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            refresh: {
                type: 'boolean',
                description:
                    'Force IssueWatch to re-read GitHub NOW instead of waiting for the next server poll. The window is per WORKSPACE and shared with every other agent and the human, so a refusal is normal and is NOT an error — the answer always says how long is left. A failed attempt costs nothing and may be retried immediately.',
            },
        },
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

const SUBMIT_FEEDBACK_TOOL = {
    name: 'submitFeedback',
    description:
        "File FEEDBACK about GENIE ITSELF into this workspace's Tynn project — a rough edge, a confusing surface, something that behaved unexpectedly. It lands in Tynn's feedback pipeline, where a human triages, quick-accepts or converts it. Use this the moment you notice something, INSTEAD of writing it into a terminal nobody is reading. NOT for the work you are doing (a feature belongs in a wish, a defect in the repo's issue tracker) and NOT for asking the user something — that is ForceTheQuestion. Genie stamps the version, workspace and terminal automatically, so just say what happened.",
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            message: {
                type: 'string',
                description:
                    'What happened, in your own words. Concrete beats polite — what you expected, what you got.',
            },
        },
        required: ['message'],
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
        "HOST a repo the way you DEVELOP it — Genie runs its DEV server as a HOST process against the LIVE source (NO container, NO build) and serves it at a stable `https://<name>.gen` origin reachable whether the viewer is on this machine or connected remotely. DEFAULT is dev + host-native — 'just serve the repo the site points to', live (Docker is only for the services behind it): a bare `create {name}` detects the stack and runs its OWN dev server — PHP/Laravel → `php artisan serve`; Node (Vite/Next/Nuxt) → the repo's own `npm run dev`; Django → `manage.py runserver`; Go → `go run .`. To be explicit: `command`+`port` runs YOUR dev server; `hostPort` points `.gen` at a dev server you ALREADY run (e.g. one started with `manageProcess`). There is NO production build+serve here: `runMode:'recipe'`/`'dockerfile'`/`'compose'`/`'devcontainer'` are REFUSED with a reason, because nothing in this model runs `build` steps or a per-site `image` — a site is a command, run either on the host (`host`) or in the shared workspace sandbox (`explicit`). To serve a BUILT artifact, run the build yourself and point `hostServe` at the output. Actions: `detect` (read a repo and return every way it could run, each with `confident` and a `needs` that says what is still a guess OR that Genie cannot run that mode at all — read it before choosing); `list` (every site + live state); `create` (define one and host it — `name` (a DNS label) plus either `hostServe`, or a `command` + `port`, or nothing at all to take the detected DEV server; optional `repo` to host repos/<repo>, `env`, `exposed`, `kind`); `update` (edit an existing site by `id` — pass only the fields to change: `name`/`genName`, `command`, `port`, `env`, `hostServe`, `runMode`, `exposed`, `upstreamHost`, `kind`; a RUNNING site is rebuilt/restarted only when the change requires it, and left as-is otherwise); `start` / `stop` / `restart` / `status` (by `id` from a prior list); `logs` (the site's log tail — for a PHP site, the FastCGI worker's too); `open` (show the site in the Genie Browser for the user); `remove` (stop it and forget the definition). READ THE RESULT: `pending:true` means the start was ACCEPTED and is STILL RUNNING — this tool returns early rather than blow its 120s timeout on a cold image pull, so the site is NOT known to be live: poll `status` with the returned `id` until `phase` is `ready` or `failed`. `buildLog` carries the pull/start output while it comes up. `state:'running'` means the CONTAINER is up; `ready:true` means the published port actually accepted a connection. `origin` is the routable `https://<name>.gen`. TO CURL IT FROM THIS MACHINE, use the `localCurl` command in the result — do NOT build a URL out of `hostPort`: a container site's `hostPort` is the sandbox's Caddy, which speaks TLS and routes by SNI, so `curl http://127.0.0.1:<hostPort>/` answers `Client sent an HTTP request to an HTTPS server`, and even the https URL needs `--resolve <name>.gen:<hostPort>:127.0.0.1` because the `.gen` name resolves nowhere here. A host-native site's port is the dev server's own and is plain http. `localOrigin` says which of the two this site is. SERVICES — a host-native dev server runs ON THE HOST, so it reaches a `manageProcess` service and the managed DB/cache on `127.0.0.1:<published port>` — the host-form env (`DATABASE_URL`, …) Genie injects into it, and which Genie also WRITES into the repo's `.env` (gitignored, read-modify-write) so anything reading that file agrees. A TERMINAL is NOT given the app's config: it gets the client-tool credentials (`PG*`/`MYSQL_*`) and everything else under `GENIE_`, so a shell can never silently outrank the `.env` the app reads. (A sandbox (`explicit`) site instead reaches services on the workspace network by engine name; there its `localhost` is the sandbox and a host `manageProcess` service is at `${GENIE_HOST_GATEWAY}:<port>`.) A DATABASE OR CACHE IS NEVER EXPOSED — shared engines are workstation-hosted and reached on the workspace network through the env `manageService` injects (`DATABASE_URL`, …). Only what the BROWSER itself connects to is exposed, via `exposed:[{name,port,protocol,reason}]`: a websocket on the app's own port needs nothing (it upgrades over the existing carrier), one on another port gets `<name>.<site>.gen`, and gRPC/TCP get a STABLE loopback port. A surface that cannot say why the browser needs it is REFUSED. BINDING: bind the dev server to the `port` you give (on `127.0.0.1` or `0.0.0.0`) — a server on a random port `.gen` can't find is the common mistake; a sandbox (`explicit`) server must bind `0.0.0.0`. HOST ALLOWLISTS: upstream is sent `Host: <name>.gen`; Django checks it (`ALLOWED_HOSTS`), so either add the `.gen` name there or pass `upstreamHost:'localhost'`. Host-native hosting needs NO Docker; a sandbox (`explicit`) site and the services do — when a runtime is unusable that path's result carries the install hint. `command` is literal argv ([\"npm\",\"run\",\"dev\"]), never shell strings. Pass `terminalId` (your GENIE_TERMINAL_ID) for exact workspace resolution; required when the workspace has more than one terminal.",
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
                enum: ['host', 'explicit'],
                description:
                    "create/update (optional): how it runs. PREFER `hostServe` — let GENIE serve the app (you point at a repo + a root; Genie owns the web server, the port and the `.gen` address). Reach for a runMode only when Genie cannot serve that stack, or you specifically want the repo's own dev server (HMR against live source). `host` runs `command` (or the detected dev command) as a HOST process on a port Genie allocates — this is what you get if you omit both. `explicit` runs `command` inside the shared workspace sandbox (a container) on the `port` you give. NOTHING ELSE RUNS HERE: `recipe`, `dockerfile`, `compose` and `devcontainer` are REFUSED with a reason — no build steps are run and no per-site `image` is used in this model, so accepting one would report a production build+serve that never happened (genie#191). To serve a built artifact, build it yourself and point `hostServe` at the output.",
            },
            image: {
                type: 'string',
                description:
                    "create/update (optional): RECORDED BUT NOT USED (genie#125/#191). There is no per-site container in this model — a site's command runs on the host or in the shared workspace dev image — so an `image` here changes nothing at runtime and the result says so. Put extra runtime tools in the workspace's dev image instead.",
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
                    'create/update (optional): RECORDED BUT NOT RUN (genie#191). Nothing in this model executes build steps before a site starts, so a `build` here is stored metadata only. Run the build yourself (a terminal, or `manageProcess`) and then serve the output with `hostServe`.',
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
            hostPort: {
                type: 'number',
                description:
                    'create: HOST-NATIVE — point `<name>.gen` straight at a dev server you ALREADY run as a HOST process on `127.0.0.1:<hostPort>` (e.g. one started with `manageProcess`), NO container and NO build. Mutually exclusive with `command`/`serve`/`image`.',
            },
            hostServe: {
                // `null` (update only) CLEARS it — see the description; the object
                // branch's `required` does not constrain the null value.
                type: ['object', 'null'],
                properties: {
                    mode: {
                        type: 'string',
                        enum: ['static', 'php'],
                        description:
                            '`static` serves a built directory (SPA-aware); `php` serves `public/` via a FastCGI worker.',
                    },
                    root: {
                        type: 'string',
                        description:
                            'The repo-RELATIVE DOCUMENT ROOT — served exactly as given. A built front end (`dist`, `dashboard/dist`) for static; for php the web root, which for Laravel and most PHP apps is `public/` and NOT the app root — pointing it at the app root would publish `.env` and `.git`.',
                    },
                    spa: {
                        type: 'boolean',
                        description:
                            'static only: fall back to index.html for unmatched paths so client-side routes (deep links, refresh) resolve.',
                    },
                    version: {
                        type: 'string',
                        description:
                            'php only: PIN the engine version this site runs on (`8.3`, or an exact `8.3.33`) — one Genie manages, as listed in Settings → Toolchain → Languages. OMITTED = the machine default, and the site MOVES with it when the default changes. A pinned version Genie does not manage FAILS the start naming what to install — never a silent fallback to another runtime.',
                    },
                },
                required: ['mode', 'root'],
                description:
                    'create: THE PREFERRED WAY to host a site. GENIE serves it with its own web server — you point at a repo and a ROOT, declare the mode, and Genie writes the config (no hand-rolled nginx/Caddy), owns the port and answers on `<name>.gen`. No `command`/`port` needed. A PHP/Laravel app points at its WEB ROOT — `public/`, not the app root, which would publish `.env` and `.git`; a built front end points at `dist`. Use a repo dev server (`command`+`port`) or an already-running one (`hostPort`) only when Genie cannot serve that stack, or you want HMR against live source. update: pass `null` to CLEAR it — switch back to the repo’s own dev server.',
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
        "Give this workspace a backing SERVICE — Postgres, MySQL, Redis, Meilisearch, MinIO (S3), Mailpit, Reverb (WebSockets/broadcasting), or any image — and get back how to connect to it. These are the same engines a hosted site runs against, so a site served by `manageSite` is backed the way production is. THE MODEL, because it changes what you should expect: an engine is WORKSTATION-hosted and SHARED per (engine, major version) across every workspace that asks for it, and each workspace gets its OWN database + role + credentials on it. Ten workspaces on Postgres 16 run ONE postgres container, not ten; a workspace's role cannot reach another workspace's database. The engine starts when the first workspace acquires it and stops when the last one releases it. A workspace that genuinely needs hard isolation (a custom config, an extension, destructive testing) flips `dedicated` and gets its own container — note that shared and dedicated have SEPARATE data volumes, so flipping does not move data. Actions: `catalog` (every engine on offer, its versions, and how strongly each isolates); `inventory` (MACHINE-level — every engine on this WORKSTATION: whether its image is on disk, whether a container exists and is up, how many workspaces hold it right now and WHICH, plus the dedicated ones. Needs no workspace. Read this BEFORE stopping or removing anything: `installed`, `state` and `holders` are three independent facts, and stopping a shared engine stops it for every workspace holding it); `list` (this workspace's services + live state); `add` (`engine` plus optional `version` — defines it, starts the engine, creates this workspace's database/role/credentials, and attaches the engine to this workspace's network); `start` / `stop` / `status` (by `id` from a prior list); `logs` (the engine's log tail); `connection` (the connection surface + the exact env keys injected into this workspace's sites); `dedicated` (flip one service between shared and its own container); `remove` (release it, and with `purge` drop the engine's data volume — REFUSED whenever another workspace has a database in that volume, whether or not it is open right now, because a shared engine keeps every workspace's data in ONE volume; the refusal names what it protected, and the way past it is to remove those services first or flip this one to `dedicated` and purge its own volume). READ THE RESULT: `endpoints` carries TWO surfaces and they are not interchangeable — `host`+`port` is how a CONTAINER on this workspace's network dials the engine (its container name, its real port), `localAddress` is how a program on THIS MACHINE dials it (loopback, published port). A connection string built from the second and used inside a container fails every time. A service is BACKEND: it is never given a browser-facing name and never published to the browser, so do not try to expose one through `manageSite`. `envKeys` are already injected into this workspace's hosted sites (`manageSite`), and into their BUILD steps too, so an app served there needs no `.env` edit. MinIO gives each workspace its OWN IAM user, admitted by policy to its own bucket and no other — so `AWS_ACCESS_KEY_ID` is the workspace, never the engine root. Meilisearch, Mailpit and Reverb are NAMESPACE-isolated, not credential-isolated: workspaces share the master key/secret and are separated by index prefix / inbox / Reverb app (each workspace gets its own app whose secret is derived from the shared master, so a site can broadcast but never forge another workspace's app). `custom` takes `image` + `port` + `env` and is always dedicated. Requires Docker or Podman; when neither is usable the result carries the install hint. Pass `terminalId` (your GENIE_TERMINAL_ID) for exact workspace resolution; required when the workspace has more than one terminal.",
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

const REGISTER_AGENT_TOOL = {
    name: 'registerAgent',
    description:
        'Create a durable AMS agent configuration without launching it. Registration records identity, purpose, provider, optional avatar, and an optional workspace-contained boot folder. Use runAgent afterwards to start the registered agent. This is short-term agent configuration; Agent Builder remains a plugin.',
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            ...TARGET_WORKSPACE_PROP,
            name: { type: 'string', description: 'Stable human-facing agent name.' },
            purpose: { type: 'string', description: 'What this agent is responsible for.' },
            agent: {
                type: 'string',
                enum: agentProviders(),
                description: 'The TUI provider. Defaults to the workstation provider.',
            },
            avatar: {
                type: 'string',
                description: 'Optional workspace-relative avatar path.',
            },
            bootFolder: {
                type: 'string',
                description: 'Optional workspace-relative boot folder. Must resolve inside the workspace.',
            },
        },
        required: ['name', 'purpose'],
        additionalProperties: false,
    },
};

const THUMBS_UP_TOOL = {
    name: 'thumbsUp',
    description:
        'Signal agent readiness without spending a DM: after boot, as an agent-to-agent acknowledgement, or when prepared for Genie shutdown. The agent grid shows a green animated thumb on the sender.',
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            reason: {
                type: 'string',
                enum: ['boot', 'ack', 'shutdown'],
                description: 'Why readiness is being signalled. Default ack.',
            },
            to: {
                type: 'string',
                description: 'ack only: optional registered agent ref waiting for confirmation.',
            },
        },
        additionalProperties: false,
    },
};

const RUN_AGENT_TOOL = {
    name: 'runAgent',
    description:
        "Start and control a REGISTERED coding agent (claude / codex / a custom CLI) in this workspace — or one you govern. Registration is a separate `registerAgent` call; `runAgent` never creates configuration. Actions: `list` (registered agents, including dormant ones); `start` (launch or resume the registered `name`; defaults to the Workspace Agent); `send`; `read`; `stop`; `restart`. Every agent remains terminal-based, while its durable AMS identity survives terminal restarts. SAFETY: first launch, `send`, and `restart` are approval-gated when the workspace requires it; listing, reading, and reattaching are read-only/already-approved.",
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            ...TARGET_WORKSPACE_PROP,
            action: {
                type: 'string',
                enum: ['start', 'send', 'read', 'stop', 'restart', 'list'],
                description: 'What to do.',
            },
            name: {
                type: 'string',
                description:
                    "start: the SAVED AGENT'S NAME — what you reopen it by (`tynn` in `claude:tynn`). Starting a name that already exists REATTACHES to that agent instead of creating another. Default 'general' (the workspace's unnamed agent).",
            },
            instructions: {
                type: 'string',
                description:
                    "start (optional): PRE-LOADED INSTRUCTIONS — a prompt delivered as part of the agent's startup, so it has them before its first turn, rather than sent afterwards.",
            },
            agent: {
                type: 'string',
                // DERIVED from PROVIDER_REGISTRY (genie#261) — a provider absent
                // from this enum cannot be NAMED over MCP, whatever the types say.
                enum: agentProviders(),
                description:
                    "start: only disambiguates registered agents with the same name under different providers. The registered record decides what launches.",
            },
            command: {
                type: 'string',
                description:
                    "start: optional exact command override. Required for a custom provider unless its command is configured in Settings.",
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
        "Manage Genie WORKSPACES you can act on — your own and (for an Ops agent) the ones you govern. Actions: `list` / `status` (read-only — every workspace you may act on, with its id, name, path, and whether it's your own or a governed child); `open` (open/focus a workspace's window); `activate` (make a workspace the active one in Genie); `remove` (UNREGISTER a workspace from Genie — this only removes it from Genie's list, it NEVER deletes anything on disk); `add` (REGISTER an existing folder as a workspace — pass `path`, the ABSOLUTE path of the folder. WORKSTATION OPERATOR only: it introduces a folder Genie did not know about to every surface that lists workspaces. This is the counterpart to `remove`. An `.agi` envelope (a folder with `project.json`) registers as one; anything else registers as a simple folder). Targets are limited to your own workspace or one you govern; any other is rejected. To CREATE/clone missing child workspaces for an Ops project, use `provisionWorkspaces` instead.",
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
        "Coordinate with OTHER AI agents running in this Genie instance through durable 1:1 direct messages. Discover peers that chose to be visible, DM them by the `ref` returned from `list`, attach byte-copied files, receive messages, and inspect read receipts. Private agents outside your workspace are not listed; when one messages you first, you may reply in that durable thread using the sender id from the message. To await a reply, make ONE blocking `receive` with `wait:true` rather than polling. Local-only — no relay, no cross-host.",
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
                    'registerTransport',
                    'setAccessibility',
                ],
                description: 'What to do.',
            },
            to: {
                type: 'string',
                description: 'send: the recipient agent id or discovery `ref` (DM).',
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
            transport: {
                type: 'string',
                enum: ['claude-channel', 'codex-app-server'],
                description: 'registerTransport: native harness adapter that completed its connection handshake.',
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
                    "setAccessibility: who may discover and DM you — self (your workspace, default) / specific (a chosen set) / all (the workstation) / none or hidden (nobody outside your workspace). A private agent that initiates a DM can still receive replies in that durable thread.",
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
        "Read + write Genie's workstation KNOWLEDGE GRAPH — a workstation-wide, LOCAL knowledge/memory store shared across EVERY workspace on this Genie instance (one store, not per-workspace). Use it to STASH durable, reusable context as small markdown \"memory\" nodes and RETRIEVE it on demand — so shared, system-wide knowledge lives here instead of bloating every workspace's AGENTS.md/CLAUDE.md. Nodes link to each other with `[[wikilink]]` references in their body (each becomes a graph edge). MEMORY CLASSES (`class`) — every memory is one of FOUR kinds, because they answer four different questions: `profile` (what is true of the user / what they prefer), `episodic` (what happened, and when), `procedural` (what was learned from doing this before), `knowledge` (where this is in the documents — the DEFAULT). SET `class` when you add, and PASS it when you search/list so you get the kind you meant: \"what does the user prefer?\" and \"find the section about X\" are different questions, and asking one without a class gets you the other's answers. Actions (`action`): `search` (keyword retrieval — needs `query`; optional `limit`, `class` to restrict to ONE memory class, `tags` to restrict to nodes carrying ALL those tags — returns ranked `{ id, title, snippet, score, tags, class }` hits; USE THIS FIRST to check what's already known); `get` (`id` → the full node incl. its linked node ids); `add` (create a node — needs `title`, optional markdown `body` (put `[[wikilink]]`s to related nodes in it), optional `class`, optional `tags`, optional explicit `links` (ids/titles/slugs) → returns the new `id`); `list` (recent nodes — optional `class`, `tag`, `limit`; this is how you ask an EPISODIC question like \"what happened recently\", which has no query string to search for); `link` (add an edge from node `from` to `to` (an id, title, or slug)). Search is keyword-based and always available (no API key, no setup, works offline). Wikilinks cross classes freely — it is still ONE graph, so a `procedural` memory should cite the `knowledge` node it was learned from. Prefer searching before adding a duplicate, and cross-link related memories with `[[wikilink]]`s so the graph stays connected.",
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
            class: {
                type: 'string',
                // Generated from MEMORY_CLASSES so the tool cannot advertise a
                // different set than the store accepts.
                enum: [...MEMORY_CLASSES],
                description:
                    'WHICH memory. add: file the node under this class (default `knowledge`). search / list: restrict to this ONE class — omit to cover every class. `profile` = what is true of the user / what they prefer; `episodic` = what happened and when; `procedural` = what was learned from doing this before; `knowledge` = where this is in the documents.',
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

    // WHAT KIND of workspace this is, before the plan for learning it. A GDW is
    // not a fact about the repos — it changes what the agent is here to DO, and
    // an agent that reads the plan without it will orient itself as if this were
    // an ordinary project. `gappDevBrief` returns null for every other case, so
    // an ordinary workspace and an unanswered one both stay silent.
    const gdwLine = map.gappDev ? gappDevBrief(map.gappDev) : null;
    if (gdwLine) {
        lines.push('## This is a GApp Development Workspace');
        lines.push(gdwLine);
        lines.push('');
    }

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
 * The `manageGappDev` answer, as the agent reads it.
 *
 * Leads with the OUTCOME of the action, then always re-states where the agent is
 * — the status is the point of the tool, and burying it under a findings list
 * would recreate the "I could not tell" failure one level down.
 *
 * A clean check reports what it COVERED. "No problems" from a suite that quietly
 * skipped everything is the false reassurance the suite exists to remove — the
 * same reason Workspace Settings prints the count there.
 */
export function formatGappDevResult(result: ManageGappDevResult): string {
    const lines: string[] = [];

    if (!result.ok) {
        lines.push(result.error ?? `manageGappDev ${result.action} failed.`);
    } else if (result.check) {
        const errors = result.check.findings.filter((f) => f.severity === 'error');
        const advice = result.check.findings.filter((f) => f.severity === 'advice');
        lines.push(
            result.check.ok
                ? `This app is ready to install. ${result.check.ran.length} checks ran.`
                : `This app will NOT work yet — ${errors.length} error${errors.length === 1 ? '' : 's'} from ${result.check.ran.length} checks.`,
        );
        for (const f of [...errors, ...advice]) {
            lines.push(`- [${f.severity}] ${f.where}: ${f.problem} → ${f.fix}`);
        }
    } else if (result.preview) {
        lines.push(
            result.action === 'close-preview'
                ? result.preview.appId
                    ? `Preview \`${result.preview.appId}\` closed.`
                    : 'Preview closed.'
                : `Preview open${result.preview.homeUrl ? ` at ${result.preview.homeUrl}` : ''}${
                      result.preview.appId ? ` (\`${result.preview.appId}\`)` : ''
                  }.`,
        );
        for (const w of result.preview.warnings ?? []) lines.push(`- warning: ${w}`);
    }

    if (lines.length) lines.push('');
    lines.push(formatGappDevStatus(result.status));
    return lines.join('\n');
}

/**
 * How the `feedback` bucket explains itself in the count line.
 *
 * The audience is an AGENT deciding what to do next, and every other number on
 * this line is a defect of some kind — so a bare tally reads as another thing
 * that has gone wrong, and the obvious response to "4 open" is to go and make it
 * zero. Both readings are wrong. Feedback is input from outside the build that
 * has not been triaged yet, and deciding whether a given piece is worth acting
 * on is the part that stays with a human; an agent that closes entries to tidy
 * the list destroys exactly the signal the count exists to surface.
 */
function feedbackNote(count: number): string {
    return (
        `feedback:${count} is unresolved project feedback in Tynn — people's input waiting on ` +
        'triage, not a failure and not a list to clear for tidiness. Read it with the Tynn ' +
        '`feedback` tool and convert what should become work; judging whether a piece of ' +
        'feedback is worth acting on stays a human call.'
    );
}

/**
 * The concise IssueWatch counts line appended to an `imDone` response (and
 * usable standalone), e.g. `IssueWatch — issues:3, PR:1, sec:3, feedback:2`.
 * Returns null when there's nothing to report (not connected, no workspace, or
 * zero items), so callers can omit the line entirely rather than print a noisy
 * "none".
 */
export function formatIssueCountsLine(snap: IssueWatchSnapshot): string | null {
    if (!snap.connected || !snap.workspaceResolved) return null;
    if (snap.knownToServer === false) {
        return 'IssueWatch — unknown / not tracking this workspace yet';
    }
    const { issue, pr, security, feedback } = snap.counts;
    // Feedback counts toward "is there anything to say" on its own. A workspace
    // with no repositories registered has an all-zero GitHub triple by
    // definition, and that is precisely where feedback may be the only thing
    // waiting — suppressing the line there would hide the datapoint exactly
    // where it is the whole message.
    if (!issue && !pr && !security && !feedback) return null;
    const base = `IssueWatch — issues:${issue}, PR:${pr}, sec:${security}, feedback:${feedback}`;
    // Fold the user's PER-BUCKET remediation preference in so the count line
    // actually steers the agent per bucket. Only buckets with something OPEN get a
    // directive; security is listed first (fix it first — NO bandaids). When every
    // OPEN bucket is 'surface' (or there's no policy at all) the bare counts are
    // kept — backward compatible with the old single-'surface' behaviour.
    //
    // The feedback note is appended AFTER any remediation clause so the
    // actionable GitHub directive stays next to the numbers it refers to, and
    // so feedback is visibly not part of it.
    const suffix = feedback > 0 ? ` · ${feedbackNote(feedback)}` : '';
    const policy = snap.policy;
    if (!policy) return base + suffix;
    // GITHUB buckets only — see IssueWatchSnapshot.policy for why feedback has
    // no remediation mode.
    const active = [
        { label: 'security', count: security, mode: policy.security },
        { label: 'issues', count: issue, mode: policy.issue },
        { label: 'PRs', count: pr, mode: policy.pr },
    ].filter((b) => b.count > 0);
    if (active.every((b) => b.mode === 'surface')) return base + suffix;
    const describe = (mode: 'surface' | 'fix' | 'fix-and-ship'): string =>
        mode === 'fix-and-ship'
            ? 'fix at the ROOT CAUSE (NO bandaids) and ship right away'
            : mode === 'fix'
                ? 'fix at the ROOT CAUSE (NO bandaids), then report before shipping'
                : 'surface only (hold)';
    const parts = active.map((b) => `${b.label}: ${describe(b.mode)}`);
    return `${base} · remediation — ${parts.join('; ')} (act on these when no other work is in progress).${suffix}`;
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
    // STILL RUNNING (genie#194). Read before `state`, because the row's state is
    // whatever it was BEFORE this action finished — reporting that as the outcome
    // is how a call that returned early gets read as a call that succeeded.
    if (result.pending) {
        const phase = target?.phase ? ` (${target.phase})` : '';
        return `${target?.name ?? 'The site'} is still coming up${phase} — this call returned before it settled, so it did not hit the 120s tool timeout. Poll \`manageSite {action:'status', id:'${result.affectedId}'}\` until \`phase\` is \`ready\` or \`failed\`; do not report it live yet.`;
    }
    if (target) {
        if (target.state === 'failed') {
            return `${target.name} could not start: ${target.error ?? 'unknown error'}`;
        }
        if (target.state !== 'running') {
            return `${target.name} is ${target.state}.`;
        }
        const where = target.origin ?? target.localOrigin ?? '';
        // The local form is spelled out rather than left to be derived from
        // `hostPort`: a container site's port is the sandbox's Caddy (TLS + SNI), so
        // the obvious `curl http://127.0.0.1:<port>/` answers "Client sent an HTTP
        // request to an HTTPS server" and reads like the app is broken (genie#195).
        const locally = target.localCurl ? ` From this machine: \`${target.localCurl}\`.` : '';
        if (target.ready) return `${target.name} is serving at ${where}.${locally}`;
        // NOT-ANSWERING (genie#227). Two faults were reported in the old sentence.
        //
        // It said "container" for `runMode: host`, which is documented as having
        // none — sending the reporter hunting something that does not exist.
        //
        // And "may still be starting" is UNFALSIFIABLE: a permanent
        // misconfiguration and a slow boot read identically, forever, so there is
        // no reading of it that ever means "this is broken". The host owns the
        // port — it allocates one at start and rewrites the command to match — so
        // when an app binds a port of its own instead, Genie proxies into nothing
        // and nothing ever appears. Naming the port GENIE is watching, and how to
        // tell that case apart, is what makes the message checkable.
        const isHost = target.runMode === 'host';
        const noun = isHost ? 'process' : 'container';
        const watching = target.hostPort ?? target.port;
        return (
            `${target.name}'s ${noun} is up, but nothing is answering on port ${watching ?? '?'} — ` +
            `the port Genie allocated and is proxying to. Either it is still starting, or the app ` +
            `bound a DIFFERENT port: check \`logs\` for the port it reports, and ` +
            `\`curl http://127.0.0.1:${watching ?? 'PORT'}/\` from this machine. If the app answers ` +
            `somewhere else, its command is binding a port Genie did not allocate.`
        );
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
    // A `note` is a consequence the caller must know about even though nothing
    // FAILED — a declined purge, a switched version whose data did not follow.
    // It LEADS, because the alternative is a headline that reads like plain
    // success with the part that matters folded into a JSON field nobody opened.
    const note = result.note?.trim();
    if (note) return `${note} ${manageServiceSummary({ ...result, note: undefined })}`.trim();
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
/**
 * The one line that says whether a REQUESTED refresh happened, and when the next
 * one is allowed.
 *
 * Always both facts together. The owner's requirement is that no agent can
 * obtain fresh counts without also learning the cooldown — otherwise the next
 * agent asks again immediately, is refused, and reads the refusal as a bug.
 *
 * The window belongs to the WORKSPACE and is shared with every other agent and
 * the human, which is said out loud: "why was I refused when I never refreshed"
 * is exactly the confusion a per-agent reading of the limit produces.
 */
function refreshLine(r: NonNullable<IssueWatchSnapshot['refresh']>): string {
    if (r.reason === 'failed' || r.reason === 'unavailable') {
        // Never a wait invented on Tynn's behalf: it did not serve the request,
        // so it did not charge the window either.
        const why = r.error ? ` — ${r.error}` : '';
        return `IssueWatch refresh FAILED${why}. The feed below is the one Genie already had, not a fresh read. Nothing was spent, so you can try again now.`;
    }
    if (!r.refreshed) {
        return `IssueWatch NOT REFRESHED — this workspace's refresh window is still cooling down; ${r.cooldown.label} left (the window is shared with every agent and the human in this workspace). The feed below is the current one.`;
    }
    return `Refreshed. The next manual refresh for this workspace is allowed in ${r.cooldown.label} (that window is shared with every agent and the human here).`;
}

export function formatIssueWatchFeed(snap: IssueWatchSnapshot): string {
    const head = snap.refresh ? `${refreshLine(snap.refresh)}

` : '';
    return head + issueWatchFeedBody(snap);
}

function issueWatchFeedBody(snap: IssueWatchSnapshot): string {
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
    const { issue, pr, security, feedback } = snap.counts;
    // Feedback has no items on this feed (it is a count from Tynn, read in full
    // through the Tynn `feedback` tool), so an empty GitHub feed still has
    // something to report when feedback is waiting. Saying "nothing open" over a
    // non-zero feedback tally would be a false all-clear.
    if (snap.items.length === 0) {
        const nothingOpen =
            "IssueWatch — nothing open across this workspace's repos (no Issues, PRs, or security alerts).";
        return feedback > 0 ? `${nothingOpen}\n\n${feedbackNote(feedback)}` : nothingOpen;
    }
    const lines: string[] = [
        `IssueWatch — ${issue} issue(s), ${pr} PR(s), ${security} security alert(s) across this workspace's repos:`,
    ];
    if (feedback > 0) {
        lines.push('');
        lines.push(feedbackNote(feedback));
    }
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

const MANAGE_GAPP_DEV_TOOL = {
    name: 'manageGappDev',
    description:
        'Build the Genie App this workspace is the home of. A GApp Development Workspace (GDW) is a workspace whose linked Tynn project is marked `is_gapp` — the place an app is BUILT, as opposed to a workspace where an installed app RUNS. `status` answers whether you are in one (you cannot tell from the filesystem, and the chrome that says so is only visible to the user); `check` runs the full check suite over this folder — manifest, files, agents, services, front end — and is deliberately stricter than the installer, because an app that installs cleanly and then opens on an empty window is the failure it exists to catch; `preview` opens the app in a REAL GApp window on the live source under its own `<slug>.preview` identity and address, so it cannot collide with an installed copy; `close-preview` tears one down. Every action also reports the GDW status, so a single call tells you where you are. No folder argument: in a GDW, Genie already knows which app you mean.',
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            action: {
                type: 'string',
                enum: ['status', 'check', 'preview', 'close-preview'],
                description:
                    'status: am I in a GDW, and what is in it. check: run the suite over this folder. preview: open the app in a real window on live source. close-preview: shut one down.',
            },
            appId: {
                type: 'string',
                description:
                    'close-preview (optional): which preview to close. Defaults to this workspace’s own.',
            },
        },
        required: ['action'],
        additionalProperties: false,
    },
};

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
 * The sentence that stops a read of 0 bytes from being ambiguous (genie#217).
 *
 * An agent monitoring a terminal reads the SUMMARY line, and "0 bytes" alone
 * cannot distinguish a quiet agent from one whose pty died or whose output
 * Genie can no longer see. Say which it is, in words, right there.
 */
function readStateNote(state: TerminalReadState | undefined): string {
    if (state === 'exited') {
        return " This terminal's pty is not running, so there is nothing to read — 0 bytes here does NOT mean the terminal is idle.";
    }
    if (state === 'restored') {
        return ' Its output buffer was missing (Genie restarted) and was restored from the pty host, so this is earlier scrollback.';
    }
    return '';
}

/**
 * Every tool Genie itself advertises, in the order `tools/list` presents them.
 *
 * One source of truth rather than a literal built inline: the GApp capability
 * catalogue (`apps/capabilities.ts`) classifies this list so that no tool can
 * exist outside its permission model, and that check is only as good as the list
 * it reads. `manageService` is here but filtered at list time — a machine with no
 * container runtime never sees it.
 */
const CORE_TOOLS = [
    IMDONE_TOOL,
    THUMBS_UP_TOOL,
    CHECK_ISSUES_TOOL,
    FORCE_QUESTION_TOOL,
    MANAGE_PROCESS_TOOL,
    PROVISION_WORKSPACES_TOOL,
    MANAGE_SITE_TOOL,
    MANAGE_SERVICE_TOOL,
    MANAGE_GAPP_DEV_TOOL,
    MANAGE_TERMINALS_TOOL,
    REGISTER_AGENT_TOOL,
    RUN_AGENT_TOOL,
    MANAGE_WORKSPACES_TOOL,
    AGENTINBOX_TOOL,
    KNOWLEDGE_TOOL,
    OPEN_FILE_TOOL,
    SET_ENV_TOOL,
    CHECK_ENV_TOOL,
    SUBMIT_FEEDBACK_TOOL,
    INITIALIZE_WORKSPACE_TOOL,
    GUIDE_TOOL,
];

/** The names of {@link CORE_TOOLS}. */
export const GENIE_TOOL_NAMES: readonly string[] = CORE_TOOLS.map((t) => t.name);

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
            // `provisionWorkspaces` is ALWAYS advertised (genie #85). It is
            // self-describing ("ONLY usable from an Ops project's workspace") and
            // its handler is the single authoritative Ops gate — a non-Ops caller
            // gets a clear "not an Ops project" error. Visibility must be a STATIC
            // fact, never a runtime probe: a client fetches tools/list ONCE at
            // connection setup, so gating the tool on a fail-closed network check
            // (`isOpsProject`) silently HID it from genuine Ops workspaces on any
            // transient backend hiccup — the exact regression #85 reported, leaving
            // no agent-callable path to provision a governed child. The Ops check
            // now lives only where it can't misfire at the wrong time: in the
            // handler, at call time, where the error is actionable.
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
            // host. Only a sandbox (`explicit`) site and `manageService` need a
            // container runtime; the probe (fail CLOSED) gates ONLY manageService, so
            // a machine with no Docker never sees a tool whose every call would fail.
            const hasContainerRuntime = await (
                ctx.devServerAvailable?.(ctx.terminalId) ?? Promise.resolve(false)
            ).catch(() => false);
            return ok(msg.id, {
                tools: [
                    ...CORE_TOOLS.filter(
                        (t) =>
                            t !== MANAGE_SERVICE_TOOL ||
                            (hasContainerRuntime && ctx.manageService),
                    ),
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
            if (params.name === 'thumbsUp') {
                if (!ctx.onThumbsUp) return err(msg.id, -32603, 'thumbsUp is unavailable.');
                const raw = (params.arguments ?? {}) as Record<string, unknown>;
                const reason = raw.reason === 'boot' || raw.reason === 'shutdown' ? raw.reason : 'ack';
                const to = typeof raw.to === 'string' && raw.to.trim() ? raw.to.trim() : undefined;
                const result = await ctx.onThumbsUp(ctx.terminalId, reason, to);
                const text = result.ok
                    ? `Agent ${result.agentId ?? ''} is ready (${reason}).`
                    : `thumbsUp failed: ${result.error ?? 'unknown error'}`;
                return ok(msg.id, { content: [{ type: 'text', text: `${text}\n\n${JSON.stringify(result, null, 2)}` }] });
            }
            if (params.name === 'imDone') {
                ctx.onImDone(ctx.terminalId);
                // Fold the caller's workspace IssueWatch counts into the response
                // so every "done" surfaces what's still open (issues/PRs/security
                // alerts) without a second call. Best-effort: a snapshot failure
                // never sinks the imDone ack.
                let countsLine: string | null = null;
                try {
                    countsLine = formatIssueCountsLine(
                        // imDone reports; it never SPENDS the workspace's shared
                        // refresh window on the agent's behalf.
                        await ctx.checkIssues(ctx.terminalId, { refresh: false }),
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
                // Always remind the agent to route questions/concerns through
                // ForceTheQuestion. A plaintext question printed here goes UNSEEN
                // — the Operator rarely watches THIS terminal — so it would just
                // stall the work. Unlike the IssueWatch lines above this is not
                // conditional; it's appended on every imDone.
                const ftqReminder =
                    'Questions or concerns for the Operator? Use ForceTheQuestion — never print a question and wait; a plaintext question goes unseen.';
                const extras = [countsLine, mailLine, ftqReminder]
                    .filter(Boolean)
                    .join('\n');
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
                const refresh = (params.arguments as { refresh?: unknown } | undefined)?.refresh === true;
                const snap = await ctx.checkIssues(ctx.terminalId, { refresh });
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
                    hostPort: a.hostPort,
                    hostServe: a.hostServe,
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
            if (params.name === 'manageGappDev') {
                const a = (params.arguments ?? {}) as Partial<ManageGappDevRequest>;
                const ACTIONS: ReadonlyArray<ManageGappDevAction> = [
                    'status',
                    'check',
                    'preview',
                    'close-preview',
                ];
                if (!a.action || !ACTIONS.includes(a.action)) {
                    return err(
                        msg.id,
                        -32602,
                        `manageGappDev requires \`action\`: ${ACTIONS.join(' | ')}.`,
                    );
                }
                // Advertised unconditionally, so a host that has not wired it says
                // so. Reporting "not a GDW" instead would answer a question nobody
                // asked with a fact nobody established.
                if (!ctx.manageGappDev) {
                    return ok(msg.id, {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: 'Genie App development is not available on this host, so `manageGappDev` cannot answer. This is NOT the same as "this workspace is not a GApp Development Workspace" — that question has not been asked.',
                            },
                        ],
                    });
                }
                const result = await ctx.manageGappDev(ctx.terminalId, {
                    action: a.action,
                    appId: a.appId,
                });
                return ok(msg.id, {
                    ...(result.ok ? {} : { isError: true }),
                    content: [{ type: 'text', text: formatGappDevResult(result) }],
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
                        ? `Read ${result.data?.length ?? 0} byte(s)${result.dropped ? ' (some earlier output was dropped)' : ''}.${readStateNote(result.state)}`
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
            if (params.name === 'registerAgent') {
                const a = (params.arguments ?? {}) as Partial<RegisterAgentRequest>;
                if (!a.name?.trim() || !a.purpose?.trim()) {
                    return err(msg.id, -32602, 'registerAgent requires non-empty `name` and `purpose`.');
                }
                if (!ctx.registerAgent) {
                    return err(msg.id, -32603, 'registerAgent is unavailable in this Genie runtime.');
                }
                const result = await ctx.registerAgent(ctx.terminalId, {
                    workspaceId: a.workspaceId,
                    name: a.name,
                    purpose: a.purpose,
                    agent: a.agent,
                    avatar: a.avatar,
                    bootFolder: a.bootFolder,
                });
                const summary = result.ok
                    ? `Registered ${result.agent?.provider ?? ''}:${result.agent?.name ?? ''}. Use runAgent start to launch it.`
                    : `registerAgent failed: ${result.error ?? 'unknown error'}`;
                return ok(msg.id, {
                    content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(result, null, 2)}` }],
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
                    action !== 'restart' &&
                    action !== 'list'
                ) {
                    return err(
                        msg.id,
                        -32602,
                        'runAgent requires `action`: start | send | read | stop | restart | list.',
                    );
                }
                const result = await ctx.runAgent(ctx.terminalId, {
                    action,
                    workspaceId: a.workspaceId,
                    name: a.name,
                    instructions: a.instructions,
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
                    // REATTACHED vs CREATED is the distinction this tool exists to
                    // make, so it leads the sentence rather than being left for the
                    // caller to infer from a terminal id it may not have seen before.
                    summary = result.reattached
                        ? `Reattached to saved agent ${result.ref ?? ''} (terminal ${result.id ?? '?'}).`
                        : `Started registered agent ${result.ref ?? ''} as terminal ${result.id ?? '?'}.`;
                } else if (action === 'list') {
                    summary = `${result.agents?.length ?? 0} saved agent(s) in this workspace.`;
                } else if (action === 'read') {
                    summary = `Read ${result.data?.length ?? 0} byte(s)${result.dropped ? ' (some earlier output was dropped)' : ''}.${readStateNote(result.state)}`;
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
                    action !== 'registerTransport' &&
                    action !== 'setAccessibility'
                ) {
                    return err(
                        msg.id,
                        -32602,
                        'agentinbox requires `action`: list | send | receive | receipts | saveAttachment | registerSession | registerTransport | setAccessibility.',
                    );
                }
                const result = await ctx.agentInbox(ctx.terminalId, {
                    action,
                    to: a.to,
                    text: a.text,
                    interrupt: a.interrupt,
                    cursor: a.cursor,
                    wait: a.wait,
                    timeoutMs: a.timeoutMs,
                    scope: a.scope,
                    workspaces: a.workspaces,
                    purpose: a.purpose,
                    sessionId: a.sessionId,
                    transport: a.transport,
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
                        '.';
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
                    // Passed through UNVALIDATED and possibly undefined: the store
                    // is the one authority on what a class may be, and it REFUSES
                    // an unknown one rather than filing the memory under a guess.
                    class: a.class,
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
            if (params.name === 'submitFeedback') {
                const a = (params.arguments ?? {}) as { message?: unknown };
                const message = typeof a.message === 'string' ? a.message.trim() : '';
                if (!message) {
                    return err(msg.id, -32602, 'submitFeedback requires a `message`.');
                }
                if (!ctx.submitFeedback) {
                    return ok(msg.id, {
                        content: [
                            {
                                type: 'text',
                                text: 'Feedback is not available on this host — it needs a workspace connected to a Tynn project.',
                            },
                        ],
                    });
                }
                const result = await ctx.submitFeedback(ctx.terminalId, message);
                return ok(msg.id, {
                    content: [
                        {
                            type: 'text',
                            text: result.ok
                                ? 'Feedback filed in Tynn. A human will see it in the project feedback list — you do not need to repeat it in the terminal.'
                                : `Could not file feedback: ${result.error ?? 'unknown error'}`,
                        },
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
