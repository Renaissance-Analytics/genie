import { callerFrom } from './mcp-callers.js';
import { ToolDefinition, type JsonObject, type McpToolResult } from '@particle-academy/prism-mcp';
import type { KnowledgeStore, MemoryClass, Scope, ScopeFilter } from './knowledge-store.js';
import { MIRRORED_TERMINAL_ID, type Caller, type Registration, type ToolContext, type ToolHandler } from './mcp-tools.js';

/**
 * TWO MORE GENIE TOOLS on prism's contract (see `mcp-tools.ts` for the contract and attribution).
 *
 * `knowledge` — the §6.7 graph. `add` files into the caller's workspace unless `scope: 'system'`;
 * `search`/`list` cover system + the caller's workspace unless `scope: 'all'`, which is always
 * allowed: scope is noise reduction, not a boundary.
 *
 * `manageTerminals` — §6.5. `create` and `write` are APPROVAL-GATED through an injected gate (the
 * Deck's inline approval in production, a fake in tests): the person sees the command or the text
 * before a pty gets it. A multi-line write is wrapped in bracketed paste with Enter delivered as a
 * separate write, so a shell reads it as one paste rather than executing line one before line two
 * arrives. A read says `dropped: true` when the scrollback was cut at the engine's cap, because a
 * cut buffer presented whole is a lie the model will build on. The caller reaches its own
 * workspace's terminals and nothing else — and a refusal there never asks for approval.
 */

export type ApprovalGate = (caller: Caller, action: 'create' | 'write', detail: string) => Promise<'allowed' | 'denied'>;

export interface TerminalsPort {
    /** Why one more terminal would be refused in this workspace (its limit and what is running), or `null`. Absent = no limit. */
    refusal?(workspaceId: string): string | null;
    list(): ReadonlyArray<{ id: string; workspaceId: string; cwd?: string; pid: number; shell: string }>;
    open(options: { workspaceId: string; cwd: string; command?: string; shell?: boolean; env?: Readonly<Record<string, string>> }): { id: string; pid: number; shell: string; scrollback: string };
    /** A terminal that ENDED (its output stays readable): whose it was and its exit code. Absent = nothing kept. */
    finished?(id: string): { workspaceId: string; exitCode: number } | null;
    write(id: string, data: string): boolean;
    scrollback(id: string): string | undefined;
    /** The engine's scrollback cap in characters; a buffer at the cap has been cut. */
    readonly scrollbackCap: number;
}

export interface MoreToolsDeps {
    readonly knowledge: KnowledgeStore;
    readonly terminals: TerminalsPort;
    readonly approve: ApprovalGate;
    readonly resolveCaller: (terminalId: string) => Caller | null;
    /**
     * The env a terminal in that workspace gets — the SAME the Terminals tab gives its shells (hosting-actions.ts
     * `terminalEnvFor`: the workspace's service engines, then Genie's MCP endpoint). Absent = none (doctor mode).
     */
    readonly envFor?: (workspaceId: string) => Readonly<Record<string, string>>;
}

const ok = (payload: unknown): McpToolResult => ({ text: JSON.stringify(payload), isError: false });
const err = (message: string): McpToolResult => ({ text: JSON.stringify({ ok: false, error: message }), isError: true });
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

export function moreGenieTools(deps: MoreToolsDeps): Registration[] {
    const withCaller = (body: (caller: Caller, args: JsonObject, context: ToolContext) => McpToolResult | Promise<McpToolResult>): ToolHandler => async (args, context) => {
        const caller = callerFrom(args, context.headers, deps.resolveCaller);
        if (typeof caller === 'string') return err(caller);
        try {
            return await body(caller, args, context);
        } catch (error) {
            return err((error as Error).message);
        }
    };

    const knowledge: Registration = {
        definition: new ToolDefinition(
            'knowledge',
            'Read and write Genie’s workstation knowledge graph: search / get / add / list / link. Nodes are markdown memories in four classes (profile, episodic, procedural, knowledge); [[wikilinks]] become edges; an ambiguous link resolves to nothing. Scope (system | workspace | gapp | all) is noise reduction, not a boundary.',
            {
                type: 'object',
                properties: {
                    terminalId: MIRRORED_TERMINAL_ID,
                    action: { type: 'string', enum: ['search', 'get', 'add', 'list', 'link'] },
                    query: { type: 'string' },
                    id: { type: 'string' },
                    title: { type: 'string' },
                    body: { type: 'string' },
                    class: { type: 'string', enum: ['profile', 'episodic', 'procedural', 'knowledge'] },
                    tags: { type: 'array', items: { type: 'string' } },
                    tag: { type: 'string' },
                    links: { type: 'array', items: { type: 'string' } },
                    scope: { type: 'string', enum: ['system', 'workspace', 'gapp', 'all'] },
                    limit: { type: 'number' },
                    cursor: { type: 'string' },
                    from: { type: 'string' },
                    to: { type: 'string' },
                },
                required: ['action'],
            },
            'Knowledge',
        ),
        handler: withCaller((caller, args) => {
            const action = str(args.action) ?? '';
            const own: Scope = { kind: 'workspace', id: caller.workspaceId };
            const readScopes = (): ScopeFilter => (args.scope === 'all' ? 'all' : args.scope === 'system' ? [{ kind: 'system' }] : [{ kind: 'system' }, own]);
            const cls = str(args.class) as MemoryClass | undefined;
            const limit = typeof args.limit === 'number' ? args.limit : undefined;
            const cursor = str(args.cursor);
            switch (action) {
                case 'search': {
                    const query = str(args.query);
                    if (!query) return err('search needs `query`');
                    const tags = Array.isArray(args.tags) ? (args.tags as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
                    const r = deps.knowledge.search({ query, scopes: readScopes(), ...(cls ? { class: cls } : {}), ...(tags ? { tags } : {}), ...(limit !== undefined ? { limit } : {}), ...(cursor ? { cursor } : {}) });
                    return ok({ ok: true, hits: r.hits, nextCursor: r.nextCursor });
                }
                case 'get': {
                    const id = str(args.id);
                    if (!id) return err('get needs `id`');
                    const node = deps.knowledge.get(id);
                    return node ? ok({ ok: true, node }) : err(`no knowledge node ${id}`);
                }
                case 'add': {
                    const title = str(args.title);
                    if (!title) return err('add needs `title`');
                    const scope: Scope = args.scope === 'system' ? { kind: 'system' } : args.scope === 'gapp' ? { kind: 'gapp', id: caller.workspaceId } : own;
                    const tags = Array.isArray(args.tags) ? (args.tags as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
                    const links = Array.isArray(args.links) ? (args.links as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
                    const r = deps.knowledge.add({ title, body: str(args.body) ?? '', ...(cls ? { class: cls } : {}), ...(tags ? { tags } : {}), ...(links ? { links } : {}), scope, source: 'agent' });
                    return ok({ ok: true, id: r.id, unresolved: r.unresolved });
                }
                case 'list': {
                    const tag = str(args.tag);
                    const r = deps.knowledge.list({ scopes: readScopes(), ...(cls ? { class: cls } : {}), ...(tag ? { tag } : {}), ...(limit !== undefined ? { limit } : {}), ...(cursor ? { cursor } : {}) });
                    return ok({ ok: true, nodes: r.nodes, nextCursor: r.nextCursor });
                }
                case 'link': {
                    const from = str(args.from);
                    const to = str(args.to);
                    if (!from || !to) return err('link needs `from` and `to`');
                    const r = deps.knowledge.link(from, to);
                    return r.ok ? ok({ ok: true, to: r.to }) : err(`could not link ${from} → ${to}: ${r.reason}`);
                }
                default:
                    return err(`unknown action ${JSON.stringify(action)}; the actions are search, get, add, list, link`);
            }
        }),
    };

    const manageTerminals: Registration = {
        definition: new ToolDefinition(
            'manageTerminals',
            'Your workspace’s terminals: list; create (approval-gated; runs a command or opens a shell — with the workspace’s service variables already set); write (approval-gated; multi-line text is bracketed-pasted and Enter is sent separately — pass enter:false to hold it); read (the scrollback; `dropped: true` means it was cut at the cap). Databases, Redis and other engines are the `services` tool’s, and sites are the `sites` tool’s: never run `docker` in a terminal for them.',
            {
                type: 'object',
                properties: {
                    terminalId: MIRRORED_TERMINAL_ID,
                    action: { type: 'string', enum: ['list', 'create', 'write', 'read'] },
                    id: { type: 'string' },
                    command: { type: 'string' },
                    cwd: { type: 'string' },
                    text: { type: 'string' },
                    enter: { type: 'boolean' },
                },
                required: ['action'],
            },
            'Manage terminals',
        ),
        handler: withCaller(async (caller, args) => {
            const action = str(args.action) ?? '';
            const mine = () => deps.terminals.list().filter((t) => t.workspaceId === caller.workspaceId);
            const own = (id: string) => mine().find((t) => t.id === id) ?? null;
            switch (action) {
                case 'list':
                    return ok({ ok: true, terminals: mine() });
                case 'create': {
                    const command = str(args.command);
                    // THE WORKSPACE'S TERMINAL LIMIT (beta.33): refused before the person is asked to approve anything.
                    const refused = deps.terminals.refusal?.(caller.workspaceId) ?? null;
                    if (refused) return err(refused);
                    const verdict = await deps.approve(caller, 'create', command ?? '(a shell)');
                    if (verdict !== 'allowed') return err(`creating a terminal was denied by the user`);
                    // The workspace's service env and Genie's endpoint, as the person's own shells get them: a shell an agent
                    // opened once had neither, and could not reach the database the person's could.
                    const env = deps.envFor?.(caller.workspaceId) ?? {};
                    const opened = deps.terminals.open({ workspaceId: caller.workspaceId, cwd: str(args.cwd) ?? caller.workspacePath, ...(command ? { command, shell: true } : {}), ...(Object.keys(env).length > 0 ? { env } : {}) });
                    return ok({ ok: true, terminal: { id: opened.id, pid: opened.pid, shell: opened.shell } });
                }
                case 'write': {
                    const id = str(args.id);
                    const text = str(args.text);
                    if (!id || text === undefined) return err('write needs `id` and `text`');
                    if (!own(id)) return err(`terminal ${id} is not one of ${caller.agentName}’s workspace terminals`);
                    const verdict = await deps.approve(caller, 'write', text);
                    if (verdict !== 'allowed') return err(`writing to ${id} was denied by the user`);
                    const payload = text.includes('\n') ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}` : text;
                    if (!deps.terminals.write(id, payload)) return err(`terminal ${id} is gone`);
                    if (args.enter !== false) deps.terminals.write(id, '\r');
                    return ok({ ok: true, id, bytes: payload.length, enter: args.enter !== false });
                }
                case 'read': {
                    const id = str(args.id);
                    if (!id) return err('read needs `id`');
                    // A terminal that ended is still this workspace's to read: its output and how it ended.
                    const ended = deps.terminals.finished?.(id) ?? null;
                    if (!own(id) && ended?.workspaceId !== caller.workspaceId) return err(`terminal ${id} is not one of ${caller.agentName}’s workspace terminals`);
                    const text = deps.terminals.scrollback(id) ?? '';
                    return ok({ ok: true, id, text, dropped: text.length >= deps.terminals.scrollbackCap, ...(ended ? { exited: true, exitCode: ended.exitCode } : {}) });
                }
                default:
                    return err(`unknown action ${JSON.stringify(action)}; the actions are list, create, write, read`);
            }
        }),
    };

    return [knowledge, manageTerminals];
}
