import { describeMcpTool, type McpToolRow } from '../core/mcp-tool-summaries.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { writeTextPrivate } from './store.js';
import type { McpServer } from '@particle-academy/prism-acp';
import { withInterruptibleCalls } from './mcp-interrupt.js';
import { livenessOf } from '../core/liveness.js';
import type { AgentId, AgentRecord } from '../core/identity.js';
import type { AgentStores } from './agent-stores-host.js';
import { genieToolDeps } from './genie-tool-deps.js';
import { CallerBook, genieMcpServers, sessionCallerOf } from './mcp-callers.js';
import { allGenieTools } from './mcp-registrations.js';
import { genieMcpServer, type GenieMcpServer, type Verification } from './mcp-server.js';
import { hostRegistrations, type ForwardedToolCall } from './mcp-host-tools.js';
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
 * The view: the workspaces' names, which genie-host finds itself, and whether the person is at the computer, which main's
 * own client says (`window.view`, Tynn #1044). Callers are all the host's own (sessions, flows, Take Overs). The server
 * does NOT wait for it (ADF A3, Tynn #447): it starts
 * when the host does, with the PLUGINS' tools the host's own (main/plugins-host.ts) — offered and run here, so an agent
 * keeps them with no window.
 */

type SettingValue = boolean | string;

export interface WindowView {
    /** The workspaces' names, as genie-host reads them from each workspace's project.json (workspace-names.ts): their address slugs. */
    readonly workspaceNames: Readonly<Record<string, string>>;
    /** The person is at the computer, as main's own client last said it (window.view). No window = nobody is. */
    readonly userActive: boolean;
}

export interface HostMcpPorts {
    readonly stores: AgentStores;
    /** The settings: the host's own since P3.2 (dnd, inbox access, workspace tabs are read here, live). */
    readonly settings: Pick<import('./settings-store.js').SettingsStore, 'snapshot' | 'snapshotFor'>;
    readonly records: () => readonly AgentRecord[];
    /**
     * createAgent's create, after the person approved (Tynn #1015): genie-host's own Add agent (`addAgent`: project.json,
     * AGENT.md, its registry — genie-host.ts wires createThroughAddAgent). Absent = this host cannot, and the tool says so.
     */
    readonly createAgent?: import('./mcp-tools-agents.js').AgentToolsDeps['create'];
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
    /** Genie's Playwright installer and what is on disk, for the `playwright` tool (Tynn #846). */
    readonly playwright?: import('./mcp-tools-playwright.js').PlaywrightToolPort;
    /** Genie Mail's inboxes and the shared Mailpit, for the `mail` tool (G6): the host's hosting. */
    readonly mail?: import('./mcp-tools-mail.js').MailPort;
    /**
     * This host's IssueWatch, for `checkIssues` and imDone's count line (Tynn #934 task #1474: issue-watch-tools.ts). Absent =
     * this host runs none, and the tools say so.
     */
    readonly issueWatch?: import('./issue-watch-tools.js').HostIssueWatchTools;
    /** A flow calling Genie's tools as a step is a caller too (genie#1204): its own key, its workspace. */
    readonly flowCallers?: { callerFor(key: string): Caller | null };
    /** A Take Over TUI's caller: known here, so it works with no window to tell the host (Tynn #553). */
    readonly takeOverCaller?: (id: string) => Caller | null;
    /**
     * The sites and service engines `sites` and `services` act on (Tynn #444): the host's own hosting (P5a) and its
     * supervisor. Absent = the host's hosting did not start, and the tools say so. Only `sites open` needs the window.
     */
    readonly hosting?: import('./hosting-actions.js').HostingServices;
    /** A workspace's trust verdict as last read (Tynn #753): `sites` and `services` act only in a trusted one. Absent = none is. */
    readonly workspaceTrusted?: (workspaceId: string) => boolean;
    /** This host's own browser, for an agent's `sites open` (Tynn #1046 D2): in the background, the workspace pulsed. Absent = none. */
    readonly openInBrowser?: import('./hosting-actions.js').OpenInBrowser;
    /** Host-owned command execution, with the existing approval, confinement and cancellation contract. */
    readonly serviceExec?: import('./mcp-tools-hosting.js').ServiceExec;
    /** The terminals `manageTerminals` acts on (P3.3e): the host's own. Absent = the tool is the window's. */
    readonly terminals?: import('./mcp-tools-more.js').TerminalsPort;
    /** A shell an agent opens: the workspace's service variables and Genie's endpoint. */
    readonly terminalEnv?: (workspaceId: string) => Readonly<Record<string, string>>;
    /** openFileForUser with no window: shown when the next window connects. */
    readonly openFileLater: (call: ForwardedToolCall) => void;
    /** A tool's moment for the window: a glow, a thumbs-up, an action signal. Dropped with no window. */
    readonly signal: (signal: { kind: 'glow'; terminalId: string } | { kind: 'terminal-needs-you'; workspaceId: string; terminalId: string; agentName: string; reason: string } | { kind: 'action'; agentId: string; action: string; tool?: string; reason?: string }) => void;
    /** The agent's calls while forwarded to the window (shared with the stores' approval gate, genie#1360). */
    readonly forwardedCalls?: Map<string, import('./mcp-tools.js').McpCall>;
    /** Where the endpoint is remembered (`<genieHome>/mcp-endpoint.json`). */
    readonly endpointFile: string;
    /** The Genie tool calls running for each agent, ended by its Interrupt (Tynn #702). Absent = calls run on regardless. */
    readonly toolCalls?: import('./mcp-interrupt.js').AgentToolCalls;
    /** What this host can have (hostCapabilities, P10.1d): its window tools answer from it. Absent = all, as in the app. */
    readonly capabilities?: import('../core/host-runtime.js').HostCapabilities;
    /** The OSA's home, `<root>/osa` (P7: from the host's root, never homedir()'s `.genie`). */
    readonly osaDir: string;
    readonly log: (line: string) => void;
    /** The plugins' tools, the host's own (ADF A3: main/plugins-host.ts `hostPluginTools`). Absent = this host offers none. */
    readonly plugins?: PluginToolsDeps['plugins'] & { readonly run: PluginToolsDeps['run'] };
}

export interface HostMcp {
    /**
     * The plugins changed: build the tools again and serve them (ADF A6, Tynn #450). An agent's next `tools/list` shows
     * them, on the same endpoint, with no restart.
     */
    refreshTools(): void;
    /** What the window said. The server is already starting (it does not wait for a window). */
    setView(view: WindowView): Promise<void>;
    /** A session's Genie MCP entry: the endpoint, its token and this agent's caller key. */
    sessionServers(record: AgentRecord): McpServer[];
    endpoint(): { url: string; token: string } | null;
    /** Settled once the server has started, or failed to (said in `status`): what writing a workspace's config waits for. */
    ready(): Promise<void>;
    status(): { endpoint: { url: string; token: string } | null; verified: Verification | null; tools: McpToolRow[] };
    /** Every tool as this server serves it (the host's own, and the window's forwarded): what a flow's tool steps call. */
    registrations(): readonly import('./mcp-tools.js').Registration[];
    stop(): Promise<void>;
}

const unavailable = (what: string) => (): never => { throw new Error(`${what} runs in Genie's window; this call was forwarded there`); };
const noCreate = async (): Promise<{ ok: false; reason: string }> => ({ ok: false, reason: 'this Genie host cannot create agents' });

export function startHostMcp(ports: HostMcpPorts): HostMcp {
    const book = new CallerBook();
    let view: WindowView | null = null;
    let server: GenieMcpServer | null = null;
    let verified: Verification | null = null;
    let tools: McpToolRow[] = [];
    let starting: Promise<void> | null = null;
    /** The endpoint file's private write, while it is landing. It never rejects: a failure is logged. */
    let endpointWrite: Promise<void> = Promise.resolve();
    let servedNow: readonly import('./mcp-tools.js').Registration[] = [];

    const workspace = (id: string) => ports.registry.workspace(id);
    const resolveCaller = (id: string): Caller | null => {
        const records = ports.records();
        const session = sessionCallerOf(book, id, { find: (agentId) => records.find((r) => r.id === agentId) ?? null, workspace }, ports.osaDir);
        return session ?? ports.flowCallers?.callerFor(id) ?? ports.takeOverCaller?.(id) ?? null;
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
            workspacePath: (id) => workspace(id)?.path ?? null,
            refusalForRecipient: (text) => ports.registry.mailRefusal?.(text) ?? null,
            liveness: (id) => livenessOf(ports.probe(id as AgentId), ports.lastRowAt(id as AgentId)),
            resolveCaller,
            userActive: () => ports.window.connected() && view?.userActive === true,
            glow: (terminalId) => { ports.signal({ kind: 'glow', terminalId }); return true; },
            thumbsUp: (caller, reason) => ports.signal({ kind: 'action', agentId: caller.agentId, action: 'thumbsup', reason }),
            reportPlan: (agentId, steps) => ports.reportPlan(agentId as AgentId, steps),
            readPlan: (agentId) => ports.records().find((r) => r.id === agentId)?.plan ?? null,
            // checkIssues and imDone's count line read this host's own IssueWatch (Tynn #934 task #1474).
            ...(ports.issueWatch ? { issueWatch: ports.issueWatch } : {}),
            // THE WINDOW'S: these tools are forwarded whole (mcp-host-tools.ts); here they only give the tools their shape.
            openFile: unavailable('openFileForUser'),
            terminals: ports.terminals ?? { list: unavailable('manageTerminals'), open: unavailable('manageTerminals'), write: unavailable('manageTerminals'), scrollback: unavailable('manageTerminals'), finished: unavailable('manageTerminals'), scrollbackCap: 1_000_000 },
            ...(ports.terminalEnv ? { terminalEnv: ports.terminalEnv } : {}),
            // A terminal that needs the person (Tynn #722): a Show terminal notice in the window they use; nothing without one.
            surfaceTerminal: (request) => {
                if (!ports.window.connected()) return false;
                ports.signal({ kind: 'terminal-needs-you', ...request });
                return true;
            },
            plugins: ports.plugins ?? { tools: () => [], guard: () => null, run: unavailable('a plugin tool') },
            ...(ports.processes ? { processes: ports.processes } : {}),
            ...(ports.flows ? { flows: ports.flows } : {}),
            ...(ports.mail ? { mail: ports.mail } : {}),
            ...(ports.playwright ? { playwright: ports.playwright } : {}),
            ...(ports.hosting ? { hosting: ports.hosting } : {}),
            ...(ports.workspaceTrusted ? { workspaceTrusted: ports.workspaceTrusted } : {}),
            ...(ports.openInBrowser ? { openInBrowser: ports.openInBrowser } : {}),
            ...(ports.serviceExec ? { serviceExec: ports.serviceExec } : {}),
            // createAgent runs HERE (Tynn #1015): the person approves in the host's queue, the host's Add agent makes it.
            agents: { defaultAgentOf: (ws) => ports.registry.defaultAgentOf(ws), create: ports.createAgent ?? noCreate },
            workspaceTabs: { write: unavailable('workspaceTabs'), sites: unavailable('workspaceTabs') },
            pages: { open: unavailable('pages') },
        }));
        // The action signal (the Dashboard row's "what it just did") for what runs HERE only: a forwarded call runs in the
        // window, which signals it there — signalled here too, it would show twice. hostRegistrations replaces a window
        // tool's handler and calls a host tool's own for what runs here (every host tool's action, `sites open` too since Tynn #1046 D2).
        const all = withActionSignal(tools0, resolveCaller, (agentId, kind, tool) => ports.signal({ kind: 'action', agentId, action: kind, tool }));
        // The plugins' tools run HERE (ADF A3): the host has their plugins, so nothing of theirs is forwarded to a window.
        const pluginNames = new Set((ports.plugins?.tools() ?? []).map((ref) => `${ref.pluginId}.${ref.tool.name}`));
        const servedAll = hostRegistrations(all, { native: (name) => pluginNames.has(name), resolveCaller, window: ports.window, openFileLater: ports.openFileLater, ...(ports.capabilities ? { capabilities: ports.capabilities } : {}), ...(ports.forwardedCalls ? { forwardedCalls: ports.forwardedCalls } : {}) });
        // Every call this server answers is the calling agent's to have ended by its Interrupt (Tynn #702), forwarded ones too.
        const served = ports.toolCalls ? withInterruptibleCalls(servedAll, resolveCaller, ports.toolCalls) : servedAll;
        tools = served.map((r) => describeMcpTool(r.definition.name, r.definition.description ?? '', r.visible !== undefined));
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
                // Not waited for here (the server is already serving); stop() waits for it (Tynn #583).
                write: (value) => { endpointWrite = writeTextPrivate(ports.endpointFile, JSON.stringify(value)).catch((error: unknown) => ports.log(`mcp: could not remember its endpoint: ${error instanceof Error ? error.message : String(error)}`)); },
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
        ready: async () => { await starting; },
        status: () => ({ endpoint: server?.endpoint() ?? null, verified, tools }),
        stop: async () => { await server?.stop().catch(() => undefined); await endpointWrite; },
        refreshTools: () => {
            if (!server) return;
            try {
                server.setRegistrations(build());
                ports.log(`mcp: now serving ${tools.length} tools`);
            } catch (error) {
                // What was offered stays offered: a build that fails must not take every agent's tools away.
                ports.log(`mcp: the tools could not be rebuilt: ${error instanceof Error ? error.message : String(error)}`);
            }
        },
        registrations: () => servedNow,
    };
}
