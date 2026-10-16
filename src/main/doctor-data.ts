import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ToolDefinition, type McpToolResult } from '@particle-academy/prism-mcp';
import type { AgentRecord } from '../core/identity.js';
import { openDurableStore, readHistory } from '../core/thread-store.js';
import { workspaceDisplayName } from '../core/workspace-name.js';
import type { Registration } from './mcp-tools.js';
import { sessionsDir } from './paths.js';
import { OS_WORKSPACE } from './registry.js';
import { Store, type WorkspaceRecord } from './store.js';

/**
 * DOCTOR MODE'S DATA, ON DEMAND (the owner, 2026-10-13: "the genie agent is supposed to be able to [access] all user
 * data on a need to access basis. meaning it's not loaded by default but the genie agent can load a single workspace and
 * agent and diagnose any issues it's having"). Doctor still boots bare; these are genie's own tools there, and nothing
 * under ~/.genie is opened until one of them asks.
 *
 * They READ, and only read. Genie may be running beside doctor, and two writers on one file is how data is lost — so
 * the records come through `Store`'s readers, never `Registry.load` (which seeds the workstation agent and writes), and
 * the thread through `readHistory`, the reader the Agent view itself uses.
 */

/** The agent files Genie writes into a workspace (config sync), and the two instruction files it mirrors. */
const AGENT_FILES = ['.agents/_genie/shared.md', '.agents/_genie/genie-claude.md', '.agents/_genie/genie-codex.md', 'AGENTS.md', 'CLAUDE.md'] as const;
/** The recorded rows loadAgent returns by default; older ones are counted. */
const HISTORY_ROWS = 40;
const PERSONA_CHARS = 4000;
const ROW_CHARS = 600;

const ok = (payload: Record<string, unknown>): McpToolResult => ({ text: JSON.stringify({ ok: true, ...payload }), isError: false });
const err = (message: string): McpToolResult => ({ text: JSON.stringify({ ok: false, error: message }), isError: true });

async function readText(path: string): Promise<string | null> {
    try { return await readFile(path, 'utf8'); } catch { return null; }
}

async function exists(path: string): Promise<boolean> {
    try { await stat(path); return true; } catch { return false; }
}

/** How a workspace is NAMED: as every surface names it (core/workspace-name.ts) — project.json's name, else the folder. */
async function nameOf(w: WorkspaceRecord): Promise<string> {
    return workspaceDisplayName(await readText(join(w.path, 'project.json')), w.path);
}

/** One line of a recorded thread, as text a person (or genie) can read. */
function rowText(event: Record<string, unknown>): string {
    const text = ['text', 'title', 'path', 'reason'].map((k) => event[k]).find((v): v is string => typeof v === 'string') ?? '';
    return text.length > ROW_CHARS ? `${text.slice(0, ROW_CHARS)}…` : text;
}

export function doctorDataTools(deps: { genieHome: string }): Registration[] {
    const store = new Store(deps.genieHome);
    const load = async () => {
        const [workspaces, agents] = await Promise.all([store.readWorkspaces(), store.readAgents()]);
        const named = await Promise.all(workspaces.map(async (w) => ({ record: w, name: await nameOf(w) })));
        return { workspaces: named, agents };
    };
    type Loaded = Awaited<ReturnType<typeof load>>;
    const find = (data: Loaded, key: string) => data.workspaces.find((w) => w.record.id === key || w.name === key || w.record.path === key) ?? null;
    const names = (list: readonly string[]) => (list.length > 0 ? list.join(', ') : 'none');
    const brief = (a: AgentRecord) => ({ name: a.name, provider: a.provider });

    // A TITLE on every tool: prism serializes an absent one as `null`, and Claude then rejects the whole list (mcp-tool-titles.test).
    const tool = (name: string, title: string, description: string, properties: Record<string, unknown>, required: string[], run: (args: Record<string, unknown>) => Promise<McpToolResult>): Registration => ({
        definition: new ToolDefinition(name, description, { type: 'object', properties, required } as never, title),
        handler: async (args) => {
            try { return await run(args as Record<string, unknown>); } catch (error) { return err((error as Error).message); }
        },
    });

    return [
        tool('workspaces', 'Workspaces', 'Every workspace Genie knows, by name, with its agents, and the workstation agent. Reads Genie’s records; changes nothing.', {}, [], async () => {
            const data = await load();
            return ok({
                workspaces: await Promise.all(data.workspaces.map(async (w) => ({
                    id: w.record.id,
                    name: w.name,
                    path: w.record.path,
                    exists: await exists(w.record.path),
                    asleep: w.record.asleep === true,
                    agents: data.agents.filter((a) => a.workspaceId === w.record.id).map(brief),
                }))),
                workstation: { agents: data.agents.filter((a) => a.workspaceId === OS_WORKSPACE).map(brief) },
                ...(store.dropped.length > 0 ? { unreadable: [...store.dropped] } : {}),
            });
        }),
        tool('loadWorkspace', 'Load a workspace', 'Load ONE workspace to diagnose it: its record, its agents, and the agent files Genie writes into it (present or missing, and whether AGENTS.md and CLAUDE.md match). Reads only.', { workspace: { type: 'string', description: 'The workspace’s name, id or path.' } }, ['workspace'], async (args) => {
            const key = typeof args.workspace === 'string' ? args.workspace.trim() : '';
            const data = await load();
            const w = find(data, key);
            if (!w) return err(`no workspace "${key}"; Genie knows: ${names(data.workspaces.map((x) => x.name))}`);
            const files: Record<string, boolean | string> = {};
            for (const f of AGENT_FILES) files[f] = await exists(join(w.record.path, f));
            const [agentsMd, claudeMd] = await Promise.all([readText(join(w.record.path, 'AGENTS.md')), readText(join(w.record.path, 'CLAUDE.md'))]);
            files.mirror = agentsMd === null || claudeMd === null ? 'n/a' : agentsMd === claudeMd ? 'identical' : 'differs';
            return ok({
                workspace: { id: w.record.id, name: w.name, path: w.record.path, exists: await exists(w.record.path), asleep: w.record.asleep === true, governs: w.record.governs ?? [] },
                agents: data.agents.filter((a) => a.workspaceId === w.record.id).map((a) => ({ ...brief(a), model: a.model ?? null, mode: a.mode, permissions: a.permissions ?? 'all', hasThread: a.threadId !== null })),
                agentFiles: files,
            });
        }),
        tool('loadAgent', 'Load an agent', 'Load ONE agent to diagnose it: its record, its persona, and the last rows of its recorded conversation. Leave workspace out for the workstation agent (genie). Reads only.', {
            workspace: { type: 'string', description: 'The workspace’s name, id or path; leave out for the workstation agent.' },
            agent: { type: 'string', description: 'The agent’s name.' },
            rows: { type: 'number', description: `How many recorded rows to return (default ${HISTORY_ROWS}).` },
        }, ['agent'], async (args) => {
            const name = typeof args.agent === 'string' ? args.agent.trim() : '';
            const data = await load();
            let workspaceId = OS_WORKSPACE;
            let root: string | null = null;
            if (typeof args.workspace === 'string' && args.workspace.trim() !== '') {
                const w = find(data, args.workspace.trim());
                if (!w) return err(`no workspace "${args.workspace}"; Genie knows: ${names(data.workspaces.map((x) => x.name))}`);
                workspaceId = w.record.id;
                root = w.record.path;
            }
            const here = data.agents.filter((a) => a.workspaceId === workspaceId);
            const agent = here.find((a) => a.name === name);
            if (!agent) return err(`no agent "${name}" there; its agents: ${names(here.map((a) => a.name))}`);
            // The persona path is the record's — confined to the workspace, like every path an agent's record carries.
            let persona: { path: string; text: string } | null = null;
            if (agent.instructions && root) {
                const abs = resolve(root, agent.instructions);
                const rel = relative(resolve(root), abs);
                const text = !rel.startsWith('..') && !isAbsolute(rel) ? await readText(abs) : null;
                if (text !== null) persona = { path: agent.instructions, text: text.length > PERSONA_CHARS ? `${text.slice(0, PERSONA_CHARS)}…` : text };
            }
            const limit = typeof args.rows === 'number' && Number.isFinite(args.rows) ? Math.max(1, Math.min(500, Math.floor(args.rows))) : HISTORY_ROWS;
            const history = await readHistory(openDurableStore(sessionsDir(deps.genieHome)), agent.id, { limit });
            return ok({
                agent,
                persona,
                history: {
                    earlier: history.earlier,
                    rows: history.rows.map((r) => {
                        const event = r.event as unknown as Record<string, unknown>;
                        return { at: r.at === null ? null : new Date(r.at).toISOString(), kind: event.kind, ...(typeof event.speaker === 'string' ? { speaker: event.speaker } : {}), text: rowText(event) };
                    }),
                },
            });
        }),
    ];
}
