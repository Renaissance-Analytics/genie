import { scheduleProblem } from '../core/scheduled-task.js';
import { cwdProblem } from '../core/workspace-save-guard.js';
import { processesDeclaration, processTrustItems, type ProcessSource } from '../core/workspace-processes.js';

/**
 * A FRESH CLONE'S `.processes/`, KEPT STOPPED (Tynn #756, PR6). Each file becomes a kept process that is NOT running (a scheduled
 * task is PAUSED): starting runs code on a person's machine, and is theirs after the workspace's one-time trust. A process's
 * folder is read by the same `cwd` rule the guard applies; a key that is not saved with a process is a refusal, and the machine's
 * own (an id, `wanted`, a last run) is dropped and named, so a hand-edited file cannot start anything. One already kept under that
 * name is never overwritten: the same is `present`, a different one is `differs`.
 */

export interface KeepInput {
    readonly workspaceId: string;
    readonly workspacePath: string;
    readonly name: string;
    readonly command: string;
    readonly folder?: string | undefined;
    readonly restart: 'never' | 'on-failure' | 'always';
    readonly schedule?: { readonly cron: string; readonly kind: 'command' | 'agent-nudge'; readonly prompt?: string | undefined; readonly agent?: string | undefined } | undefined;
    /** A scheduled task's schedule starts paused. */
    readonly enabled?: boolean | undefined;
}

export interface ProcessPorts {
    /** The processes already kept for the workspace. */
    list(workspaceId: string): readonly ProcessSource[];
    /** Keep one, stopped (`ProcessBook.keep`). */
    keep(input: KeepInput): Promise<unknown>;
    /** An agent of the workspace by name, as its inbox address; null when there is none. */
    agentAddressOf(workspaceId: string, name: string): string | null;
}

export interface ProcessRestore {
    readonly created: string[];
    readonly present: string[];
    readonly differs: string[];
    readonly waiting: { file: string; commands: string[] }[];
    readonly refused: { file: string; reason: string }[];
    readonly ignored: { file: string; keys: string[] }[];
}

/** The machine's: dropped, never applied. */
const MACHINE_KEYS: ReadonlySet<string> = new Set(['id', 'workspaceId', 'cwd', 'wanted', 'changedAt', 'lastRunAt', 'lastRunStatus', 'pid', 'port']);
const SCHEDULE_MACHINE_KEYS: ReadonlySet<string> = new Set(['lastRunAt', 'lastRunStatus']);
const KNOWN_KEYS: ReadonlySet<string> = new Set(['$schema', 'command', 'folder', 'restart', 'schedule']);
const SCHEDULE_KEYS: ReadonlySet<string> = new Set(['cron', 'kind', 'prompt', 'agent']);
const RESTARTS = ['never', 'on-failure', 'always'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const stemOf = (path: string): string => (path.split('/').at(-1) ?? path).replace(/\.json$/i, '');

/** Key order must not decide whether two processes are the same. */
function canon(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
    if (isRecord(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`;
    return JSON.stringify(value) ?? 'undefined';
}

export async function restoreProcesses(files: readonly { path: string; text: string }[], options: { workspaceId: string; workspacePath: string; ports: ProcessPorts; trusted: boolean }): Promise<ProcessRestore> {
    const { workspaceId, workspacePath, ports } = options;
    const out: ProcessRestore = { created: [], present: [], differs: [], waiting: [], refused: [], ignored: [] };
    for (const file of files) {
        const refuse = (reason: string): void => { out.refused.push({ file: file.path, reason }); };
        let parsed: unknown;
        try { parsed = JSON.parse(file.text); } catch (error) { refuse(`not valid JSON (${error instanceof Error ? error.message : String(error)})`); continue; }
        if (!isRecord(parsed)) { refuse('a process file is one JSON object'); continue; }
        const ignored: string[] = [];
        const body: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (MACHINE_KEYS.has(key)) ignored.push(key); else body[key] = value;
        }
        const stray = Object.keys(body).find((k) => !KNOWN_KEYS.has(k));
        if (stray !== undefined) { refuse(`${stray} is not saved with a process`); continue; }
        let schedule = body.schedule;
        if (schedule !== undefined) {
            if (!isRecord(schedule)) { refuse('schedule is an object: a cron and a kind'); continue; }
            const kept: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(schedule)) {
                if (SCHEDULE_MACHINE_KEYS.has(key)) ignored.push(`schedule.${key}`); else kept[key] = value;
            }
            const unknown = Object.keys(kept).find((k) => !SCHEDULE_KEYS.has(k));
            if (unknown !== undefined) { refuse(`schedule.${unknown} is not saved with a process`); continue; }
            schedule = kept;
        }
        if (ignored.length > 0) out.ignored.push({ file: file.path, keys: ignored.sort() });

        const nudge = isRecord(schedule) && schedule.kind === 'agent-nudge';
        const command = typeof body.command === 'string' ? body.command.trim() : '';
        if (command === '') { refuse('a process needs a command to run'); continue; }
        const folder = body.folder;
        if (folder !== undefined) {
            const problem = typeof folder === 'string' ? cwdProblem(folder) : 'is not text';
            if (problem !== null) { refuse(`its cwd (folder) ${JSON.stringify(folder)} ${problem}; a cwd is a folder inside the workspace, like repos/app`); continue; }
        }
        const restart = body.restart === undefined ? 'never' : body.restart;
        if (!RESTARTS.includes(restart as never)) { refuse(`restart is one of ${RESTARTS.join(', ')}`); continue; }

        let keepSchedule: KeepInput['schedule'];
        if (isRecord(schedule)) {
            const cron = typeof schedule.cron === 'string' ? schedule.cron : '';
            const kind = schedule.kind === 'agent-nudge' ? 'agent-nudge' : schedule.kind === 'command' ? 'command' : null;
            if (kind === null) { refuse('a schedule is a command or an agent-nudge'); continue; }
            let agent: string | undefined;
            if (nudge) {
                const named = typeof schedule.agent === 'string' ? schedule.agent : '';
                const address = named === '' ? null : ports.agentAddressOf(workspaceId, named);
                if (address === null) { refuse(`no agent named "${named}" in this workspace yet; its agent has to exist before this task can nudge it`); continue; }
                agent = address;
            }
            const problem = scheduleProblem({ cron, kind, prompt: typeof schedule.prompt === 'string' ? schedule.prompt : undefined, agent }, nudge ? '' : command);
            if (problem !== null) { refuse(problem); continue; }
            keepSchedule = { cron: cron.trim(), kind, ...(nudge ? { prompt: String(schedule.prompt).trim(), agent } : {}) };
        }

        const name = stemOf(file.path);
        const here = ports.list(workspaceId).find((p) => p.name === name);
        if (here) {
            const mine = processesDeclaration([{ ...here, workspaceId }], workspaceId, workspacePath).files[0]?.value;
            const theirs = { ...body, ...(isRecord(schedule) ? { schedule } : {}), ...(body.restart === undefined && schedule === undefined ? { restart: 'never' } : {}) };
            (canon(mine) === canon(theirs) ? out.present : out.differs).push(file.path);
            continue;
        }
        const trust = processTrustItems([{ path: file.path, value: { ...body, schedule } }]);
        if (!options.trusted) { out.waiting.push({ file: file.path, commands: trust.flatMap((t) => [...t.commands]) }); continue; }
        await ports.keep({
            workspaceId,
            workspacePath,
            name,
            command: nudge ? '' : command,
            ...(typeof folder === 'string' && folder !== '' && folder !== '.' ? { folder } : {}),
            restart: schedule === undefined ? (restart as KeepInput['restart']) : 'never',
            ...(keepSchedule ? { schedule: keepSchedule, enabled: false } : {}),
        });
        out.created.push(file.path);
    }
    return out;
}
