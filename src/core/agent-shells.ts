import type { TimedEvent } from './stream-view.js';

/**
 * WHAT AN AGENT HAS RUNNING (the Shells tab, after Changes). The owner: "I NEED TO SEE EVERYTHING AN AGENT IS DOING."
 *
 * Read from the agent's own ledger, nothing else:
 * - a Bash call with `run_in_background: true` is a command it started in the background;
 * - Claude's background-task notices (`core/background-tasks.ts`) say what is running and how each ended — joined to
 *   the Bash call by its tool-use id. The live set is AUTHORITATIVE: a running task it drops is no longer running;
 * - a `run` row is a new CLI process, which starts from NOTHING running (Claude sends no set at startup): what ran
 *   before is `gone` — Genie can no longer see it, which is not the same claim as "it finished";
 * - a Genie `manageTerminals` create is a terminal it opened (terminals are the workspace's; this is the ledger's
 *   account of who asked).
 *
 * With no task notices at all (an older prism-acp, or Codex), a background command is `unreported` — listed, its
 * state never guessed.
 */

export type ShellState = 'running' | 'completed' | 'failed' | 'stopped' | 'gone' | 'unreported';

export interface AgentShell {
    /** The task id, or the tool call's when no task was ever reported for it. */
    key: string;
    kind: 'shell' | 'subagent' | 'remote' | 'task';
    command: string | null;
    description: string | null;
    state: ShellState;
    ambient: boolean;
    startedAt: number | null;
    endedAt: number | null;
    summary: string | null;
    outputFile: string | null;
}

export interface AgentShells {
    running: AgentShell[];
    ended: AgentShell[];
    unreported: AgentShell[];
    terminals: { key: string; command: string | null; at: number | null }[];
    /** Whether the provider reported background tasks at all in this ledger. */
    reported: boolean;
    /** The indicator: running and not Claude Code's own. */
    count: number;
}

const kindOf = (taskType: string | null): AgentShell['kind'] =>
    taskType === 'local_bash' ? 'shell' : taskType === 'local_agent' ? 'subagent' : taskType === 'remote_agent' ? 'remote' : 'task';

const endedState = (status: string | null): ShellState | null =>
    status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'stopped' || status === 'killed' ? 'stopped' : null;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function agentShells(rows: readonly TimedEvent[]): AgentShells {
    const byKey = new Map<string, AgentShell>();
    /** Tool-use id → the background command it started, before (or without) a task naming it. */
    const commands = new Map<string, AgentShell>();
    const terminals: AgentShells['terminals'] = [];
    /** A tool's name rides its first `tool_call`; its input the later `tool_call_update`, which has none (prism-acp). */
    const names = new Map<string, string>();
    let reported = false;

    const taskFor = (taskId: string, toolUseId: string | null, at: number | null): AgentShell => {
        const existing = byKey.get(taskId);
        if (existing) return existing;
        const command = toolUseId !== null ? commands.get(toolUseId) : undefined;
        const shell: AgentShell = command
            ? { ...command, key: taskId }
            : { key: taskId, kind: 'task', command: null, description: null, state: 'running', ambient: false, startedAt: at, endedAt: null, summary: null, outputFile: null };
        if (command && toolUseId !== null) commands.delete(toolUseId);
        byKey.set(taskId, shell);
        return shell;
    };

    for (const { event: e, at } of rows) {
        if (e.kind === 'run') {
            for (const s of byKey.values()) if (s.state === 'running') { s.state = 'gone'; s.endedAt = at; }
            // A command the earlier process never reported on is not this process's either.
            for (const [id, c] of commands) { byKey.set(id, { ...c, state: 'gone', endedAt: at }); commands.delete(id); }
            continue;
        }

        if (e.kind === 'tool') {
            const said = `${e.name ?? ''} ${e.title ?? ''}`.trim();
            if (said !== '' && e.toolCallId !== '' && !names.has(e.toolCallId)) names.set(e.toolCallId, said);
            const input = isRecord(e.rawInput) ? e.rawInput : null;
            if (!input) continue;
            if (input['run_in_background'] === true && typeof input['command'] === 'string' && !commands.has(e.toolCallId)) {
                const description = typeof input['description'] === 'string' ? input['description'] : null;
                commands.set(e.toolCallId, { key: e.toolCallId, kind: 'shell', command: input['command'], description, state: 'unreported', ambient: false, startedAt: at, endedAt: null, summary: null, outputFile: null });
            } else if (input['action'] === 'create' && /manageTerminals/.test(`${e.name ?? ''} ${e.title ?? ''} ${names.get(e.toolCallId) ?? ''}`) && !terminals.some((t) => t.key === e.toolCallId)) {
                terminals.push({ key: e.toolCallId, command: typeof input['command'] === 'string' ? input['command'] : null, at });
            }
            continue;
        }

        if (e.kind !== 'notice') continue;

        if (e.task) {
            reported = true;
            const t = e.task;
            const shell = taskFor(t.taskId, t.toolUseId, at);
            if (t.taskType !== null) shell.kind = kindOf(t.taskType);
            if (t.description !== null && shell.description === null) shell.description = t.description;
            if (t.ambient) shell.ambient = true;
            if (t.event === 'started') {
                shell.state = 'running';
                shell.startedAt ??= at;
            } else {
                const ended = endedState(t.status);
                if (ended) {
                    shell.state = ended;
                    shell.endedAt = t.endTime ?? at;
                }
                if (t.summary !== null) shell.summary = t.summary;
                if (t.outputFile !== null) shell.outputFile = t.outputFile;
            }
            continue;
        }

        if (e.tasks) {
            reported = true;
            const live = new Set(e.tasks.map((t) => t.taskId));
            for (const s of byKey.values()) if (s.state === 'running' && !live.has(s.key)) { s.state = 'gone'; s.endedAt = at; }
            for (const t of e.tasks) {
                const shell = taskFor(t.taskId, null, at);
                shell.kind = kindOf(t.taskType);
                if (shell.description === null && t.description !== '') shell.description = t.description;
                shell.ambient = t.ambient;
                shell.state = 'running';
                shell.endedAt = null;
            }
        }
    }

    const all = [...byKey.values()];
    const running = all.filter((s) => s.state === 'running');
    return {
        running,
        ended: all.filter((s) => s.state !== 'running' && s.state !== 'unreported'),
        unreported: [...commands.values()],
        terminals,
        reported,
        count: running.filter((s) => !s.ambient).length,
    };
}
