import { readFileSync, writeFileSync } from 'node:fs';
import { writeTextPrivate } from './store.js';
import type { McpServer } from '@particle-academy/prism-acp';
import { livenessOf } from '../core/liveness.js';
import type { AgentId, AgentRecord } from '../core/identity.js';
import type { AgentStores } from './agent-stores-host.js';
import { genieToolDeps } from './genie-tool-deps.js';
import { CallerBook, genieMcpServers, sessionCallerOf } from './mcp-callers.js';
import { allGenieTools } from './mcp-registrations.js';
import { genieMcpServer, type GenieMcpServer, type Verification } from './mcp-server.js';
import { HOST_NATIVE_TOOLS, hostRegistrations, type ForwardedToolCall } from './mcp-host-tools.js';
import { withActionSignal } from './mcp-signal.js';
import type { McpToolResult } from '@particle-academy/prism-mcp';
import type { Caller } from './mcp-tools.js';
import type { PluginToolsDeps } from './mcp-tools-plugins.js';

/**
 * GENIE'S MCP SERVER, IN GENIE-HOST (the host split, P3.1: plan §11d).
 *
 * The loopback server agents reach Genie through. It keeps its port and token in `mcp-endpoint.json`, so an agent's
 * configuration stays good across window restarts. It owns the CALLER BOOK: a session's Genie entry (url, token, its
 * caller key) is built here. The host answers its own tools from the stores and the sessions it owns; every other tool
 * goes to the window (mcp-host-tools.ts).
 *
 * The window tells the host what only it knows: the workspaces' names, whether the person is at the computer, the callers
 * of terminals it runs (Take Over windows, flow runs). The server does NOT wait for it (ADF A3, Tynn #447): it starts
 * when the host does, with the PLUGINS' tools the host's own (main/plugins-host.ts) — offered and run here, so an agent
 * keeps them with no window.
 */

type SettingValue = boolean | string;

export interface WindowView {
    /** The workspaces' names as the window reads them (project.json): their address slugs. The rest is the host's own registry. */
    readonly workspaceNames: Readonly<Record<string, string>>;
    /** The person is at the computer (the window's own measure). No window = nobody is. */
    readonly userActive: boolean;
    /** Terminals the window runs whose agents call Genie (Take Over windows, flow runs): terminal id → caller. */
    readonly callers: Readonly<Record<string, Caller>>;
}

export interface HostMcpPorts {
    readonly stores: AgentStores;
    /** The settings: the host's own since P3.2 (dnd, inbox access, workspace tabs are read here, live). */
    readonly settings: Pick<import('./settings-store.js').SettingsStore, 'snapshot' | 'snapshotFor'>;
    readonly records: () => readonly AgentRecord[];
    /** The host's own registry (P3.2): a workspace's path, its default agent, the address slugs. */
    readonly registry: Pick<import('./host-registry.js').HostRegistry, 'workspace' | 'workspaceSlugs' | 'defaultAgentOf' | 'setNames'> & Partial<Pick<import('./host-registry.js').HostRegistry, 'mailRefusal'>>;
    readonly probe: (agentId: AgentId) => Parameters<typeof livenessOf>[0];
    readonly lastRowAt: (agentId: AgentId) => number | null;
    readonly reportPlan: (agentId: AgentId, steps: readonly { content: string; status: string }[]) => boolean | Promise<boolean>;
    readonly window: { connected(): boolean; call(call: ForwardedToolCall): Promise<McpToolResult> };
    /** The background processes the `processes` tool acts on (P3.3c): the host's book, scheduler and supervisor logs. */
    readonly processes?: import('./mcp-tools-processes.js').ProcessesPort;
    /** The flows the `flows` tool acts on (P3.3d): the host's store and scheduler. */
    readonly flows?: import('./mcp-tools-flows.js').FlowsPort;
    /** Genie Mail's inboxes and the shared Mailpit, for the `mail` tool (G6): the host's hosting. */
    readonly mail?: import('./mcp-tools-mail.js').MailPort;
    /** A flow calling Genie's tools as a step is a caller too (genie#1204): its own key, its workspace. */
    readonly flowCallers?: { callerFor(key: string): Caller | null };
    /**
     * The sites and service engines `sites` and `services` act on (Tynn #444): the host's own hosting (P5a) and its
     * supervisor. Absent = the host's hosting did not start, and the tools say so. `sites open` / `services exec` are the window's.
     */
    readonly hosting?: import('./hosting-actions.js').HostingServices;
    /** The terminals `manageTerminals` acts on (P3.3e): the host's own. Absent = the tool is the window's. */
    readonly terminals?: import('./mcp-tools-more.js').TerminalsPort;
    /** A shell an agent opens: the workspace's service variables and Genie's endpoint. */
    readonly terminalEnv?: (workspaceId: string) => Readonly<Record<string, string>>;
    /** openFileForUser with no window: shown when the next window connects. */
    readonly openFileLater: (call: ForwardedToolCall) => void;
    /** A tool's moment for the window: a glow, a thumbs-up, an action signal. Dropped with no window. */
    readonly signal: (signal: { kind: 'glow'; terminalId: string } | { kind: 'action'; agentId: string; action: string; tool?: string; reason?: string }) => void;
    /** The agent's calls while forwarded to the window (shared with the stores' approval gate, genie#1360). */
    readonly forwardedCalls?: Map<string, import('./mcp-tools.js').McpCall>;
    /** Where the endpoint is remembered (`<genieHome>/mcp-endpoint.json`). */
    readonly endpointFile: string;
    /** What this host can have (hostCapabilities, P10.1d): its window tools answer from it. Absent = all, as in the app. */
    readonly capabilities?: import('../core/host-runtime.js').HostCapabilities;
    /** The OSA's home, `<root>/osa` (P7: from the host's root, never homedir()'s `.genie`). */
    readonly osaDir: string;
    readonly log: (line: string) => void;
    /** The plugins' tools, the host's own (ADF A3: main/plugins-host.ts `hostPluginTools`). Absent = this host offers none. */
    readonly plugins?: PluginToolsDeps['plugins'] & { readonly run: PluginToolsDeps['run'] };
}

export interface HostMcp {
    /** What the window said. The server is already starting (it does not wait for a window). */
    setView(view: WindowView): Promise<void>;
    /** A session's Genie MCP entry: the endpoint, its token and this agent's caller key. */
    sessionServers(record: AgentRecord): McpServer[];
    endpoint(): { url: string; token: string } | null;
    status(): { endpoint: { url: string; token: string } | null; verified: Verification | null; tools: Array<{ name: string; description: string }> };
    /**
     * One of the host's own tools, asked by the WINDOW for a caller it knows (a flow's step, P3.1): run here with that
     * caller, answered as the tool answers. Only the host's own tools; the window has the rest.
     */
    runNative(call: ForwardedToolCall): Promise<McpToolResult>;
    /** Every tool as this server serves it (the host's own, and the window's forwarded): what a flow's tool steps call. */
    registrations(): readonly import('./mcp-tools.js').Registration[];
    stop(): Promise<void>;
}

const unavailable = (what: string) => (): never => { throw new Error(`${what} runs in Genie's window; this call was forwarded there`); };

export function startHostMcp(ports: HostMcpPorts): HostMcp {
    const book = new CallerBook();
    let view: WindowView | null = null;
    let server: GenieMcpServer | null = null;
    let verified: Verification | null = null;
    let tools: Array<{ name: string; description: string }> = [];
    let starting: Promise<void> | null = null;
    let native = new Map<string, import('./mcp-tools.js').Registration>();
    let servedNow: readonly import('./mcp-tools.js').Registration[] = [];
    /** Callers the window vouched for, for the length of one call (runNative). */
    const injected = new Map<string, Caller>();
    let injectSeq = 0;

    const workspace = (id: string) => ports.registry.workspace(id);
    const resolveCaller = (id: string): Caller | null => {
        const records = ports.records();
        const vouched = injected.get(id);
        if (vouched) return vouched;
        const session = sessionCallerOf(book, id, { find: (agentId) => records.find((r) => r.id === agentId) ?? null, workspace }, ports.osaDir);
        return session ?? ports.flowCallers?.callerFor(id) ?? view?.callers[id] ?? null;
    };
    const settings = ports.settings;

    const build = () => {
        const s = ports.stores;
        const tools0 = allGenieTools(genieToolDeps({
            inbox: s.inbox,
            attention: s.attention,
            knowledge: s.knowledge,
            settings,
            approve: (caller, action, detail, call) => s.approvals.gate(caller, action, detail, call),
            roster: ports.records,
            workspaceSlugs: () => ports.registry.workspaceSlugs(),
            refusalForRecipient: (text) => ports.registry.mailRefusal?.(text) ?? null,
            liveness: (id) => livenessOf(ports.probe(id as AgentId), ports.lastRowAt(id as AgentId)),
            resolveCaller,
            userActive: () => ports.window.connected() && view?.userActive === true,
            glow: (terminalId) => { ports.signal({ kind: 'glow', terminalId }); return true; },
            thumbsUp: (caller, reason) => ports.signal({ kind: 'action', agentId: caller.agentId, action: 'thumbsup', reason }),
            reportPlan: (agentId, steps) => ports.reportPlan(agentId as AgentId, steps),
            readPlan: (agentId) => ports.records().find((r) => r.id === agentId)?.plan ?? null,
            // THE WINDOW'S: these tools are forwarded whole (mcp-host-tools.ts); here they only give the tools their shape.
            issueWatch: { forWorkspace: unavailable('checkIssues') },
            openFile: unavailable('openFileForUser'),
            terminals: ports.terminals ?? { list: unavailable('manageTerminals'), open: unavailable('manageTerminals'), write: unavailable('manageTerminals'), scrollback: unavailable('manageTerminals'), finished: unavailable('manageTerminals'), scrollbackCap: 1_000_000 },
            ...(ports.terminalEnv ? { terminalEnv: ports.terminalEnv } : {}),
            plugins: ports.plugins ?? { tools: () => [], guard: () => null, run: unavailable('a plugin tool') },
            ...(ports.processes ? { processes: ports.processes } : {}),
            ...(ports.flows ? { flows: ports.flows } : {}),
            ...(ports.mail ? { mail: ports.mail } : {}),
            ...(ports.hosting ? { hosting: ports.hosting } : {}),
            agents: { defaultAgentOf: (ws) => ports.registry.defaultAgentOf(ws), register: unavailable('createAgent') },
            workspaceTabs: { write: unavailable('workspaceTabs'), sites: unavailable('workspaceTabs') },
            pages: { open: unavailable('pages') },
        }));
        // The action signal (the Dashboard row's "what it just did") for what runs HERE only: a forwarded call runs in the
        // window, which signals it there — signalled here too, it would show twice. hostRegistrations replaces a window
        // tool's handler and calls a host tool's own only for what runs here (a `sites open` is forwarded, unsignalled).
        const all = withActionSignal(tools0, resolveCaller, (agentId, kind, tool) => ports.signal({ kind: 'action', agentId, action: kind, tool }));
        // The plugins' tools run HERE (ADF A3): the host has their plugins, so nothing of theirs is forwarded to a window.
        const pluginNames = new Set((ports.plugins?.tools() ?? []).map((ref) => `${ref.pluginId}.${ref.tool.name}`));
        const isNative = (name: string) => HOST_NATIVE_TOOLS.has(name) || pluginNames.has(name);
        const served = hostRegistrations(all, { native: (name) => pluginNames.has(name), resolveCaller, window: ports.window, openFileLater: ports.openFileLater, ...(ports.capabilities ? { capabilities: ports.capabilities } : {}), ...(ports.forwardedCalls ? { forwardedCalls: ports.forwardedCalls } : {}) });
        tools = served.map((r) => ({ name: r.definition.name, description: r.definition.description ?? '' }));
        native = new Map(served.filter((r) => isNative(r.definition.name)).map((r) => [r.definition.name, r]));
        servedNow = served;
        return served;
    };

    const start = async (): Promise<void> => {
        server = genieMcpServer({
            registrations: build(),
            remember: {
                read: () => {
                    try {
                        const v = JSON.parse(readFileSync(ports.endpointFile, 'utf8')) as { port?: unknown; token?: unknown };
                        return typeof v.port === 'number' && typeof v.token === 'string' && v.token.length >= 32 ? { port: v.port, token: v.token } : null;
                    } catch { return null; }
                },
                write: (value) => { void writeTextPrivate(ports.endpointFile, JSON.stringify(value)).catch((error: unknown) => ports.log(`mcp: could not remember its endpoint: ${error instanceof Error ? error.message : String(error)}`)); },
            },
        });
        try {
            const at = await server.start();
            verified = await server.verify();
            ports.log(`mcp: serving ${at.url} (${tools.length} tools)`);
        } catch (error) {
            verified = { ok: false, reason: error instanceof Error ? error.message : String(error) };
            ports.log(`mcp: the loopback server did not start: ${verified.reason}`);
        }
    };

    // No window needed (ADF A3): the server starts with the host.
    starting = start();
    return {
        setView: async (next) => {
            view = next;
            ports.registry.setNames(new Map(Object.entries(next.workspaceNames ?? {})));
            await starting;
        },
        sessionServers: (record) => genieMcpServers(server?.endpoint() ?? null, book.keyFor(record.id)),
        endpoint: () => server?.endpoint() ?? null,
        status: () => ({ endpoint: server?.endpoint() ?? null, verified, tools }),
        stop: async () => { await server?.stop().catch(() => undefined); },
        registrations: () => servedNow,
        runNative: async (call) => {
            const r = native.get(call.name);
            if (!r) return { text: `${call.name} is not one of genie-host's own tools`, isError: true };
            if (!call.caller) return { text: 'Genie could not tell who is calling; nothing was done', isError: true };
            const key = `vouched-${++injectSeq}`;
            injected.set(key, call.caller);
            try {
                const { terminalId: _t, ...args } = call.args as Record<string, unknown>;
                void _t;
                return await r.handler(args as never, { server: 'genie', tool: call.name, headers: { 'genie-session': key } });
            } finally {
                injected.delete(key);
            }
        },
    };
}
