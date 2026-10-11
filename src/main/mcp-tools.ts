import { ToolDefinition, type JsonObject, type McpToolResult } from '@particle-academy/prism-mcp';
import { type Question } from '../core/attention.js';
import type { AgentId, AgentRecord } from '../core/identity.js';
import { HUMAN, addressOf, reachable, resolveAddress, type Participant, type WorkspaceInboxSetting } from '../core/inbox.js';
import type { AttentionStore } from './attention-store.js';
import type { InboxStore } from './inbox-store.js';

/**
 * GENIE'S MCP TOOLS — imDone, ForceTheQuestion, agentinbox, lists, thumbsUp (§6.3, §6.4).
 *
 * Built to the contract agreed with prism on prism-mcp-ts#1 and unchanged by the decision to
 * ship the server as `@particle-academy/prism-mcp-server`:
 *
 *     server.register(new ToolDefinition(name, description, inputSchema, title, annotations), handler)
 *     handler(args, { server, tool, headers }) → McpToolResult { text, isError }
 *
 * `ToolDefinition`, `JsonObject` and `McpToolResult` are prism-mcp's own exports, so a round
 * trip through both halves is the identity. `ToolHandler` is declared here with the exact shape
 * prism gave, and swaps to the server package's export when that exists.
 *
 * ## No transport, no push
 *
 * Request/response only. The ForceTheQuestion answer reaches the asker through `agentinbox
 * receive` — a long-poll held open by the store — never a server-initiated notification, because
 * prism-mcp is stateless by design (G-52) and has no client identity to push to.
 *
 * ## Attribution is Genie's
 *
 * Every tool takes `terminalId`, the value of `GENIE_TERMINAL_ID` in the caller's environment.
 * Genie maps it to the agent in that terminal; the server just carries the argument. A missing
 * or unknown id is an error naming it — Genie never guesses which terminal is calling, because a
 * wrong guess glows the wrong row and files a handoff under the wrong name. The argument is
 * declared mirrored (`x-mcp-header`), so a client may also send it as `Mcp-Param-terminalId`;
 * the handler reads both, because a handler that read only `args` would silently miss it.
 */

export interface ToolContext {
    readonly server: string;
    readonly tool: string;
    readonly headers: Record<string, string>;
}

/** prism's shape, verbatim. Replaced by the import from `prism-mcp-server` when it ships. */
export type ToolHandler = (args: JsonObject, context: ToolContext) => McpToolResult | Promise<McpToolResult>;

export interface Registration {
    readonly definition: ToolDefinition;
    readonly handler: ToolHandler;
}

/** Who is calling: the agent in the terminal `GENIE_TERMINAL_ID` names. */
export interface Caller {
    readonly agentId: AgentId;
    readonly agentName: string;
    readonly workspaceId: string;
    readonly workspacePath: string;
}

export interface GenieToolsDeps {
    readonly inbox: InboxStore;
    readonly attention: AttentionStore;
    readonly roster: () => readonly AgentRecord[];
    readonly resolveCaller: (terminalId: string) => Caller | null;
    readonly workspaceSetting: (workspaceId: string) => WorkspaceInboxSetting;
    readonly userActive: () => boolean;
    /** Pulse the terminal's row. Returns whether anything received the signal. */
    readonly glow: (terminalId: string) => boolean;
    readonly thumbsUp: (caller: Caller, reason: string) => void;
    /** DND (§6.3): whether the person is away, and what to tell an agent that asks. */
    readonly dnd?: () => { on: boolean; reply: string };
}

const MIRRORED_TERMINAL_ID: JsonObject = {
    type: 'string',
    description: 'The value of GENIE_TERMINAL_ID in your environment. Required: Genie refuses to guess which terminal is calling.',
    'x-mcp-header': { type: 'string' },
};

function ok(payload: unknown): McpToolResult {
    return { text: JSON.stringify(payload), isError: false };
}

function err(message: string): McpToolResult {
    return { text: JSON.stringify({ ok: false, error: message }), isError: true };
}

function str(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

export function genieTools(deps: GenieToolsDeps): Registration[] {
    /**
     * Resolve the caller or produce the error. Reads `args.terminalId` first, then the mirrored
     * header (`Mcp-Param-terminalId`, lower-cased by HTTP).
     */
    const withCaller = (
        body: (caller: Caller, args: JsonObject, context: ToolContext) => McpToolResult | Promise<McpToolResult>,
    ): ToolHandler => async (args, context) => {
        const headerValue = Object.entries(context.headers).find(([k]) => k.toLowerCase() === 'mcp-param-terminalid')?.[1];
        const terminalId = str(args.terminalId) ?? headerValue;
        if (!terminalId) return err('terminalId is required — pass the value of GENIE_TERMINAL_ID; Genie will not guess which terminal is calling');
        const caller = deps.resolveCaller(terminalId);
        if (!caller) return err(`terminal ${terminalId} is not one Genie knows; nothing was done`);
        try {
            return await body(caller, args, context);
        } catch (error) {
            return err((error as Error).message);
        }
    };

    const imDone: Registration = {
        definition: new ToolDefinition(
            'imDone',
            'Signal that you have finished in THIS terminal. Genie glows the row until focused. ALWAYS pass a handoff — what you were doing, what is unfinished, what the next run picks up; it REPLACES the previous note and the response says whether it landed.',
            {
                type: 'object',
                properties: {
                    terminalId: MIRRORED_TERMINAL_ID,
                    handoff: { type: 'string', description: 'The note for the next run of this agent. Omit only when there is genuinely nothing to carry.' },
                },
                required: ['terminalId'],
            },
            'I’m done',
        ),
        handler: withCaller(async (caller, args) => {
            const terminalId = str(args.terminalId) ?? '';
            const glowed = deps.glow(terminalId);
            const handoff = str(args.handoff);
            const r = await deps.attention.imDone({
                agentId: caller.agentId,
                agentName: caller.agentName,
                workspacePath: caller.workspacePath,
                workspaceId: caller.workspaceId,
                ...(handoff === undefined ? {} : { handoff }),
            });
            return ok({ ok: true, glowed, handoff: r.handoff, checklist: r.checklist });
        }),
    };

    const forceTheQuestion: Registration = {
        definition: new ToolDefinition(
            'ForceTheQuestion',
            'Ask the user 1–4 questions (2–4 options each, free text always offered). Returns immediately; the answer arrives through `agentinbox receive`. Never blocks. A repeat of the same question is rejoined, not duplicated. Name the actor in options the user reads: "Agent: …" / "You: …".',
            {
                type: 'object',
                properties: {
                    terminalId: MIRRORED_TERMINAL_ID,
                    priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
                    questions: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 4,
                        items: {
                            type: 'object',
                            properties: {
                                header: { type: 'string', maxLength: 12 },
                                question: { type: 'string', description: 'Markdown.' },
                                multiSelect: { type: 'boolean' },
                                options: {
                                    type: 'array',
                                    minItems: 2,
                                    maxItems: 4,
                                    items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] },
                                },
                            },
                            required: ['header', 'question', 'options'],
                        },
                    },
                },
                required: ['terminalId', 'questions'],
            },
            'Force the question',
        ),
        handler: withCaller(async (caller, args) => {
            const questions = Array.isArray(args.questions) ? (args.questions as unknown as Question[]) : [];
            const priority = str(args.priority) as 'low' | 'normal' | 'high' | 'urgent' | undefined;
            const r = await deps.attention.ask(
                { agentId: caller.agentId, agentName: caller.agentName, workspaceId: caller.workspaceId, questions, ...(priority ? { priority } : {}) },
                { userActive: deps.userActive(), dnd: deps.dnd?.() },
            );
            return ok(r);
        }),
    };

    const agentinbox: Registration = {
        definition: new ToolDefinition(
            'agentinbox',
            'Durable 1:1 messaging with other agents and the user. list → peers and whether you may reach them (permission, not liveness); send → to an address ({provider}:{name}, {workspace}:{provider}:{name}, or human) with optional byte-copied attachments; receive → your mail (wait:true long-polls; acknowledge:false leaves it unread; cursor rewinds); receipts → whether what you sent was read; saveAttachment → write an attachment you received.',
            {
                type: 'object',
                properties: {
                    terminalId: MIRRORED_TERMINAL_ID,
                    action: { type: 'string', enum: ['list', 'send', 'receive', 'receipts', 'saveAttachment'] },
                    to: { type: 'string' },
                    text: { type: 'string' },
                    attachments: { type: 'array', items: { type: 'string' }, description: 'Paths. Read and copied at send time; never stored as paths. Executables refused.' },
                    wait: { type: 'boolean' },
                    timeoutMs: { type: 'number' },
                    cursor: { type: 'number' },
                    acknowledge: { type: 'boolean' },
                    limit: { type: 'number' },
                    attachmentId: { type: 'string' },
                    path: { type: 'string' },
                    overwrite: { type: 'boolean' },
                },
                required: ['terminalId', 'action'],
            },
            'AgentInbox',
        ),
        handler: withCaller(async (caller, args) => {
            const me = deps.roster().find((r) => r.id === caller.agentId);
            const action = str(args.action) ?? '';
            switch (action) {
                case 'list': {
                    const others = deps.roster().filter((r) => r.id !== caller.agentId);
                    const peers = others.map((r) => {
                        const shortShared = others.filter((o) => o.provider === r.provider && o.name === r.name).length > 1;
                        return {
                            address: addressOf(r, shortShared ? 'full' : 'short'),
                            name: r.name,
                            provider: r.provider,
                            workspaceId: r.workspaceId,
                            reachable: me ? reachable(me, r, deps.workspaceSetting) : false,
                        };
                    });
                    return ok({ ok: true, peers, human: { address: HUMAN, reachable: true } });
                }
                case 'send': {
                    const to = str(args.to);
                    const text = str(args.text);
                    if (!to) return err('send needs `to`');
                    if (text === undefined) return err('send needs `text`');
                    const target = resolveAddress(to, deps.roster());
                    let recipient: Participant;
                    if (target.kind === 'human') recipient = HUMAN;
                    else if (target.kind === 'none') return err(`nobody at ${to}; use \`agentinbox list\` for the addresses that resolve`);
                    else if (target.kind === 'ambiguous') return err(`${to} names more than one agent — use one of: ${target.forms.join(', ')}`);
                    else {
                        const record = deps.roster().find((r) => r.id === target.id)!;
                        if (!me || !reachable(me, record, deps.workspaceSetting)) {
                            return err(`${to} is not reachable from ${caller.agentName}: the target's workspace setting or agent scope does not allow it (permission, not liveness)`);
                        }
                        recipient = target.id;
                    }
                    const attachments = Array.isArray(args.attachments) ? (args.attachments as unknown[]).filter((a): a is string => typeof a === 'string') : [];
                    const message = await deps.inbox.send({ from: caller.agentId, to: recipient, text, attachments });
                    return ok({ ok: true, delivered: 1, messageId: message.id, attachments: message.attachments });
                }
                case 'receive': {
                    const page = await deps.inbox.receive({
                        participant: caller.agentId,
                        ...(typeof args.cursor === 'number' ? { cursor: args.cursor } : {}),
                        ...(typeof args.acknowledge === 'boolean' ? { acknowledge: args.acknowledge } : {}),
                        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
                        ...(typeof args.wait === 'boolean' ? { wait: args.wait } : {}),
                        ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
                    });
                    return ok({ ok: true, messages: page.messages, cursor: page.cursor });
                }
                case 'receipts':
                    return ok({ ok: true, receipts: deps.inbox.receipts(caller.agentId, typeof args.limit === 'number' ? args.limit : undefined) });
                case 'saveAttachment': {
                    const attachmentId = str(args.attachmentId);
                    const path = str(args.path);
                    if (!attachmentId || !path) return err('saveAttachment needs `attachmentId` and `path`');
                    const saved = await deps.inbox.saveAttachment(caller.agentId, attachmentId, path, { overwrite: args.overwrite === true });
                    return ok({ ok: true, path: saved });
                }
                default:
                    return err(`unknown action ${JSON.stringify(action)}; the actions are list, send, receive, receipts, saveAttachment`);
            }
        }),
    };

    const lists: Registration = {
        definition: new ToolDefinition(
            'lists',
            'Two lists per workspace: your own checklist (max 10, filed under your name, rides every imDone) and things only a PERSON can do (max 5, shared, shows who asked). Both refuse when full. A QUESTION is never a list item — use ForceTheQuestion.',
            {
                type: 'object',
                properties: {
                    terminalId: MIRRORED_TERMINAL_ID,
                    action: { type: 'string', enum: ['show', 'add', 'done', 'clear'] },
                    list: { type: 'string', enum: ['agent', 'user'] },
                    text: { type: 'string' },
                    id: { type: 'string' },
                },
                required: ['terminalId', 'action'],
            },
            'Lists',
        ),
        handler: withCaller(async (caller, args) => {
            const action = str(args.action) ?? '';
            const list = str(args.list) === 'user' ? 'user' : 'agent';
            const scope = { workspaceId: caller.workspaceId, agentId: caller.agentId };
            const nameOf = (id: string) => deps.roster().find((r) => r.id === id)?.name ?? id;
            const show = () => ({
                ok: true,
                agent: deps.attention.lists.show({ list: 'agent', ...scope }),
                user: deps.attention.lists.show({ list: 'user', ...scope }).map((i) => ({ ...i, askedBy: nameOf(i.askedBy) })),
            });
            switch (action) {
                case 'show':
                    return ok(show());
                case 'add': {
                    const text = str(args.text);
                    if (!text) return err('add needs `text`');
                    const r = await deps.attention.lists.add({ list, ...scope, text });
                    if (r.kind === 'full') return err(`the ${list} list is full (${r.limit} open items); finish or clear one before adding — nothing was dropped`);
                    if (r.kind === 'question') return err(r.reason);
                    return ok({ ...show(), item: r.item });
                }
                case 'done': {
                    const id = str(args.id);
                    if (!id) return err('done needs `id`');
                    const hit = await deps.attention.lists.done({ workspaceId: caller.workspaceId, id });
                    return hit ? ok(show()) : err(`no list item ${id} in this workspace`);
                }
                case 'clear': {
                    const cleared = await deps.attention.lists.clear({ list, ...scope });
                    return ok({ ...show(), cleared });
                }
                default:
                    return err(`unknown action ${JSON.stringify(action)}; the actions are show, add, done, clear`);
            }
        }),
    };

    const thumbsUp: Registration = {
        definition: new ToolDefinition(
            'thumbsUp',
            'Tell Genie you are ready (booted, connected, or a milestone reached) with a one-word reason.',
            {
                type: 'object',
                properties: { terminalId: MIRRORED_TERMINAL_ID, reason: { type: 'string' } },
                required: ['terminalId'],
            },
            'Thumbs up',
        ),
        handler: withCaller((caller, args) => {
            deps.thumbsUp(caller, str(args.reason) ?? '');
            return ok({ ok: true });
        }),
    };

    return [imDone, forceTheQuestion, agentinbox, lists, thumbsUp];
}
