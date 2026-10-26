import { parseCron } from './cron.js';
import { FLOW_SCHEMA_URL } from './flow-form.js';
import { folderWithin, type V1ProcessSpec } from './v1-processes.js';

/**
 * GENIE 1's SCHEDULED TASKS → GENIE 2's SCHEDULED BACKGROUND PROCESSES — the pure plan (no I/O).
 *
 * What a task DOES is planned as a one-step document (a schedule feeding a command or an agent prompt) that the process
 * book turns into a scheduled task (main/scheduled-tasks-move.ts `scheduledTaskFromFlow`) — the same reading that moves the
 * tasks earlier betas imported as flows (genie#1204: they are background processes with a schedule, as in Genie 1).
 *
 * Genie 1 kept a scheduled task as a background process with a schedule: a `terminal_specs` row of
 * type 'process' whose `meta_json` carries `schedule` (five-field cron, evaluated in the machine's
 * local time) and `schedule_kind`:
 * - `command` (the default) — run `meta.command` in the row's `cwd`;
 * - `agent-nudge` — hand `meta.nudge_prompt` to an agent, named by `meta.nudge_agent_id` (its inbox id)
 *   or `meta.nudge_target_terminal_id` (its terminal);
 * - `flow` — fire a Genie 1 workflow (`meta.flow_id`).
 * `main/v1-schedules.ts` reads them; this decides what each one becomes.
 *
 * The rules:
 * - EVERY task comes over PAUSED. Enabling a schedule is the person's decision, and an import is not the person
 *   deciding — so a task that was firing in Genie 1 is noted as such, and waits for them to enable it.
 * - The schedule keeps its meaning: no timezone, so it is evaluated in this machine's local time, as Genie 1 did.
 * - `command` → schedule → `genie/terminal_run` (the folder relative to the workspace); `agent-nudge` →
 *   schedule → `genie/agent_prompt` to the agent's FULL address (Genie 2's identity is (workspace, name), and
 *   its agent import kept both, so the roster record with that pair is the same agent).
 * - Not imported, and noted with why: no workspace, a workspace Genie 2 does not have, a schedule Genie cannot
 *   evaluate, no command, a folder outside its workspace, no prompt, an agent Genie 1 no longer knows or Genie 2
 *   does not have, a `flow` task (Genie 1's workflows are not brought over), a kind Genie 2 does not know.
 * - Ids: the process is `proc_v1_<v1 id>` — stable, so an id already kept is recognised and left alone.
 */

/** A v1 agent and every id v1 used for it: its `workspace_agents.id`, its terminal, that terminal's inbox id. */
export interface V1AgentIdentity {
    readonly workspaceId: string;
    readonly name: string;
    readonly keys: readonly string[];
}

export interface V1Schedules {
    /** `terminal_specs` rows of type 'process' that carry a schedule. */
    readonly specs: readonly V1ProcessSpec[];
    readonly agents: readonly V1AgentIdentity[];
}

export interface V1SchedulePlanned {
    readonly id: string;
    readonly v1SpecId: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly document: Record<string, unknown>;
}

export interface V1SchedulePlan {
    readonly flows: readonly V1SchedulePlanned[];
    /** One line per task not imported, or imported with something the person should know. */
    readonly notes: readonly string[];
}

export const V1_FLOW_ID_PREFIX = 'flow_v1_';

export interface V1ScheduleContext {
    readonly workspaces: readonly { readonly id: string; readonly path: string }[];
    readonly roster: readonly { readonly workspaceId: string; readonly provider: string; readonly name: string }[];
}

/** `null` = cannot see v1, so nothing is planned and nothing is claimed. */
export function planV1ScheduleImport(v1: V1Schedules | null, ctx: V1ScheduleContext): V1SchedulePlan | null {
    if (v1 === null) return null;
    const pathOf = new Map(ctx.workspaces.map((w) => [w.id, w.path]));
    const flows: V1SchedulePlanned[] = [];
    const notes: string[] = [];
    for (const spec of v1.specs) {
        const meta = parseMeta(spec.meta);
        const cron = typeof meta.schedule === 'string' ? meta.schedule.trim() : '';
        if (!cron) continue; // not a scheduled task: the process import's business
        const command = typeof meta.command === 'string' ? meta.command.trim() : '';
        const name = spec.label.trim() || command || spec.id;
        const say = (why: string) => notes.push(`scheduled task ${spec.id} ("${name}"): ${why}`);
        if (spec.workspaceId === null) {
            say('has no workspace in Genie 1; not imported');
            continue;
        }
        const workspacePath = pathOf.get(spec.workspaceId);
        if (workspacePath === undefined) {
            say(`its workspace ${spec.workspaceId} is not in Genie 2; not imported`);
            continue;
        }
        if (parseCron(cron) === null) {
            say(`its schedule "${cron}" is not a cron expression Genie can evaluate; not imported`);
            continue;
        }
        const kind = typeof meta.schedule_kind === 'string' && meta.schedule_kind.trim() !== '' ? meta.schedule_kind.trim() : 'command';
        let step: Record<string, unknown>;
        if (kind === 'command') {
            if (!command) {
                say('has no command; not imported');
                continue;
            }
            const folder = folderWithin(workspacePath, spec.cwd);
            if (folder === null) {
                say(`its folder ${spec.cwd || '(none)'} is outside its workspace ${workspacePath}; not imported`);
                continue;
            }
            step = { id: 's', kind: 'genie/terminal_run', position: { x: 240, y: 0 }, config: { workspace: spec.workspaceId, command, ...(folder ? { cwd: folder } : {}) } };
            if (spec.shell !== null && spec.shell.trim() !== '') say(`ran under the shell ${spec.shell} in Genie 1; Genie 2 runs it in its default shell`);
        } else if (kind === 'agent-nudge') {
            const prompt = typeof meta.nudge_prompt === 'string' ? meta.nudge_prompt.trim() : '';
            if (!prompt) {
                say('has no prompt to send; not imported');
                continue;
            }
            const targets = [meta.nudge_agent_id, meta.nudge_target_terminal_id].filter((k): k is string => typeof k === 'string' && k !== '');
            const who = v1.agents.find((a) => targets.some((k) => a.keys.includes(k)));
            if (!who) {
                say('Genie 1 no longer knows which agent it prompted (its agent or terminal was removed); not imported');
                continue;
            }
            const record = ctx.roster.find((r) => r.workspaceId === who.workspaceId && r.name === who.name);
            if (!record) {
                say(`its agent ${who.name} (workspace ${who.workspaceId}) is not in Genie 2; not imported`);
                continue;
            }
            step = { id: 's', kind: 'genie/agent_prompt', position: { x: 240, y: 0 }, config: { agent: `${record.workspaceId}:${record.provider}:${record.name}`, prompt } };
        } else if (kind === 'flow') {
            say(`ran a Genie 1 workflow${typeof meta.flow_id === 'string' ? ` (${meta.flow_id})` : ''}; Genie 1's workflows are not brought over — rebuild it in Flows; not imported`);
            continue;
        } else {
            say(`is a "${kind}" task, which Genie 2 does not know; not imported`);
            continue;
        }
        const armedInV1 = spec.enabled && meta.schedule_pending_approval !== true;
        if (armedInV1) say(`was firing on its schedule in Genie 1; it comes over PAUSED — Enable schedule in Hosting → Processes to keep it running`);
        flows.push({
            id: `${V1_FLOW_ID_PREFIX}${spec.id}`,
            v1SpecId: spec.id,
            workspaceId: spec.workspaceId,
            name,
            // The canonical shape (core/flow-form.ts): the engine reads the steps under `graph`.
            document: {
                $schema: FLOW_SCHEMA_URL,
                version: 1,
                graph: {
                    nodes: [{ id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron } }, step],
                    edges: [{ id: 'e1', source: 't', target: 's' }],
                },
            },
        });
    }
    return { flows, notes };
}

function parseMeta(text: string): Record<string, unknown> {
    try {
        const value: unknown = JSON.parse(text);
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}
