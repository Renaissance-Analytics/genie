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
import type {
    SetEnvRequest,
    SetEnvResult,
    CheckEnvRequest,
    CheckEnvResult,
} from '../env-store';
import type {
    WhisperScope,
    WhisperAgentInfo,
    WhisperChannelInfo,
    WhisperMessage,
} from '../whisper/types';

export type { SetEnvRequest, SetEnvResult, CheckEnvRequest, CheckEnvResult };
export type { WhisperScope, WhisperAgentInfo, WhisperChannelInfo, WhisperMessage };

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
     * Local inter-agent messaging (the WhisperChat `whisper` tool): discover peers
     * (scope-filtered), DM, channel broadcast, long-poll receive, accessibility.
     * Resolves the caller's whisper identity from the terminal (lazily joining a
     * plain terminal). `receive` + `wait` blocks (long-poll) — server.ts routes it
     * over the SSE keepalive path, like ForceTheQuestion.
     */
    whisper: (terminalId: string, req: WhisperRequest) => Promise<WhisperResult>;
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
}

export interface ManageProcessRequest {
    action: 'list' | 'create' | 'start' | 'stop' | 'restart';
    /** create: human label. */
    label?: string;
    /** create: the command line the runner executes. */
    command?: string;
    /** create: a repo subfolder name (repos/<repo>) to run in, else the root. */
    repo?: string;
    /** create: start now + on every launch. Default false. */
    autostart?: boolean;
    /** start | stop | restart: the target process id (from a prior list). */
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
    action: 'start' | 'send' | 'read' | 'stop';
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

// --- whisper -----------------------------------------------------------------

export interface WhisperRequest {
    /** `list` (discovery), `send`, `receive`, `setAccessibility`, `join`, `leave`. */
    action: 'list' | 'send' | 'receive' | 'setAccessibility' | 'join' | 'leave';
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
    scope?: WhisperScope;
    /** setAccessibility (scope `specific`): the workspace ids you're visible to. */
    workspaces?: string[];
    /** setAccessibility (optional): change your channel purpose (re-keys the room). */
    purpose?: string;
}

export interface WhisperResult {
    ok: boolean;
    /** Set when ok is false (bad args, unreachable target, unknown channel, …). */
    error?: string;
    /** list / setAccessibility: the caller's own agent info. */
    self?: WhisperAgentInfo;
    /** list: the peers discoverable by the caller (scope-filtered). */
    agents?: WhisperAgentInfo[];
    /** list / join / leave: the caller's channels. */
    channels?: WhisperChannelInfo[];
    /** receive: the new messages since the cursor. */
    messages?: WhisperMessage[];
    /** receive: the cursor to pass to the NEXT receive. */
    cursor?: number;
    /** send: how many recipients the message reached. */
    delivered?: number;
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
            "The terminal to act on. Pass the value of your GENIE_TERMINAL_ID environment variable so Genie targets exactly THIS terminal. If omitted, Genie falls back to the workspace's most-recently-active terminal.",
    },
} as const;

const IMDONE_TOOL = {
    name: 'imDone',
    description:
        "Signal that the agent has finished its work in THIS terminal. Genie pulses the terminal's glow in the workspace rail, the flyout row, and the panel border until you focus it. Pass `terminalId` (from your GENIE_TERMINAL_ID env) to target this exact terminal; omit it to use the workspace's most-recently-active terminal.",
    inputSchema: {
        type: 'object',
        properties: { ...TERMINAL_ID_PROP },
        additionalProperties: false,
    },
};

const CHECK_ISSUES_TOOL = {
    name: 'checkIssues',
    description:
        "Get a detailed list of the open GitHub Issues, Pull Requests, and SECURITY ALERTS (Dependabot, Code-scanning, Secret-scanning) that Genie's IssueWatch is tracking for THIS terminal's workspace — across every repo in the workspace. Use it to see what needs attention before you finish, or whenever you want the current open items with their numbers, titles, severities, and URLs. Read-only. (The same per-bucket counts are also appended to every `imDone` response.) Pass `terminalId` (your GENIE_TERMINAL_ID) for exact workspace resolution; omit to use the most-recently-active terminal.",
    inputSchema: {
        type: 'object',
        properties: { ...TERMINAL_ID_PROP },
        additionalProperties: false,
    },
};

const OPEN_FILE_TOOL = {
    name: 'openFileForUser',
    description:
        "Open a file in Genie's BUILT-IN editor for the USER to look at — surfaces it on the Floor in a Code panel. This REUSES an editor panel already open for this workspace (adds the file as a tab and focuses it — or just focuses the tab if the file is already open); if no editor panel is open for the workspace, it opens a NEW one with the file loaded. Use it to put a file in front of the user (a change you made, a result, something to review) instead of only describing it. Benign DISPLAY action — like imDone it just surfaces something, so there is NO approval prompt. `path` is workspace-relative (preferred) or absolute; for the System workspace pass an absolute/system path. Optional `line` reveals a 1-based line. Pass `terminalId` (your GENIE_TERMINAL_ID) for exact workspace resolution; omit to use the most-recently-active terminal. Available to System-workspace agents too.",
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
        'Return the full usage guide for the Genie MCP server (what each tool does, when to use it, and the zero-setup per-terminal contract). Call this when you want details beyond the brief in AGENTS.md.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

/**
 * The workspace-orientation PROMPT (was a tool through beta.3). It's USER-run —
 * the user invokes it from their client's prompt/slash-command UI on first boot
 * of a converted workspace — not something the agent calls autonomously. So it
 * lives under MCP prompts (prompts/list + prompts/get), not tools.
 */
export const INITIALIZE_WORKSPACE_PROMPT_NAME = 'initializeWorkspace';
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
        "Manage this workspace's background processes (Genie's Processes feature — long-running dev servers, queue workers, SSR, etc., supervised with status + crash auto-restart). Use it to set up or control processes you need while working. Actions: `list` (current processes + status); `create` (register a new one — needs `label` + `command`, optional `repo` to run inside repos/<repo>, optional `autostart` to start it now and on every launch); `start` / `stop` / `restart` (by `processId` from a prior list). Returns the resulting process list. Pass `terminalId` (your GENIE_TERMINAL_ID) for exact workspace resolution; omit to use the most-recently-active terminal.",
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            action: {
                type: 'string',
                enum: ['list', 'create', 'start', 'stop', 'restart'],
                description: 'What to do.',
            },
            label: {
                type: 'string',
                description: 'create: a human label for the process.',
            },
            command: {
                type: 'string',
                description: 'create: the command line the runner executes (e.g. "npm run dev").',
            },
            repo: {
                type: 'string',
                description:
                    'create (optional): a repo subfolder name to run inside (repos/<repo>); omit to run at the workspace root.',
            },
            autostart: {
                type: 'boolean',
                description: 'create (optional): start now and on every launch. Default false.',
            },
            processId: {
                type: 'string',
                description: 'start | stop | restart: the target process id (from a `list`).',
            },
        },
        required: ['action'],
        additionalProperties: false,
    },
};

const PROVISION_WORKSPACES_TOOL = {
    name: 'provisionWorkspaces',
    description:
        "Provision Genie workspaces for the child projects this Ops project governs. ONLY usable from an Ops project's workspace (returns an error elsewhere). An Ops project governs other (child) projects, each with its own `*.agi` envelope repo; this tool stands up a local Genie workspace for any governed child that doesn't have one yet. Actions: `status` (read-only — every governed child with status `present`/`missing`, the `*.agi` URL for each missing one, and `remote` — whether that repo actually EXISTS: `exists` → provisionable, `not-found` → the envelope was never published (use `scaffold`), `auth-required` → this Genie's git credentials can't reach it); `provision` (clone + register a workspace for every missing child whose envelope exists); `scaffold` (for each `remote:'not-found'` child with a registered source repo: build its `<slug>.agi` envelope locally around that source repo, CREATE the GitHub repo, push, and register the workspace — always blocks on your approval in Genie). It's provision-only — it never removes extra or un-governed workspaces. `provision` approval honours the `ops_auto_provision_workspaces` setting; `scaffold` ALWAYS asks. Pass `terminalId` (your GENIE_TERMINAL_ID) for exact workspace resolution; omit to use the most-recently-active terminal.",
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
        "Launch and control a CODING AGENT (claude / codex / a custom CLI) inside a terminal — in your own workspace or one you govern. This SPAWNS AN AUTONOMOUS AGENT that can itself read, write, and run code, so it is high-power. A thin layer over manageTerminals. Actions: `start` (open a terminal and launch the agent — `agent` is 'claude' | 'codex' | 'custom', default 'claude'; the actual CLI command is configurable in Genie Settings, or pass an explicit `command` (required for 'custom' unless a custom command is configured); optional `repo`/`cwd`; returns the agent terminal's `id` + the launched command); `send` (deliver a `prompt` to the running agent `id` — SUBMITTED by default, even multi-line: the prompt is wrapped in bracketed paste with the Enter delivered separately so the agent's TUI submits it instead of leaving it parked as a pasted buffer; pass `submit:false` to load without sending, or `key` (`enter`/`escape`/`ctrl-c`) to deliver a bare keypress — e.g. a lone `enter` to submit or clear a stuck multi-line buffer); `read` (its output — `cursor` for new output, or `bytes` for the last N; add `strip:true` for plain text with escape codes removed); `stop` (terminate the agent `id`). SAFETY: `start` and `send` are APPROVAL-GATED — when the target workspace requires approval (the default) each blocks on an OS modal showing exactly what will launch/run until the user approves; OFF runs immediately. `read` never prompts.",
    inputSchema: {
        type: 'object',
        properties: {
            ...TARGET_WORKSPACE_PROP,
            action: {
                type: 'string',
                enum: ['start', 'send', 'read', 'stop'],
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
                description: 'send | read | stop: the agent terminal id (from a prior start).',
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

const WHISPER_TOOL = {
    name: 'whisper',
    description:
        "Coordinate with OTHER AI agents running in this Genie instance — WhisperChat, a LOCAL inter-agent messaging network. Discover peer agents (in your workspace, or across the workstation when they allow it), DM them 1:1, and broadcast on shared CHANNELS. Delivery is PULL-based — you POLL for messages, they're never injected into your terminal (which would corrupt your turn). Actions (`action`): `list` (discovery — returns YOUR agent info `self`, the peers you can reach `agents`, and your `channels`); `send` (message a peer with `to` = their agentId, OR broadcast with `channel` = a purpose like `frontend` (your workspace's room) or `slug:purpose` (another workspace's) — needs `text`; optional `interrupt:true` also glows a DM target's terminal so they notice); `receive` (fetch NEW messages — pass a `cursor` from a prior receive to page forward; set `wait:true` to LONG-POLL until a message arrives (optional `timeoutMs`), so you can block waiting for a peer's reply); `setAccessibility` (`scope`: `none` hidden / `self` your workspace only (default) / `specific` + `workspaces` a chosen set / `all` the whole workstation — governs who can see + DM you; optional `purpose` renames your channel); `join`/`leave` (`channel`) to opt in/out of a channel. Your identity + accessibility are remembered across restarts. Local-only — no relay, no cross-host.",
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['list', 'send', 'receive', 'setAccessibility', 'join', 'leave'],
                description: 'What to do.',
            },
            to: {
                type: 'string',
                description: 'send: the recipient agent id (DM). Mutually exclusive with `channel`.',
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
                    'receive (optional): LONG-POLL — block until a message arrives, you leave, or the timeout. Returns empty on timeout so you re-poll.',
            },
            timeoutMs: {
                type: 'number',
                description: 'receive (optional): long-poll window in ms (default ~55s, capped).',
            },
            scope: {
                type: 'string',
                enum: ['none', 'self', 'specific', 'all'],
                description:
                    'setAccessibility: who can see/DM you — none (hidden) / self (your workspace, default) / specific (a chosen set) / all (the workstation).',
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
        return 'IssueWatch — GitHub is not connected, so there are no items to show. Connect GitHub in Genie → Settings to enable issue/PR/security-alert watching.';
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
            return ok(msg.id, {
                tools: [
                    IMDONE_TOOL,
                    CHECK_ISSUES_TOOL,
                    FORCE_QUESTION_TOOL,
                    MANAGE_PROCESS_TOOL,
                    ...(isOps ? [PROVISION_WORKSPACES_TOOL] : []),
                    MANAGE_TERMINALS_TOOL,
                    RUN_AGENT_TOOL,
                    MANAGE_WORKSPACES_TOOL,
                    WHISPER_TOOL,
                    OPEN_FILE_TOOL,
                    SET_ENV_TOOL,
                    CHECK_ENV_TOOL,
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
                const base =
                    'Done — this terminal is now glowing in Genie until you focus it.';
                return ok(msg.id, {
                    content: [
                        {
                            type: 'text',
                            text: countsLine ? `${base}\n\n${countsLine}` : base,
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
                return ok(msg.id, {
                    content: [{ type: 'text', text: GENIE_MCP_GUIDE }],
                });
            }
            if (params.name === 'manageProcess') {
                const a = params.arguments ?? {};
                const action = a.action;
                if (
                    action !== 'list' &&
                    action !== 'create' &&
                    action !== 'start' &&
                    action !== 'stop' &&
                    action !== 'restart'
                ) {
                    return err(
                        msg.id,
                        -32602,
                        'manageProcess requires `action`: list | create | start | stop | restart.',
                    );
                }
                const result = await ctx.manageProcess(ctx.terminalId, {
                    action,
                    label: a.label,
                    command: a.command,
                    repo: a.repo,
                    autostart: a.autostart,
                    processId: a.processId,
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
                    action !== 'stop'
                ) {
                    return err(
                        msg.id,
                        -32602,
                        'runAgent requires `action`: start | send | read | stop.',
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
            if (params.name === 'whisper') {
                const a = (params.arguments ?? {}) as Partial<WhisperRequest>;
                const action = a.action;
                if (
                    action !== 'list' &&
                    action !== 'send' &&
                    action !== 'receive' &&
                    action !== 'setAccessibility' &&
                    action !== 'join' &&
                    action !== 'leave'
                ) {
                    return err(
                        msg.id,
                        -32602,
                        'whisper requires `action`: list | send | receive | setAccessibility | join | leave.',
                    );
                }
                const result = await ctx.whisper(ctx.terminalId, {
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
                });
                let summary: string;
                if (!result.ok) {
                    summary = `whisper failed: ${result.error ?? 'unknown error'}`;
                } else if (action === 'list') {
                    summary = `${result.agents?.length ?? 0} agent(s) reachable, ${
                        result.channels?.length ?? 0
                    } channel(s).`;
                } else if (action === 'receive') {
                    summary = `${result.messages?.length ?? 0} new message(s).`;
                } else if (action === 'send') {
                    summary = `Sent — delivered to ${result.delivered ?? 0} recipient(s).`;
                } else {
                    summary = `whisper ${action} ok.`;
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
                const result = await ctx.onForceQuestion(ctx.terminalId, questions);
                if (result.cancelled) {
                    return ok(msg.id, {
                        content: [
                            {
                                type: 'text',
                                text: 'The user dismissed the question without answering.',
                            },
                        ],
                    });
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
