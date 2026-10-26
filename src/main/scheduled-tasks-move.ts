import { join, normalize } from 'node:path';
import { canonicalKind } from '../core/flow-canvas.js';
import { flowNodes } from '../core/flow-form.js';
import type { ProcessSchedule } from '../core/scheduled-task.js';
import type { FlowStore } from './flow-store.js';
import type { AdoptedSchedule, ProcessBook } from './process-book.js';

/**
 * GENIE 1's SCHEDULED TASKS LEAVE FLOWS (genie#1204; the owner, 2026-10-26: the rows on the Flows page "are NOT flows").
 *
 * Earlier betas (from f295b14a) imported each Genie 1 scheduled task as a FLOW — a schedule trigger feeding one step — so a
 * scheduled command read as a workflow. In Genie 1 it was a background process with a schedule
 * (main/terminal/process-scheduler.ts at v0.7.0-beta.342), and that is what it is again: this moves each one to the process
 * book as a scheduled task, keeping its schedule, its command and folder (or the agent and prompt of a nudge), and whether
 * the person had armed it.
 *
 * ONCE, by a MARKER in processes.json (`scheduledTasksMoved`). Every step is also safe to repeat should a boot stop half
 * way: the processes are UPSERTED by id (`proc_v1_<v1 task id>`, the id the v1 import itself uses) before the flows are
 * removed, and the marker is written last. A flow the person has since drawn into a real workflow is not a scheduled task
 * any more: it stays in Flows, and the marker says so.
 */

export type ScheduledFromFlow =
    | { readonly ok: true; readonly command: string; readonly cwd: string; readonly schedule: ProcessSchedule }
    | { readonly ok: false; readonly why: string };

/**
 * A flow that IS a scheduled task — exactly a schedule trigger and one step that runs a command or prompts an agent — as
 * that task; anything else says why it is not one. `cwd` is absolute, inside the workspace.
 */
export function scheduledTaskFromFlow(document: unknown, workspaceId: string, workspacePath: string): ScheduledFromFlow {
    const nodes = flowNodes(document);
    const trigger = nodes.find((n) => canonicalKind(n.kind) === '@particle-academy/schedule_trigger');
    const steps = nodes.filter((n) => n !== trigger);
    if (!trigger || steps.length !== 1) return { ok: false, why: `it is a workflow now (${nodes.length} steps), not a schedule and one step` };
    const cron = typeof trigger.config?.cron === 'string' ? trigger.config.cron.trim() : '';
    const step = steps[0]!;
    const text = (key: string) => (typeof step.config?.[key] === 'string' ? (step.config[key] as string).trim() : '');
    if (step.kind === 'genie/terminal_run') {
        if (text('workspace') !== workspaceId) return { ok: false, why: `its command runs in another workspace (${text('workspace')})` };
        const folder = text('cwd');
        return { ok: true, command: text('command'), cwd: folder ? normalize(join(workspacePath, folder)) : workspacePath, schedule: { cron, kind: 'command' } };
    }
    if (step.kind === 'genie/agent_prompt') {
        return { ok: true, command: '', cwd: workspacePath, schedule: { cron, kind: 'agent-nudge', prompt: text('prompt'), agent: text('agent') } };
    }
    return { ok: false, why: `its step is ${step.kind}, not a command or a prompt to an agent` };
}

export async function moveScheduledTasksOutOfFlows(flows: FlowStore, book: ProcessBook, workspacePath: (workspaceId: string) => string | null): Promise<{ moved: number; kept: string[] }> {
    if (book.scheduledTasksMoved()) return { moved: 0, kept: [] };
    const candidates = flows.list().filter((f) => f.importedFrom !== undefined);
    const adopted: AdoptedSchedule[] = [];
    const movedFlows: string[] = [];
    const kept: string[] = [];
    for (const f of candidates) {
        const path = workspacePath(f.workspaceId);
        const task = path === null ? ({ ok: false, why: `its workspace ${f.workspaceId} is not here` } as const) : scheduledTaskFromFlow(f.document, f.workspaceId, path);
        if (!task.ok) {
            kept.push(`"${f.name}" ${task.why.startsWith('it is a workflow now') ? `is a workflow now — ${task.why.slice('it is a workflow now '.length)} —` : `could not move (${task.why}) and`} stays in Flows`);
            continue;
        }
        adopted.push({ id: `proc_v1_${f.importedFrom!.v1SpecId}`, workspaceId: f.workspaceId, name: f.name, command: task.command, cwd: task.cwd, wanted: f.armed, schedule: task.schedule });
        movedFlows.push(f.id);
    }
    // Processes first, then the flows go, then the marker: a boot that stops between them repeats the same upserts.
    await book.adoptScheduled(adopted);
    for (const id of movedFlows) await flows.remove(id);
    await book.markScheduledTasksMoved({ at: new Date().toISOString(), moved: adopted.length, kept });
    if (adopted.length > 0 || kept.length > 0) console.log(`[genie] scheduled tasks: ${adopted.length} moved from Flows to background processes${kept.length ? `; ${kept.join(' | ')}` : ''}`);
    return { moved: adopted.length, kept };
}
