import { getTerminalSpec, listTerminalSpecs, updateTerminalSpec } from '../db';
import { agentInboxBroker } from '../agentinbox/broker';
import { mobileEmit } from '../mobile/server';
import { broadcastLocal } from '../remote';
import { describeCron, nextFireAfter } from './cron';
import {
    getProcessStatuses,
    recordProcessOutput,
    setScheduledRunEndHandler,
    startProcess,
} from './process-supervisor';

/**
 * Host-layer scheduler ("cron") for scheduled tasks — story #227.
 *
 * A scheduled task IS a Process: a `terminal_specs` row of type `'process'` that
 * additionally carries `meta.schedule` (a 5-field cron expression). It lives on
 * the HOST, so it fires whether or not a Client/UI is attached, and it survives
 * an app restart because {@link startSchedules} re-arms every approved task at
 * launch — right alongside `startAutostartProcesses`.
 *
 * The whole spawn path is the supervisor's: {@link startProcess} builds the args,
 * creates the pty, records output for the hover log and broadcasts status. This
 * module only decides WHEN. The supervisor, in turn, recognises a spec with a
 * schedule as ONE-SHOT — no crash auto-restart, no `was_running` restore — and
 * hands the exit back here through {@link setScheduledRunEndHandler}.
 *
 * NO POLLING. Each task arms exactly ONE `setTimeout` aimed at its next
 * occurrence and re-arms after the fire. (A delay beyond the platform's ~24.8-day
 * `setTimeout` ceiling is bridged by relay hops to the SAME target instant — a
 * timer limitation, not a poll: nothing is evaluated on the hop.)
 *
 * MISSED RUNS ARE NOT CAUGHT UP. If the Host was down at a fire time, the next
 * occurrence is computed forward from now. A backlog of "nightly backups" all
 * firing at once on launch is worse than a skipped night.
 */

/** Node clamps a longer `setTimeout` delay to 1ms, so long waits hop instead. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * How a `flow` fire runs its workflow.
 *
 * Injected, like {@link setScheduledRunEndHandler}, rather than imported: the
 * flow runner reaches the GApp bridge and the database, and this module is the
 * timer. Wiring it the other way would make the scheduler depend on the whole
 * apps subsystem to arm a cron expression. Null until `main` wires it, and a
 * fire with no handler is recorded as failed rather than silently dropped.
 */
type FlowFireHandler = (flowId: string) => Promise<boolean>;
let fireFlow: FlowFireHandler | null = null;

export function setFlowFireHandler(handler: FlowFireHandler | null): void {
    fireFlow = handler;
}

interface ScheduleState {
    timer: ReturnType<typeof setTimeout> | null;
    /** Epoch ms of the occurrence the timer is aimed at, or null when disarmed. */
    nextAt: number | null;
    /** True from the moment a run starts until its pty exits (overlap guard). */
    inFlight: boolean;
}

const schedules = new Map<string, ScheduleState>();

function state(specId: string): ScheduleState {
    let st = schedules.get(specId);
    if (!st) {
        st = { timer: null, nextAt: null, inFlight: false };
        schedules.set(specId, st);
    }
    return st;
}

function clearTimer(st: ScheduleState): void {
    if (st.timer) {
        clearTimeout(st.timer);
        st.timer = null;
    }
}

type SpecLike = NonNullable<ReturnType<typeof getTerminalSpec>>;

/** The cron expression of a scheduled task spec, or null if it isn't one. */
function scheduleOf(spec: SpecLike | null | undefined): string | null {
    if (!spec || spec.type !== 'process') return null;
    const expr = spec.meta?.schedule;
    return typeof expr === 'string' && expr.trim() !== '' ? expr.trim() : null;
}

/**
 * Armable = a scheduled task the user has actually sanctioned. A spec awaiting
 * approval exists (so it's visible in the Processes panel) but is disabled and
 * flagged `schedule_pending_approval`; it must NOT be armed until approved.
 */
function isArmable(spec: SpecLike | null | undefined): boolean {
    if (!scheduleOf(spec)) return false;
    if (spec!.enabled === false) return false;
    if (spec!.meta?.schedule_pending_approval === true) return false;
    return true;
}

/** Merge run-tracking fields onto the spec's meta. Best-effort — a failed write
 *  must never break the timer chain (the same rule the supervisor follows). */
function recordRun(specId: string, patch: Record<string, unknown>): void {
    try {
        const spec = getTerminalSpec(specId);
        if (!spec) return;
        updateTerminalSpec(specId, { meta: { ...spec.meta, ...patch } });
    } catch {
        /* best-effort — run tracking is a report, not the mechanism */
    }
}

/** Tell the renderer a task's schedule state moved (next run / last run). */
function broadcastSchedule(specId: string): void {
    const st = schedules.get(specId);
    const expr = scheduleOf(getTerminalSpec(specId));
    const payload = {
        id: specId,
        nextAt: st?.nextAt ?? null,
        description: expr ? describeCron(expr) : null,
    };
    // LOCAL-only, exactly like the supervisor's status broadcast: a host
    // window's list reflects the HOST's schedules, not this client's.
    broadcastLocal('schedule:next', payload);
    mobileEmit('schedule:next', payload);
}

let wired = false;

/** Register the supervisor's one-shot exit callback exactly once. Called from
 *  every entry point so a caller can't forget it and lose run tracking. */
function ensureWired(): void {
    if (wired) return;
    wired = true;
    setScheduledRunEndHandler((specId, exitCode) => {
        const st = schedules.get(specId);
        if (st) st.inFlight = false;
        recordRun(specId, { last_run_status: exitCode === 0 ? 'ok' : 'failed' });
        broadcastSchedule(specId);
    });
}

/** Epoch ms of the occurrence a task is armed for, or null when not armed. */
export function nextRunAt(specId: string): number | null {
    return schedules.get(specId)?.nextAt ?? null;
}

/** What a client needs to RENDER a scheduled task, computed on the Host. */
export interface ScheduleInfo {
    /** Epoch ms of the armed next occurrence; null when not armed. */
    nextAt: number | null;
    /** Human rendering of the expression, e.g. "Daily at 03:00". */
    description: string;
}

/**
 * Display info for EVERY scheduled task in the DB (id → info), armed or not.
 *
 * The cron parser lives on the Host and stays there: the renderer never decides
 * when anything fires, and it must not carry a second copy of the evaluator that
 * could drift from the one that actually runs. So the Host hands over the
 * already-formatted description alongside the armed instant, and the client just
 * paints it. A disabled or invalid task still appears here (with `nextAt: null`)
 * so the panel can show WHY it isn't running.
 */
export function getScheduleInfo(): Record<string, ScheduleInfo> {
    const out: Record<string, ScheduleInfo> = {};
    for (const spec of listTerminalSpecs()) {
        const expr = scheduleOf(spec);
        if (!expr) continue;
        out[spec.id] = {
            nextAt: schedules.get(spec.id)?.nextAt ?? null,
            description: describeCron(expr),
        };
    }
    return out;
}

/**
 * Arm (or re-arm) a scheduled task for its NEXT occurrence after now. Idempotent:
 * an existing timer is cleared first, so a spec edit can just call this again
 * without stacking timers. A spec that isn't an armable scheduled task is
 * silently disarmed instead — that's how "the user removed the schedule" and
 * "the user disabled the task" both land here.
 */
export function armSchedule(specId: string): void {
    ensureWired();
    const spec = getTerminalSpec(specId);
    if (!isArmable(spec)) {
        // Nothing to arm. Only touch state (and push) if this spec ACTUALLY had
        // a timer — the spec-update IPC calls this for EVERY edit, including
        // ordinary terminals and code views, and allocating an entry per edited
        // spec would grow this map for the life of the process.
        const existing = schedules.get(specId);
        if (existing) {
            clearTimer(existing);
            existing.nextAt = null;
            broadcastSchedule(specId);
        }
        return;
    }
    const st = state(specId);
    clearTimer(st);
    st.nextAt = null;
    const expr = scheduleOf(spec)!;
    // FORWARD FROM NOW — never from `last_run_at`. This is what makes a missed
    // run a skipped run instead of a catch-up stampede on launch.
    const next = nextFireAfter(expr, new Date());
    if (!next) {
        // Invalid, or an expression that can never occur (`0 0 30 2 *`). Leave it
        // disarmed rather than guessing; the UI shows "—" for the next run.
        broadcastSchedule(specId);
        return;
    }
    st.nextAt = next.getTime();
    armTimer(specId, st);
    broadcastSchedule(specId);
}

/** Point the single timer at `st.nextAt`, hopping if it's beyond the ceiling. */
function armTimer(specId: string, st: ScheduleState): void {
    if (st.nextAt === null) return;
    const delay = Math.max(0, st.nextAt - Date.now());
    if (delay > MAX_TIMEOUT_MS) {
        st.timer = setTimeout(() => {
            st.timer = null;
            armTimer(specId, st); // same target instant, one hop closer
        }, MAX_TIMEOUT_MS);
    } else {
        st.timer = setTimeout(() => {
            st.timer = null;
            fire(specId);
        }, delay);
    }
    st.timer.unref?.();
}

/** Cancel a task's pending fire (spec deleted/disabled/edited, or app teardown). */
export function disarmSchedule(specId: string): void {
    const st = schedules.get(specId);
    if (!st) return;
    clearTimer(st);
    st.nextAt = null;
    broadcastSchedule(specId);
}

/** Drop all scheduler state for a removed spec. */
export function forgetSchedule(specId: string): void {
    const st = schedules.get(specId);
    if (st) clearTimer(st);
    schedules.delete(specId);
}

/**
 * The timer fired: run this occurrence, then arm the following one. Re-arming
 * happens even when the run was skipped or failed — a task stays on schedule
 * until the user disables it.
 */
function fire(specId: string): void {
    run(specId, 'schedule');
    armSchedule(specId);
}

/**
 * Run a scheduled task NOW (the run-now button, or a timer fire). Honours the
 * overlap guard: a task whose previous run is still in flight records `skipped`
 * rather than starting a second copy.
 */
export function runScheduleNow(specId: string): void {
    ensureWired();
    run(specId, 'manual');
    broadcastSchedule(specId);
}

function run(specId: string, trigger: 'schedule' | 'manual'): void {
    const spec = getTerminalSpec(specId);
    if (!spec || !scheduleOf(spec)) return;
    const st = state(specId);
    const at = Date.now();

    // OVERLAP: never two copies of the same task. `inFlight` covers a command run
    // between spawn and pty exit; the supervisor's status is the belt-and-braces
    // check for a run this module didn't start (e.g. a manual Start).
    const liveStatus = getProcessStatuses()[specId];
    if (st.inFlight || liveStatus === 'running' || liveStatus === 'restarting') {
        recordRun(specId, { last_run_at: at, last_run_status: 'skipped' });
        recordProcessOutput(
            specId,
            `\n[genie] ${new Date(at).toLocaleTimeString()} — scheduled run SKIPPED (the previous run is still going).\n`,
        );
        return;
    }

    if (spec.meta?.schedule_kind === 'agent-nudge') {
        const ok = deliverNudge(spec);
        recordRun(specId, { last_run_at: at, last_run_status: ok ? 'ok' : 'failed' });
        return;
    }

    if (spec.meta?.schedule_kind === 'flow') {
        // A scheduled workflow fires HERE rather than through a second cron of
        // its own, which is what makes a flow's schedule survive quit and update
        // and fire with nobody watching — the owner's rule that ops must not
        // depend on an agent being asked.
        //
        // `inFlight` is held across the run so the overlap guard above covers a
        // long flow the same way it covers a long command: a nightly job still
        // going at the next occurrence SKIPS rather than doubling up.
        const flowId = typeof spec.meta.flow_id === 'string' ? spec.meta.flow_id : '';
        if (!flowId || !fireFlow) {
            recordRun(specId, { last_run_at: at, last_run_status: 'failed' });
            return;
        }
        st.inFlight = true;
        recordRun(specId, { last_run_at: at, last_run_status: undefined });
        void fireFlow(flowId)
            .then((ok) => {
                recordRun(specId, { last_run_at: at, last_run_status: ok ? 'ok' : 'failed' });
            })
            .catch(() => {
                recordRun(specId, { last_run_at: at, last_run_status: 'failed' });
            })
            .finally(() => {
                st.inFlight = false;
            });
        return;
    }

    // kind 'command' (the default): the supervisor owns the spawn, so a scheduled
    // run is byte-for-byte the same launch a manual Start produces — same shell
    // resolution, same cwd, same hover log, same status broadcast.
    if (!spec.meta?.command) {
        recordRun(specId, { last_run_at: at, last_run_status: 'failed' });
        return;
    }
    st.inFlight = true;
    recordRun(specId, { last_run_at: at, last_run_status: undefined });
    recordProcessOutput(
        specId,
        `\n[genie] ${new Date(at).toLocaleString()} — scheduled run (${trigger})\n`,
    );
    try {
        startProcess(specId);
    } catch (e) {
        st.inFlight = false;
        recordProcessOutput(
            specId,
            `[genie] scheduled run failed to start: ${e instanceof Error ? e.message : String(e)}\n`,
        );
        recordRun(specId, { last_run_at: at, last_run_status: 'failed' });
    }
}

/**
 * `agent-nudge` fire: hand the prompt to an agent through AgentInbox. Reuses
 * {@link agentInboxBroker.deliverHumanMessageToTerminal}, which appends the text
 * to the agent's durable inbox AND wakes the terminal through the same fail-safe
 * idle gate as wake-on-DM (main/agentinbox/wake.ts) — so a nudge can never be
 * injected into a live turn; a busy agent simply reads it at its next pull.
 * Returns false when there's nothing to deliver to (no prompt, no resolvable
 * terminal, or the terminal has no registered agent identity).
 */
function deliverNudge(spec: SpecLike): boolean {
    const prompt = typeof spec.meta?.nudge_prompt === 'string' ? spec.meta.nudge_prompt.trim() : '';
    if (!prompt) return false;
    let terminalId = spec.meta?.nudge_target_terminal_id ?? null;
    if (!terminalId && spec.meta?.nudge_agent_id) {
        terminalId = agentInboxBroker.getInfo(spec.meta.nudge_agent_id)?.terminalId ?? null;
    }
    if (!terminalId) return false;
    try {
        return agentInboxBroker.deliverHumanMessageToTerminal(terminalId, prompt);
    } catch {
        return false;
    }
}

/**
 * Arm every approved scheduled task. Called on launch beside
 * `startAutostartProcesses()` — this is what makes a schedule survive quit,
 * crash and auto-update: the timers are gone, but the specs (and therefore the
 * schedules) are in the DB, so they're simply re-armed forward from now.
 */
export function startSchedules(): void {
    ensureWired();
    for (const spec of listTerminalSpecs()) {
        if (isArmable(spec)) armSchedule(spec.id);
    }
}

/** Cancel every armed timer (app teardown). */
export function stopSchedules(): void {
    for (const st of schedules.values()) clearTimer(st);
}
