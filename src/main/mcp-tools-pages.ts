import { ToolDefinition, type JsonObject, type McpToolResult } from '@particle-academy/prism-mcp';
import { registerNavigationBridge } from '@particle-academy/agent-integrations/bridges/navigation';
import { createRemoteNavigationAdapter } from '@particle-academy/agent-integrations/dom-navigation';
import type { AgentRecord } from '../core/identity.js';
import { callerFrom } from './mcp-callers.js';
import { MIRRORED_TERMINAL_ID, type Caller, type McpCall, type Registration } from './mcp-tools.js';

/**
 * `pages` — AGENTS DRIVE GENIE SITE PAGES (browser rebuild step 7; the owner, FTQ q_82269ca5). Fancy's human+ navigation
 * bridge (@particle-academy/agent-integrations) over each open page — a Genie browser tab, a live site panel — whose
 * script Genie injects into an isolated world (page-navigation-electron.ts).
 *
 * - WHO: the workspace's default agent, or an agent whose "May drive pages" switch is on (AgentRecord `drivePages`).
 *   Everyone else does not see the tool (prism-mcp-server's per-request `visible`), and the handler checks again.
 * - WHICH PAGES: those showing one of the caller's workspace's sites — never another workspace's page.
 * - WHAT ASKS: a submit, and a click the page marks destructive, wait for the person (`page.submit` / `page.click`,
 *   person-only: autonomy alone does not answer them) — unless the caller's own "May drive pages" switch is on: the
 *   person's answer, given once (genie#1294, approval-queue.ts `SWITCH_ANSWERS`; the default agent without the switch
 *   still asks). Declined: nothing reaches the page. Reading, filling and ordinary
 *   clicks do not ask. A page that moved since the agent last looked cancels its action until it describes again.
 *
 * The bridge's own tools (page_describe, page_read, page_set_field, page_click, page_submit, nav_visit, nav_back …) run
 * on a small tool host per agent and page; this one Genie tool forwards to them, so their names stay out of every
 * agent's tool list.
 */

export const PAGE_SUBMIT_ACTION = 'page.submit';
export const PAGE_CLICK_ACTION = 'page.click';
export type PageAction = typeof PAGE_SUBMIT_ACTION | typeof PAGE_CLICK_ACTION;

/** Into a page's isolated world: fancy's remote adapter calls `call(method, args)`. */
export interface PageTransport {
    call(method: string, args: unknown[]): Promise<unknown>;
}

export interface DrivablePage {
    /** `window:<connection>:<tab>` or `panel:<workspace>:<tab>:<cell>`. */
    readonly id: string;
    readonly url: string;
    readonly title: string;
    readonly transport: PageTransport;
    /** Moves on every navigation of the page. */
    revision(): number;
}

export interface PagesToolDeps {
    readonly resolveCaller: (key: string) => Caller | null;
    readonly defaultAgentOf: (workspaceId: string) => string | null;
    readonly roster: () => readonly AgentRecord[];
    /** The `.gen` hosts this workspace's sites are served at. */
    readonly sites: (workspaceId: string) => readonly string[];
    /** Every page Genie has open now. */
    readonly pages: () => readonly DrivablePage[];
    readonly approve: (caller: Caller, action: PageAction, detail: string, call: McpCall | undefined) => Promise<'allowed' | 'denied'>;
}

const ok = (payload: Record<string, unknown>): McpToolResult => ({ text: JSON.stringify({ ok: true, ...payload }), isError: false });
const err = (message: string): McpToolResult => ({ text: JSON.stringify({ ok: false, error: message }), isError: true });

type BridgeTool = { definition: { name: string }; handler: (args: JsonObject) => Promise<BridgeResult> | BridgeResult };
type BridgeResult = { content: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: unknown };

/** The smallest tool host fancy's bridge registers on (its own ToolRegistry lives in the React entry). */
class BridgeHost {
    readonly #tools = new Map<string, BridgeTool>();
    registerTool(definition: { name: string }, handler: BridgeTool['handler']): () => void {
        const tool = { definition, handler };
        this.#tools.set(definition.name, tool);
        return () => { if (this.#tools.get(definition.name) === tool) this.#tools.delete(definition.name); };
    }
    getTool(name: string): BridgeTool | null { return this.#tools.get(name) ?? null; }
    listTools(): Array<{ name: string }> { return [...this.#tools.values()].map((t) => t.definition); }
    async callTool(name: string, args: JsonObject = {}): Promise<BridgeResult> {
        const tool = this.#tools.get(name);
        if (!tool) return { content: [{ type: 'text', text: `no page tool ${name}` }], isError: true };
        return tool.handler(args);
    }
}

const hostOf = (url: string): string | null => {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return null;
    }
};

export function pagesTools(deps: PagesToolDeps): Registration[] {
    const mayDrive = (caller: Caller | null): boolean =>
        caller !== null && (deps.defaultAgentOf(caller.workspaceId) === caller.agentId || deps.roster().some((a) => a.id === caller.agentId && a.drivePages === true));

    /** The caller's workspace's pages, now. */
    const pagesOf = (caller: Caller): DrivablePage[] => {
        const ours = new Set(deps.sites(caller.workspaceId).map((h) => h.toLowerCase()));
        return deps.pages().filter((p) => { const host = hostOf(p.url); return host !== null && ours.has(host); });
    };

    // One bridge per (agent, page): its grounding (what the agent last described) is the agent's own.
    const bridges = new Map<string, BridgeHost>();
    /**
     * The MCP calls driving each bridge right now (genie#1360). The bridge outlives a call, so its `confirm` cannot close
     * over one: it takes the call when exactly ONE is active — two at once and it cannot tell whose click asks, so it
     * passes none, and the approval waits for the person rather than ending on another caller's disconnect.
     */
    const active = new Map<string, Set<McpCall>>();
    const callOf = (key: string): McpCall | undefined => { const calls = active.get(key); return calls?.size === 1 ? [...calls][0] : undefined; };
    const bridgeFor = (caller: Caller, pageId: string): BridgeHost => {
        const key = `${caller.agentId}|${pageId}`;
        const known = bridges.get(key);
        if (known) return known;
        const host = new BridgeHost();
        const current = () => deps.pages().find((p) => p.id === pageId) ?? null;
        const adapter = createRemoteNavigationAdapter({
            screenId: pageId,
            transport: { call: (method: string, args: unknown[]) => { const page = current(); return page ? page.transport.call(method, args) : Promise.reject(new Error('the page was closed')); } },
            getRevision: () => current()?.revision() ?? -1,
            confirm: async (req) => {
                const action = req.action === 'submit' ? PAGE_SUBMIT_ACTION : PAGE_CLICK_ACTION;
                const where = current()?.url ?? pageId;
                const what = req.action === 'submit' ? `submit the form at “${req.label}”` : `click “${req.label}”`;
                return (await deps.approve(caller, action, `${what} on ${where}`, callOf(key))) === 'allowed';
            },
        });
        registerNavigationBridge(host as never, { adapter, agent: { id: caller.agentId, name: caller.agentName } });
        bridges.set(key, host);
        return host;
    };

    const tool: Registration = {
        definition: new ToolDefinition(
            'pages',
            'Drive this workspace’s open Genie site pages — a Genie browser tab or a site panel the person has open. `list` shows them. `call {page, tool, args}` runs a page tool on one: `page_describe` first (it lists the page’s fields and buttons by handle), then `page_read`, `page_set_field {handle, value}`, `page_click {handle}`, `page_submit {handle}`, `nav_visit {url}`, `nav_back`, `nav_forward`, `nav_scroll_to`, `nav_scroll_by`. A submit, or a click that changes or deletes something, asks the person first — unless your “May drive pages” switch is on.',
            {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'call'] },
                    page: { type: 'string', description: 'A page id from list.' },
                    tool: { type: 'string', description: 'The page tool to run: page_describe, page_read, page_set_field, page_click, page_submit, nav_visit, nav_back, nav_forward, nav_scroll_to, nav_scroll_by.' },
                    args: { type: 'object', description: 'The page tool’s arguments, e.g. {"handle": "save"}.' },
                    terminalId: MIRRORED_TERMINAL_ID,
                },
                required: ['action'],
            },
            'Pages',
        ),
        visible: ({ headers }) => {
            const key = headers['mcp-param-genie-session'] ?? headers['genie-session'];
            return typeof key === 'string' && mayDrive(deps.resolveCaller(key));
        },
        handler: async (args: JsonObject, context) => {
            const found = callerFrom(args, context.headers, deps.resolveCaller);
            if (typeof found === 'string') return err(found);
            // The handler's own check — never trusting that only the right caller can reach it.
            if (!mayDrive(found)) return err('Only this workspace’s default agent, or an agent whose “May drive pages” switch is on, drives its pages.');
            const mine = pagesOf(found);
            // Bridges of pages that closed go with them.
            const live = new Set(deps.pages().map((p) => p.id));
            for (const key of [...bridges.keys()]) if (!live.has(key.slice(key.indexOf('|') + 1))) bridges.delete(key);

            if (args.action === 'list') return ok({ pages: mine.map((p) => ({ id: p.id, url: p.url, title: p.title })) });
            if (args.action !== 'call') return err('action is list or call');
            const pageId = typeof args.page === 'string' ? args.page : '';
            if (!mine.some((p) => p.id === pageId)) return err(`no open page ${JSON.stringify(pageId)} shows one of this workspace’s sites — \`list\` names the ones that do`);
            const name = typeof args.tool === 'string' ? args.tool : '';
            if (!/^(page|nav)_[a-z_]+$/.test(name)) return err('tool is a page tool: page_describe, page_read, page_set_field, page_click, page_submit, nav_visit, nav_back, nav_forward, nav_scroll_to, nav_scroll_by');
            const toolArgs = args.args !== null && typeof args.args === 'object' && !Array.isArray(args.args) ? (args.args as JsonObject) : {};
            const key = `${found.agentId}|${pageId}`;
            const calls = active.get(key) ?? new Set<McpCall>();
            active.set(key, calls);
            calls.add(context);
            let result: Awaited<ReturnType<BridgeHost['callTool']>>;
            try {
                result = await bridgeFor(found, pageId).callTool(name, toolArgs);
            } finally {
                calls.delete(context);
                if (calls.size === 0) active.delete(key);
            }
            const text = result.content.map((c) => c.text ?? '').filter((t) => t !== '').join('\n');
            return { text: text || (result.isError ? 'the page tool failed' : 'done'), isError: result.isError === true };
        },
    };
    return [tool];
}
