import { ToolDefinition, type JsonObject, type McpToolResult } from '@particle-academy/prism-mcp';
import type { ProcessLog } from '../core/output-tail.js';
import { callerFrom } from './mcp-callers.js';
import { MIRRORED_TERMINAL_ID, type Caller, type Registration } from './mcp-tools.js';
import type { HostedProcess, ProcessBook } from './process-book.js';
import type { RestartPolicy } from './process-supervisor.js';

/**
 * THE AGENTS' BACKGROUND PROCESSES (the hosting ship line P3; Genie 1's `manageProcess`). A queue worker, a watcher, a
 * dev server an agent needs kept running: it asks Genie, and Genie makes the very calls Hosting → Processes makes — the
 * process book (process-book.ts) writes it down and brings it back on every launch, the supervisor restarts it by its
 * policy and keeps its log after it exits. An agent never needs `nohup`, `&` or a terminal left open for this.
 *
 * The name is `processes`, beside `services` and `sites`, not Genie 1's `manageProcess`: Genie 2 names its tools for
 * what they hold, and the skills Genie 2 writes are pinned to never name a Genie 1-only tool (test/workspace-skills,
 * `V1_ONLY`), which `manageProcess` is. No Genie 2 skill or protocol text expects the old name.
 *
 * What an agent may do is decided HERE, before anything is called:
 * - Its OWN workspace only. It sees its workspace's processes — the ones kept here and its sites' servers — and acts by
 *   id or name looked up among THOSE; another workspace's process is "not one of this workspace's", with nothing done.
 * - `add` and `remove` wait for the PERSON's approval (approval-queue.ts), as `services add/remove` do: a process the
 *   book keeps is started on every launch from now on, so the person sees the command, the folder and the policy. A
 *   request Genie would refuse (no name, a folder outside the workspace, a hibernated workspace) is refused BEFORE the
 *   person is asked, and a denial creates nothing.
 * - `start`, `stop`, `restart` act at once, on a process the book keeps; a site's server belongs to its site (`sites`).
 * - `logs` reads any of this workspace's processes, a site's server included — the supervisor's tail, there after a
 *   crash.
 */

export type ProcessApproval = 'processes.add' | 'processes.remove';

/** What the tool acts on: the book (kept processes) and the supervisor's log tail. Main wires the real ones. */
export interface ProcessesPort {
    readonly book: Pick<ProcessBook, 'list' | 'prepare' | 'create' | 'start' | 'stop' | 'restart' | 'remove'>;
    readonly logs: (id: string, lines?: number) => ProcessLog | null;
}

export interface ProcessToolsDeps {
    readonly resolveCaller: (terminalId: string) => Caller | null;
    readonly approve: (caller: Caller, action: ProcessApproval, detail: string) => Promise<'allowed' | 'denied'>;
    /** `null` where this Genie keeps no processes (doctor mode), and every action says so. */
    readonly processes: ProcessesPort | null;
}

const ok = (payload: unknown): McpToolResult => ({ text: JSON.stringify(payload), isError: false });
const err = (message: string): McpToolResult => ({ text: JSON.stringify({ ok: false, error: message }), isError: true });
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

const POLICIES: readonly RestartPolicy[] = ['never', 'on-failure', 'always'];
export const DEFAULT_LOG_LINES = 200;
const NOT_HERE = 'this Genie keeps no background processes (doctor mode runs none); nothing was done';
const ACTIONS = 'list, logs, add, start, stop, restart, remove';

function view(p: HostedProcess): Record<string, unknown> {
    return {
        id: p.id,
        name: p.name,
        state: p.state,
        ...(p.command === undefined ? {} : { command: p.command }),
        pid: p.pid,
        exitCode: p.exitCode,
        restarts: p.restarts,
        since: new Date(p.since).toISOString(),
        // Kept: Genie brings it back on every launch and an agent may start/stop it. Not kept: a site's server.
        kept: p.durable === true,
        ...(p.reason === undefined ? {} : { reason: p.reason }),
    };
}

export function processTools(deps: ProcessToolsDeps): Registration[] {
    const tool: Registration = {
        definition: new ToolDefinition(
            'processes',
            'Your workspace’s background processes — queue workers, watchers, dev servers — kept running by GENIE: never leave one running in a terminal or with `nohup`/`&`. '
                + 'Genie starts it in the workspace with the workspace’s service variables, restarts it by its policy, brings it back on every launch until it is stopped, and keeps its log after it exits or crashes. '
                + 'Actions: `list` — this workspace’s processes, including its sites’ servers. '
                + '`logs` {process, lines?} — the end of its output (default 200 lines), still there after a crash. '
                + '`add` {name, command, folder? (inside the workspace; default its root), restart? on-failure (default) | always | never} — the person approves it first and sees the command. '
                + '`start` / `stop` / `restart` {process} — a process this workspace keeps (a site’s server is the `sites` tool’s). '
                + '`remove` {process} — the person approves it; it is stopped and no longer brought back.',
            {
                type: 'object',
                properties: {
                    terminalId: MIRRORED_TERMINAL_ID,
                    action: { type: 'string', enum: ['list', 'logs', 'add', 'start', 'stop', 'restart', 'remove'] },
                    process: { type: 'string', description: 'logs / start / stop / restart / remove: the process’s id or name, from `list`.' },
                    lines: { type: 'number', description: 'logs: how many lines from the end (default 200).' },
                    name: { type: 'string', description: 'add: what to call it (queue worker).' },
                    command: { type: 'string', description: 'add: the command Genie runs (php artisan queue:work).' },
                    folder: { type: 'string', description: 'add: a folder inside this workspace, relative to its root (repos/app); default the root.' },
                    restart: { type: 'string', enum: ['on-failure', 'always', 'never'], description: 'add: when Genie restarts it by itself; default on-failure.' },
                },
                required: ['action'],
            },
            'Processes',
        ),
        handler: async (args: JsonObject, context) => {
            const caller = callerFrom(args, context.headers, deps.resolveCaller);
            if (typeof caller === 'string') return err(caller);
            const port = deps.processes;
            if (!port) return err(NOT_HERE);
            const action = str(args.action) ?? '';
            // Every lookup is among THIS workspace's rows: another workspace's process is simply not found here.
            const mine = () => port.book.list(caller.workspaceId).filter((p) => p.workspaceId === caller.workspaceId);
            const find = (key: string | undefined): HostedProcess | string => {
                if (!key) return `${action} needs \`process\`; \`processes list\` shows them`;
                const rows = mine();
                const byId = rows.find((p) => p.id === key);
                if (byId) return byId;
                const named = rows.filter((p) => p.name === key);
                if (named.length === 1) return named[0]!;
                if (named.length > 1) return `more than one process here is called "${key}"; use its id: ${named.map((p) => p.id).join(', ')}`;
                // A site's server, worker or dev server is not a background process (the owner, 2026-10-21): the `sites` tool's.
                return `${key} is not one of this workspace’s background processes; \`processes list\` shows them. A site’s server, worker or dev server is the \`sites\` tool’s (\`sites logs\` reads its output). Nothing was done`;
            };
            const kept = (key: string | undefined): HostedProcess | string => {
                const p = find(key);
                if (typeof p === 'string') return p;
                return p.durable === true ? p : `${p.name} is a site’s server: it starts, stops and goes with its site (the \`sites\` tool). Nothing was done`;
            };
            const after = (id: string) => mine().find((p) => p.id === id);
            try {
                switch (action) {
                    case 'list':
                        return ok({ ok: true, processes: mine().map(view) });
                    case 'logs': {
                        const p = find(str(args.process));
                        if (typeof p === 'string') return err(p);
                        if (args.lines !== undefined && (typeof args.lines !== 'number' || !Number.isFinite(args.lines) || args.lines < 1)) return err('`lines` is a positive number');
                        const log = port.logs(p.id, typeof args.lines === 'number' ? Math.floor(args.lines) : DEFAULT_LOG_LINES);
                        if (!log) return ok({ ok: true, process: view(p), log: '', lines: 0, dropped: 0, note: 'Genie has no output from it since Genie started: it has not run since then' });
                        return ok({ ok: true, process: view(p), log: log.text, lines: log.lines, dropped: log.dropped });
                    }
                    case 'add': {
                        const name = str(args.name);
                        const command = str(args.command);
                        if (!name || !command) return err('add needs `name` and `command`. Nothing was done');
                        if (args.restart !== undefined && !POLICIES.includes(args.restart as RestartPolicy)) return err('`restart` is on-failure, always or never. Nothing was done');
                        if (args.folder !== undefined && typeof args.folder !== 'string') return err('`folder` is a folder inside this workspace. Nothing was done');
                        const input = {
                            workspaceId: caller.workspaceId,
                            workspacePath: caller.workspacePath,
                            name,
                            command,
                            folder: str(args.folder),
                            restart: (args.restart as RestartPolicy | undefined) ?? 'on-failure',
                        };
                        // The book's own checks, BEFORE anyone is asked: a request Genie would refuse is never put to the person.
                        const ready = port.book.prepare(input);
                        const verdict = await deps.approve(caller, 'processes.add', `${ready.name}: \`${ready.command}\` in ${ready.cwd}, restart ${ready.restart} — Genie starts it now and brings it back on every launch until it is stopped`);
                        if (verdict !== 'allowed') return err(`adding ${ready.name} was denied by the person; nothing was started or kept`);
                        const status = await port.book.create(input);
                        const row = after(status.id);
                        return ok({ ok: true, process: row ? view(row) : { id: status.id, name: status.name, state: status.state } });
                    }
                    case 'start':
                    case 'stop':
                    case 'restart': {
                        const p = kept(str(args.process));
                        if (typeof p === 'string') return err(p);
                        if (action === 'start') await port.book.start(p.id);
                        else if (action === 'stop') await port.book.stop(p.id);
                        else await port.book.restart(p.id);
                        const row = after(p.id);
                        return ok({ ok: true, process: row ? view(row) : { id: p.id, name: p.name } });
                    }
                    case 'remove': {
                        const p = kept(str(args.process));
                        if (typeof p === 'string') return err(p);
                        const verdict = await deps.approve(caller, 'processes.remove', `${p.name}${p.command ? ` (\`${p.command}\`)` : ''} — stopped, and no longer brought back on launch`);
                        if (verdict !== 'allowed') return err(`removing ${p.name} was denied by the person; nothing was done`);
                        await port.book.remove(p.id);
                        return ok({ ok: true, removed: p.id });
                    }
                    default:
                        return err(`unknown action ${JSON.stringify(action)}; the actions are ${ACTIONS}`);
                }
            } catch (error) {
                return err((error as Error).message);
            }
        },
    };
    return [tool];
}
