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

const INITIALIZE_WORKSPACE_TOOL = {
    name: 'initializeWorkspace',
    description:
        "Call this FIRST when you start in a fresh or newly-converted Genie workspace, before doing any work. It returns a MAP of the workspace — the .agi envelope, its `.ai/knowledge`, and (the main resource) every repo under repos/ with its path, GitHub owner/repo, and which orientation files exist (README, AGENTS.md, CLAUDE.md, package manifest) — plus a numbered plan for learning the project. It does NOT read file contents; use your own file tools to follow the plan. Pass `terminalId` (your GENIE_TERMINAL_ID) for exact resolution; omit it to use the workspace's most-recently-active terminal.",
    inputSchema: {
        type: 'object',
        properties: { ...TERMINAL_ID_PROP },
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
                capabilities: { tools: { listChanged: false } },
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
                    INITIALIZE_WORKSPACE_TOOL,
                    IMDONE_TOOL,
                    FORCE_QUESTION_TOOL,
                    GUIDE_TOOL,
                ],
            });

        case 'tools/call': {
            const params = (msg.params ?? {}) as {
                name?: string;
                arguments?: { questions?: ForceQuestion[] };
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
            if (params.name === 'initializeWorkspace') {
                const map = await ctx.describeWorkspace(ctx.terminalId);
                if (!map) {
                    return ok(msg.id, {
                        content: [
                            {
                                type: 'text',
                                text: "Couldn't resolve this terminal to a Genie workspace. Open this terminal inside a workspace (or pass your GENIE_TERMINAL_ID as `terminalId`) and try again.",
                            },
                        ],
                    });
                }
                return ok(msg.id, {
                    content: [{ type: 'text', text: formatWorkspaceMap(map) }],
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
