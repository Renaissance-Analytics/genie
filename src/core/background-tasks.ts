/**
 * CLAUDE'S BACKGROUND TASKS, as prism-acp hands them over: debug notices carrying `_meta` (spelled here as
 * RATE_LIMIT_META is, so this module needs nothing at runtime from the driver package).
 *
 * - `particle.academy/task` — one task's event: `started`, `updated` or `ended` (Claude's `task_started`,
 *   `task_updated`, `task_notification`).
 * - `particle.academy/background_tasks` — the FULL live set (Claude's `background_tasks_changed`). Claude sends none
 *   at startup; a client starts from an empty set whenever the CLI process starts.
 *
 * Source: the Claude Agent SDK TypeScript reference (`SDKTaskStartedMessage` and the rest). Anything malformed is
 * dropped field by field, never guessed.
 */

export const TASK_META = 'particle.academy/task';
export const BACKGROUND_TASKS_META = 'particle.academy/background_tasks';

/** One entry of the live set. `taskType`: `local_bash` (a shell or a Monitor watch), `local_agent`, `remote_agent`. */
export interface BackgroundTask {
    taskId: string;
    taskType: string;
    description: string;
    /** Claude Code's own work (not the session's): shown, never counted. */
    ambient: boolean;
}

export interface TaskEvent {
    event: 'started' | 'updated' | 'ended';
    taskId: string;
    toolUseId: string | null;
    taskType: string | null;
    description: string | null;
    ambient: boolean;
    /** `ended`: completed / failed / stopped. `updated`: the patch's status (pending, running, completed, failed, killed). */
    status: string | null;
    summary: string | null;
    outputFile: string | null;
    /** `updated`: the patch's `endTime` (epoch ms). */
    endTime: number | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The live set on a notice's `_meta`, or `null` when the notice carries none. An empty array is a claim: nothing runs. */
export function backgroundTasksOf(meta: unknown): BackgroundTask[] | null {
    if (!isRecord(meta)) return null;
    const list = meta[BACKGROUND_TASKS_META];
    if (!Array.isArray(list)) return null;
    const out: BackgroundTask[] = [];
    for (const t of list) {
        if (!isRecord(t)) continue;
        const taskId = str(t['taskId']);
        if (taskId === null) continue;
        out.push({ taskId, taskType: str(t['taskType']) ?? 'unknown', description: str(t['description']) ?? '', ambient: t['ambient'] === true });
    }
    return out;
}

/** One task's event on a notice's `_meta`, or `null`. */
export function taskEventOf(meta: unknown): TaskEvent | null {
    if (!isRecord(meta)) return null;
    const t = meta[TASK_META];
    if (!isRecord(t)) return null;
    const event = t['event'];
    const taskId = str(t['taskId']);
    if ((event !== 'started' && event !== 'updated' && event !== 'ended') || taskId === null) return null;
    const patch = isRecord(t['patch']) ? t['patch'] : {};
    // Claude's patch says `end_time`; prism-acp may camelCase it. Either is the same claim.
    const rawEnd = patch['endTime'] ?? patch['end_time'];
    const endTime = typeof rawEnd === 'number' ? rawEnd : null;
    return {
        event,
        taskId,
        toolUseId: str(t['toolUseId']),
        taskType: str(t['taskType']),
        description: str(t['description']) ?? str(patch['description']),
        ambient: t['ambient'] === true,
        status: str(t['status']) ?? str(patch['status']),
        summary: str(t['summary']),
        outputFile: str(t['outputFile']),
        endTime,
    };
}
