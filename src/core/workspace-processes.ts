import { AGENT_NAME } from './agent-adoption.js';
import { SHARED_SCHEMAS_PIN } from './shared-schemas-pin.js';
import { folderWithin } from './v1-processes.js';
import type { Exclusion } from './workspace-elements.js';
import { fileStem } from './workspace-file-names.js';

/**
 * BACKGROUND PROCESSES AND SCHEDULED TASKS, SAVED AS FILES (Tynn #756, PR6). Each is `.processes/<name>.json`, one file per
 * process, in the shape shared-schemas v0.5.0 publishes (`process.schema.json`): what to run, the folder it runs in RELATIVE to the
 * workspace, its restart policy and, for a scheduled task, its cron and what a fire does. What stays on the machine: its id,
 * whether it is running (`wanted`: the person's intent), when it last ran and how that ended, and every absolute path.
 *
 * A scheduled task is a process with a schedule (core/scheduled-task.ts), so one file shape holds both. An agent nudge runs
 * nothing: the file's required `command` says `agent-nudge`, and the agent is saved by NAME (the inbox address names this
 * workspace's slug, which is not the clone's to inherit).
 */

export const PROCESS_SCHEMA_URL = `https://raw.githubusercontent.com/${SHARED_SCHEMAS_PIN.repo}/${SHARED_SCHEMAS_PIN.tag}/schemas/workspace/process.schema.json`;

/** What a save reads of a kept process. Never its id, intent or history. */
export interface ProcessSource {
    readonly name: string;
    readonly workspaceId: string;
    readonly command: string;
    /** The folder it runs in, absolute, as the book keeps it. */
    readonly cwd: string;
    readonly restart: 'never' | 'on-failure' | 'always';
    readonly schedule?: { readonly cron: string; readonly kind: 'command' | 'agent-nudge'; readonly prompt?: string; readonly agent?: string; readonly lastRunAt?: number; readonly lastRunStatus?: string };
}

/** This workspace's processes as `.processes/<name>.json` files, in the order given; the ones that cannot be saved, with why. */
export function processesDeclaration(processes: readonly ProcessSource[], workspaceId: string, workspacePath: string): { files: { path: string; value: unknown }[]; excluded: Exclusion[] } {
    const files: { path: string; value: unknown }[] = [];
    const excluded: Exclusion[] = [];
    const taken = new Set<string>();
    for (const p of processes) {
        if (p.workspaceId !== workspaceId) continue;
        const stem = fileStem(p.name, taken, 'process');
        const path = `.processes/${stem}.json`;
        const skip = (reason: string): void => { excluded.push({ field: path, reason }); };
        const nudge = p.schedule?.kind === 'agent-nudge';
        const command = p.command.trim();
        if (!nudge && command === '') { skip('it has no command to run, so there is nothing to save'); continue; }
        const folder = folderWithin(workspacePath, p.cwd);
        if (folder === null) { skip('it runs outside the workspace, in a folder a clone would not have'); continue; }
        let agent: string | undefined;
        if (nudge) {
            agent = (p.schedule?.agent ?? '').split('@')[0] ?? '';
            if (!AGENT_NAME.test(agent)) { skip(`its agent "${p.schedule?.agent ?? ''}" is not a Genie agent name, so a clone could not find it`); continue; }
            if ((p.schedule?.prompt ?? '').trim() === '') { skip('its nudge has no prompt'); continue; }
        }
        taken.add(stem);
        files.push({
            path,
            value: {
                $schema: PROCESS_SCHEMA_URL,
                command: nudge && command === '' ? 'agent-nudge' : command,
                ...(folder !== '' ? { folder } : {}),
                ...(p.schedule ? {} : { restart: p.restart }),
                ...(p.schedule ? { schedule: { cron: p.schedule.cron, kind: p.schedule.kind, ...(nudge ? { prompt: p.schedule.prompt, agent } : {}) } } : {}),
            },
        });
    }
    return { files, excluded };
}

/** What a process file would run: a person trusts these before it is kept. */
export interface ProcessTrustItem {
    readonly file: string;
    readonly commands: readonly string[];
}

export function processTrustItems(files: readonly { path: string; value: unknown }[]): ProcessTrustItem[] {
    const items: ProcessTrustItem[] = [];
    for (const file of files) {
        const v = file.value as { command?: unknown; schedule?: { kind?: unknown; prompt?: unknown; agent?: unknown } } | null;
        if (v === null || typeof v !== 'object') continue;
        if (v.schedule?.kind === 'agent-nudge') items.push({ file: file.path, commands: [`ask ${String(v.schedule.agent)}: ${String(v.schedule.prompt)}`] });
        else if (typeof v.command === 'string' && v.command.trim() !== '') items.push({ file: file.path, commands: [v.command] });
    }
    return items;
}
