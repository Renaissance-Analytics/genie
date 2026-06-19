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

export interface McpContext {
    /** The terminal id this endpoint is bound to (from the URL token). */
    terminalId: string;
    serverName: string;
    serverVersion: string;
    /** Side effect for the imDone tool — pulse the caller's terminal. */
    onImDone: (terminalId: string) => void;
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
}

export interface ProvisionWorkspacesRequest {
    /** `status` = read-only list of children; `provision` = create the missing ones. */
    action: 'status' | 'provision';
}

export interface ProvisionWorkspacesResult {
    ok: boolean;
    /** Set when ok is false (not an ops project, signed out, user denied, …). */
    error?: string;
    /** True only when the caller's workspace is an Ops project. */
    isOps: boolean;
    /** Every governed child + its local status (status + provision both return it). */
    children: OpsChildInfo[];
    /** provision: the children whose workspace was cloned + registered (by name). */
    provisioned?: string[];
    /** provision: per-child failures (best-effort — one bad child doesn't abort). */
    errors?: string[];
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
        "Provision Genie workspaces for the child projects this Ops project governs. ONLY usable from an Ops project's workspace (returns an error elsewhere). An Ops project governs other (child) projects, each with its own `*.agi` envelope repo; this tool stands up a local Genie workspace for any governed child that doesn't have one yet. Actions: `status` (read-only — list every governed child with status `present` (a local workspace exists) or `missing` (none yet), plus the `*.agi` URL that would be cloned for each missing one); `provision` (clone + register a workspace for every missing child, then surface it in Genie). It's provision-only — it never removes extra or un-governed workspaces. Approval depends on the `ops_auto_provision_workspaces` setting (Settings → per-workspace): when OFF (default) `provision` blocks until you approve the plan in Genie; when ON it provisions directly. Pass `terminalId` (your GENIE_TERMINAL_ID) for exact workspace resolution; omit to use the most-recently-active terminal.",
    inputSchema: {
        type: 'object',
        properties: {
            ...TERMINAL_ID_PROP,
            action: {
                type: 'string',
                enum: ['status', 'provision'],
                description:
                    'status: list governed children + each one\'s workspace status. provision: create the missing child workspaces (honouring the approval toggle).',
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
                            description: 'The full question text shown to the user.',
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

        case 'tools/list':
            return ok(msg.id, {
                tools: [
                    IMDONE_TOOL,
                    FORCE_QUESTION_TOOL,
                    MANAGE_PROCESS_TOOL,
                    PROVISION_WORKSPACES_TOOL,
                    GUIDE_TOOL,
                ],
            });

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
                return ok(msg.id, {
                    content: [
                        {
                            type: 'text',
                            text: 'Done — this terminal is now glowing in Genie until you focus it.',
                        },
                    ],
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
                if (action !== 'status' && action !== 'provision') {
                    return err(
                        msg.id,
                        -32602,
                        'provisionWorkspaces requires `action`: status | provision.',
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
                    const head = `${result.children.length} governed child project${
                        result.children.length === 1 ? '' : 'ren'
                    } — ${present} present, ${missing} missing.`;
                    const tail =
                        action === 'provision'
                            ? ` Provisioned ${result.provisioned?.length ?? 0}${
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
            return err(msg.id, -32602, `Unknown tool: ${String(params.name)}`);
        }

        default:
            return err(msg.id, -32601, `Method not found: ${msg.method}`);
    }
}
