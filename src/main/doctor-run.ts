import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ToolDefinition, type McpToolResult } from '@particle-academy/prism-mcp';
import type { AgentRecord } from '../core/identity.js';
import type { ProcessTree } from '../core/process-tree.js';
import { workspaceDisplayName } from '../core/workspace-name.js';
import { AttentionStore } from './attention-store.js';
import { askAndWait } from './doctor-mcp.js';
import { FeedbackStore } from './feedback-store.js';
import { genieToolDeps } from './genie-tool-deps.js';
import { InboxStore } from './inbox-store.js';
import { KnowledgeStore } from './knowledge-store.js';
import { CallerBook, genieMcpServers, sessionCallerOf } from './mcp-callers.js';
import { allGenieTools } from './mcp-registrations.js';
import { genieMcpServer, type GenieMcpServer } from './mcp-server.js';
import type { Registration } from './mcp-tools.js';
import { OS_WORKSPACE, Registry } from './registry.js';
import { SessionHost, type DriverFor } from './session-host.js';
import { SettingsStore } from './settings-store.js';
import { Store } from './store.js';

/**
 * DOCTOR MODE RUNS ONE LOADED AGENT WITH GENIE'S REAL TOOLS (the owner, 2026-10-13: "you should be able to access all
 * genie data and drive the genie agent"; decided: inspect AND run, read-only while normal Genie runs). Genie's genie, in
 * doctor mode, starts ONE agent — a workspace's, or the workstation's own genie — on its real thread, and talks to it.
 * The agent gets exactly what a session gets in normal Genie: the tools built by the one builder (genie-tool-deps.ts),
 * behind the session-key header, over real HTTP — so a fault in that wiring shows up here, where genie can see it.
 *
 * Nothing is opened until `startAgent` is called, and `startAgent` is refused while normal Genie runs: two Genies
 * driving one agent's thread is how a conversation forks. What doctor does not run — terminals, sidecars, a window to
 * open files in, a Deck to approve in — answers that it is not available here, never a quiet success.
 */
const ASK_TIMEOUT_MS = 10 * 60_000;
const NOT_HERE = (what: string) => `${what} is not available in doctor mode; nothing was done`;

export interface DoctorRunOptions {
    readonly genieHome: string;
    readonly genieRunning: () => { running: true; pid: number } | { running: false };
    /** Write genie's own home (its instructions, the diagnostics skill) — what normal Genie's boot does — before genie starts here. */
    readonly prepareOsaHome: () => Promise<void>;
    /** Tests only: the drivers the agent's session starts with. Absent = the real providers. */
    readonly driverFor?: DriverFor;
    readonly processTree?: ProcessTree;
}

interface Opened {
    readonly registry: Registry;
    readonly host: SessionHost;
    readonly server: GenieMcpServer;
    readonly knowledge: KnowledgeStore;
}

/** A workspace's name as every surface shows it: project.json's, else the folder (core/workspace-name.ts). */
function nameOf(path: string): string {
    let manifest: string | null = null;
    try { manifest = readFileSync(join(path, 'project.json'), 'utf8'); } catch { manifest = null; }
    return workspaceDisplayName(manifest, path);
}

const ok = (payload: Record<string, unknown>): McpToolResult => ({ text: JSON.stringify({ ok: true, ...payload }), isError: false });
const err = (message: string): McpToolResult => ({ text: JSON.stringify({ ok: false, error: message }), isError: true });

export class DoctorRun {
    readonly #o: DoctorRunOptions;
    #opened: Promise<Opened> | null = null;
    #current: AgentRecord | null = null;

    constructor(options: DoctorRunOptions) {
        this.#o = options;
    }

    #osaDir(): string {
        return join(this.#o.genieHome, 'osa');
    }

    #cwdFor(registry: Registry, record: AgentRecord): string | null {
        return record.workspaceId === OS_WORKSPACE ? this.#osaDir() : registry.workspace(record.workspaceId)?.path ?? null;
    }

    /** Genie's data and its tool server, opened once — on the first start, with normal Genie closed. */
    #open(): Promise<Opened> {
        this.#opened ??= (async () => {
            const home = this.#o.genieHome;
            const registry = new Registry(new Store(home));
            await registry.load({ name: hostname(), healthy: true });
            const settings = await SettingsStore.open(home);
            const inbox = await InboxStore.open(home);
            const attention = await AttentionStore.open(home, inbox);
            const knowledge = KnowledgeStore.open(home);
            const feedback = await FeedbackStore.open(home);
            const book = new CallerBook();
            const resolveCaller = (key: string) => sessionCallerOf(book, key, registry, this.#osaDir());
            const roster = () => registry.listAgents();
            const unavailable = (what: string) => () => { throw new Error(NOT_HERE(what)); };
            const registrations = allGenieTools(genieToolDeps({
                inbox,
                attention,
                knowledge,
                settings,
                feedback,
                approve: unavailable('approving an action (there is no Deck in doctor mode)') as never,
                roster,
                resolveCaller,
                userActive: () => true,
                glow: () => false,
                thumbsUp: () => {},
                openFile: async () => ({ ok: false, reason: NOT_HERE('opening a file for the person') }),
                terminals: {
                    list: () => [],
                    open: unavailable('terminals') as never,
                    write: unavailable('terminals') as never,
                    scrollback: () => undefined,
                    scrollbackCap: 1_000_000,
                },
                sidecar: { register: unavailable('a sidecar') as never, start: unavailable('a sidecar') as never, running: () => false },
                plugins: { tools: () => [], guard: () => null, run: unavailable('plugin tools') as never },
            }));
            const server = genieMcpServer({ registrations, port: 0 });
            const endpoint = await server.start();
            const host = new SessionHost({
                userData: home,
                ...(this.#o.driverFor ? { driverFor: this.#o.driverFor } : {}),
                ...(this.#o.processTree ? { processTree: this.#o.processTree } : {}),
                mcpServersFor: (record) => genieMcpServers(endpoint, book.keyFor(record.id)),
                onThreadId: (agentId, threadId) => { void registry.recordThread(agentId, threadId); },
            });
            return { registry, host, server, knowledge };
        })();
        return this.#opened;
    }

    tools(): Registration[] {
        // A TITLE on every tool: prism serializes an absent one as `null`, and Claude then rejects the whole list (mcp-tool-titles.test).
        const tool = (name: string, title: string, description: string, properties: Record<string, unknown>, required: string[], run: (args: Record<string, unknown>) => Promise<McpToolResult>): Registration => ({
            definition: new ToolDefinition(name, description, { type: 'object', properties, required } as never, title),
            handler: async (args) => {
                try { return await run(args as Record<string, unknown>); } catch (error) { return err((error as Error).message); }
            },
        });
        return [
            tool('startAgent', 'Start an agent', 'Start ONE agent, on its own thread, with Genie’s real tools — to watch what it does. Leave workspace out for the workstation agent (genie). Refused while normal Genie is running.', {
                workspace: { type: 'string', description: 'The workspace’s name, id or path; leave out for the workstation agent.' },
                agent: { type: 'string', description: 'The agent’s name.' },
            }, ['agent'], async (args) => {
                const running = this.#o.genieRunning();
                if (running.running) return err(`Genie is running (pid ${running.pid}). Doctor mode can read but not start an agent while it runs — two Genies would drive the same agent's thread. Ask the person to close Genie, then try again.`);
                if (this.#current) return err(`${this.#current.name} is already started here; stop it first (one agent at a time)`);
                const opened = await this.#open();
                const name = typeof args.agent === 'string' ? args.agent.trim() : '';
                let workspaceId = OS_WORKSPACE;
                if (typeof args.workspace === 'string' && args.workspace.trim() !== '') {
                    const key = args.workspace.trim();
                    const w = opened.registry.listWorkspaces().find((x) => x.id === key || x.path === key || nameOf(x.path) === key);
                    if (!w) return err(`no workspace "${key}"; use loadWorkspace / workspaces to find its name`);
                    workspaceId = w.id;
                }
                const record = opened.registry.listAgents().find((a) => a.workspaceId === workspaceId && a.name === name);
                if (!record) return err(`no agent "${name}" there`);
                if (record.workspaceId === OS_WORKSPACE) await this.#o.prepareOsaHome();
                const cwd = this.#cwdFor(opened.registry, record);
                if (!cwd) return err(`${name}'s workspace has no folder Genie knows`);
                const started = opened.host.start(record, cwd);
                if (!started.ok) return err(started.reason);
                this.#current = record;
                return ok({ started: { name: record.name, workspaceId: record.workspaceId, cwd, resumesThread: record.threadId !== null } });
            }),
            tool('askAgent', 'Ask the agent', 'Send the started agent a message and wait for its reply; the reply comes with every tool call it made in that turn — name, input and final status (completed / failed). What a tool answered is in the reply: ask the agent to quote it.', {
                message: { type: 'string' },
            }, ['message'], async (args) => {
                const record = this.#current;
                if (!record) return err('no agent is started; use startAgent first');
                const message = typeof args.message === 'string' ? args.message.trim() : '';
                if (!message) return err('askAgent needs a message');
                const { host } = await this.#open();
                const before = host.rowsFor(record.id).length;
                const r = await askAndWait(host, record.id, `[from genie, diagnosing you in Genie's doctor mode] ${message}`, ASK_TIMEOUT_MS, record.name);
                // Each call once, at its last reported status. The stream carries no tool RESULT (ACP reports status, not
                // output) — what a tool answered is in the agent's reply, so ask it to quote.
                const calls = new Map<string, { name: string | null; title: string | null; status: string | null; input: unknown }>();
                for (const row of host.rowsFor(record.id).slice(before)) {
                    if (row.event.kind !== 'tool') continue;
                    const e = row.event;
                    const was = calls.get(e.toolCallId);
                    calls.set(e.toolCallId, { name: e.name ?? was?.name ?? null, title: e.title ?? was?.title ?? null, status: e.status ?? was?.status ?? null, input: e.rawInput ?? was?.input ?? null });
                }
                const tools = [...calls.values()];
                return r.ok ? ok({ reply: r.reply, tools }) : err(r.reason);
            }),
            tool('stopAgent', 'Stop the agent', 'Stop the started agent. Its thread and records are kept.', {}, [], async () => {
                const record = this.#current;
                if (!record) return err('no agent is started');
                (await this.#open()).host.stop(record.id);
                this.#current = null;
                return ok({ stopped: record.name });
            }),
        ];
    }

    /** Doctor mode is quitting: the agent stops, the server closes. */
    async stop(): Promise<void> {
        if (!this.#opened) return;
        const opened = await this.#opened;
        if (this.#current) opened.host.stop(this.#current.id);
        this.#current = null;
        await opened.server.stop();
        opened.knowledge.close?.();
    }
}
