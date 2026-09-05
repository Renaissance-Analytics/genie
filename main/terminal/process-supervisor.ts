import path from 'node:path';
import {
    terminalManager,
    resolveDefaultShell,
} from '@particle-academy/fancy-term-host';
import {
    getTerminalSpec,
    listTerminalSpecs,
    updateTerminalSpec,
} from '../db';
import { dbSettingsProvider } from './genie-adapter';
import { buildProcessArgs } from './process-spawn';
import { decideOnExit, type ProcessStatus } from './process-lifecycle';
import { mobileEmit } from '../mobile/server';
import { broadcastLocal } from '../remote';

/**
 * Headless supervisor for Process service runners.
 *
 * Processes (`terminal_specs` of type 'process') run as background services in
 * the pty backend with NO renderer attachment — they don't surface in the main
 * grid. This module owns their lifecycle (start/stop/restart), tracks status
 * (running/stopped/crashed/restarting/failed), auto-restarts crashes with
 * backoff, and broadcasts status to the renderer so the workspace-row indicator
 * + the inline process manager stay live.
 *
 * Status is the source of truth here; the renderer is a view. An intentional
 * restart kills the pty (which reuses the spec id) and respawns ONLY after the
 * old pty's exit lands (`restartRequested`), so the id is never double-owned.
 */

interface ProcState {
    status: ProcessStatus;
    attempt: number;
    /** True while a deliberate stop/restart kill is in flight. */
    userStopped: boolean;
    /** True when the kill is part of a restart — respawn on the exit event. */
    restartRequested: boolean;
    restartTimer: ReturnType<typeof setTimeout> | null;
}

const procs = new Map<string, ProcState>();

/**
 * A process spec carrying `meta.schedule` is a SCHEDULED TASK, not a service:
 * process-scheduler.ts decides when it runs, so each run is ONE-SHOT. The
 * supervisor still owns the spawn, the output log and the status broadcast
 * (that's the whole point of reusing it) but must not apply the service
 * behaviours — no crash auto-restart, no `was_running` restore.
 */
function isScheduled(spec: { meta?: { schedule?: string } } | null | undefined): boolean {
    return typeof spec?.meta?.schedule === 'string' && spec.meta.schedule.trim() !== '';
}

/**
 * Called when a SCHEDULED task's pty exits, with the exit code. Registered by
 * process-scheduler.ts (which imports this module, never the other way round) so
 * it can clear the in-flight guard and record `last_run_status`.
 */
let scheduledRunEnd: ((specId: string, exitCode: number) => void) | null = null;

export function setScheduledRunEndHandler(
    fn: (specId: string, exitCode: number) => void,
): void {
    scheduledRunEnd = fn;
}

/** Recent stdout/stderr per process, for the hover log popover. Capped so a
 *  chatty process can't grow this unbounded; we only keep the tail. */
const procLogs = new Map<string, string>();
const PROC_LOG_CAP = 256_000; // chars of tail kept per process (hover + download)

/**
 * Strip terminal control sequences so the log popover shows clean text. The pty
 * stream carries more than CSI color codes — Git Bash emits an OSC title
 * sequence (`ESC ]0;...BEL`) on every prompt, which previously leaked as
 * `]0;C:\Program Files\Git\bin\bash.exe` garbage. Order matters: OSC first
 * (it contains `]`), then CSI, then any stray ESC/control bytes (keep \n \t).
 */
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function stripControl(s: string): string {
    return s
        .replace(OSC_RE, '')
        .replace(CSI_RE, '')
        .replace(CTRL_RE, '');
}

/**
 * Record pty output for a managed process (no-op for non-process ids). Wired
 * from the single subscribeBackendEvents onData in ipc.ts. Keeps only the tail.
 */
export function recordProcessOutput(id: string, data: string): void {
    if (!procs.has(id)) return;
    const next = (procLogs.get(id) ?? '') + data;
    procLogs.set(id, next.length > PROC_LOG_CAP ? next.slice(-PROC_LOG_CAP) : next);
}

/** The recent output tail for a process (control sequences stripped), or ''. */
export function getProcessLog(id: string): string {
    return stripControl(procLogs.get(id) ?? '');
}

/** Drop a process's recorded output tail (the "Clear log" action). The buffer
 *  refills from new pty output as the process keeps running. */
export function clearProcessLog(id: string): void {
    procLogs.delete(id);
}

function ensure(id: string): ProcState {
    let st = procs.get(id);
    if (!st) {
        st = {
            status: 'stopped',
            attempt: 0,
            userStopped: false,
            restartRequested: false,
            restartTimer: null,
        };
        procs.set(id, st);
    }
    return st;
}

function clearTimer(st: ProcState): void {
    if (st.restartTimer) {
        clearTimeout(st.restartTimer);
        st.restartTimer = null;
    }
}

/** Per-process status-change listeners — the seam {@link settleProcess} waits on,
 *  so nothing has to poll for a spawn's outcome. */
const statusWatchers = new Map<string, Set<(s: ProcessStatus) => void>>();

/**
 * How long a just-spawned process must stay up before Genie will call it
 * started.
 *
 * `create()` returning is not evidence the command runs: a `command not found`
 * shell starts, prints, and exits milliseconds later, and the old code set
 * `running` on the next line. This window is what turns "the spawn call
 * returned" into "it was still alive N ms later" — a claim that can be made
 * honestly. Overridable by tests only; nothing in the product passes it.
 */
export const PROCESS_SETTLE_MS = 1_200;

/**
 * Watch a process until its status leaves `running`, or `settleMs` passes —
 * whichever comes first. Event-driven (no polling): the exit hook's `setStatus`
 * is what resolves it early.
 *
 * The returned status is what was OBSERVED, not what was intended. Used from
 * both ends of a process's life, and it means something slightly different at
 * each: after a START, a long-lived service never "finishes" starting, so a
 * still-`running` result means exactly "alive `settleMs` after the spawn"; after
 * a STOP, a `stopped` result means the pty's exit actually landed, and anything
 * else means it did not.
 */
export function settleProcess(
    specId: string,
    settleMs: number = PROCESS_SETTLE_MS,
): Promise<ProcessStatus> {
    return new Promise((resolve) => {
        const st = procs.get(specId);
        // Already settled into a terminal state before we got here.
        if (!st || (st.status !== 'running' && st.status !== 'restarting')) {
            resolve(st?.status ?? 'stopped');
            return;
        }
        const set = statusWatchers.get(specId) ?? new Set();
        statusWatchers.set(specId, set);
        const done = (s: ProcessStatus): void => {
            set.delete(watcher);
            clearTimeout(timer);
            resolve(s);
        };
        // Resolve early only on a status that ENDS the question. 'restarting'
        // does not: it is both "crashed, backing off" and "the kill for a
        // deliberate restart is in flight", so it waits out the window and is
        // reported as unsettled if it is still that at the deadline.
        const watcher = (s: ProcessStatus): void => {
            if (s === 'crashed' || s === 'failed' || s === 'stopped') done(s);
        };
        const timer = setTimeout(() => done(procs.get(specId)?.status ?? 'stopped'), settleMs);
        if (typeof timer.unref === 'function') timer.unref();
        set.add(watcher);
    });
}

function setStatus(id: string, status: ProcessStatus): void {
    ensure(id).status = status;
    for (const w of [...(statusWatchers.get(id) ?? [])]) w(status);
    // LOCAL-only — a host window's process list reflects the HOST (via its
    // /ws/events); a local process status must not leak in there.
    broadcastLocal('process:status', { id, status });
    // Mirror to the mobile dashboard push channel (no-op when the server is off).
    mobileEmit('process:status', { id, status });
}

/**
 * Persist a process's "was running" intent on its spec meta, so a process
 * active when Genie went down (quit/update/crash) is auto-restored next launch.
 * Only writes when the value actually changes (avoids DB churn on every status
 * transition) and is best-effort (a failed write must not break the
 * supervisor). Set true while running; false on a deliberate stop or a terminal
 * 'failed', so those don't boot-loop.
 */
function persistWasRunning(id: string, value: boolean): void {
    persistIntent(id, 'was_running', value);
}

/**
 * Persist the user's PAUSE — that they deliberately stopped this process and
 * have not started it since (genie#407).
 *
 * `was_running` could not carry this. It is the answer to "was it up when Genie
 * went down", so it is also false for a process that has never been started and
 * for one whose retries were exhausted — neither of which is the user asking for
 * anything. Boot needs to tell those apart, because a process it may restore and
 * a process it must not restart are different processes.
 *
 * The reported bug is what the absence cost: `startAutostartProcesses()` started
 * a spec when `autostart === true` OR `was_running === true`, and `autostart` is
 * CONFIGURATION — "this is a service, run it on every launch". So a paused
 * service came straight back, and an upgrade (a launch nobody chose) is where
 * that was most visible. This is the fact that outranks it.
 */
function persistUserStopped(id: string, value: boolean): void {
    persistIntent(id, 'user_stopped', value);
}

/**
 * Write one boolean intent onto a process spec's meta. Only when it actually
 * changes (no DB churn on every status transition), never for a SCHEDULED task
 * (its schedule decides when it runs, so neither flag applies), and never
 * fatally — a persistence failure must not break the supervisor.
 */
function persistIntent(id: string, key: 'was_running' | 'user_stopped', value: boolean): void {
    try {
        const spec = getTerminalSpec(id);
        if (!spec || spec.type !== 'process') return;
        // A scheduled task must never be restored as a service on next launch —
        // its schedule is re-armed instead (startSchedules), which is what
        // "survives restart" means for it.
        if (isScheduled(spec)) return;
        if ((spec.meta?.[key] ?? false) === value) return; // no change
        updateTerminalSpec(id, { meta: { ...spec.meta, [key]: value } });
    } catch {
        /* best-effort — persistence failure shouldn't break the supervisor */
    }
}

/**
 * Is a pty actually running for this process RIGHT NOW?
 *
 * The PTY BACKEND is asked, not the supervisor's own status map, and the
 * difference matters at exactly the moment this is used. On a launch that
 * reattached to a surviving detached host the map is empty — it belongs to a
 * process image that no longer exists — while the ptys are very much alive, so
 * a map-based answer would spawn a duplicate over every one of them. A restart
 * in flight has no pty either way, and is covered by `startProcess`'s own
 * `restarting` guard.
 *
 * Defensive: a backend that cannot be asked reports NOT live, so boot still
 * starts things. The cost of being wrong here is a redundant restart; the cost
 * of the opposite default is a service that never comes back.
 */
function isProcessLive(specId: string): boolean {
    try {
        return terminalManager().isLive(specId) === true;
    } catch {
        return false;
    }
}

/** Current status of every managed process (id → status). */
export function getProcessStatuses(): Record<string, ProcessStatus> {
    const out: Record<string, ProcessStatus> = {};
    for (const [id, st] of procs) out[id] = st.status;
    return out;
}

/** Spawn the process's command headless. Assumes no live pty for this id. */
export function startProcess(specId: string): void {
    const spec = getTerminalSpec(specId);
    if (!spec || spec.type !== 'process' || !spec.meta?.command) return;
    const st = ensure(specId);
    if (st.status === 'running' || st.status === 'restarting') {
        // Already live — treat a redundant start as a restart instead.
        restartProcess(specId);
        return;
    }
    clearTimer(st);
    st.userStopped = false;
    st.restartRequested = false;
    // The persisted twin of the line above (genie#407): an explicit start LIFTS
    // the pause. Written here rather than after a successful spawn, because the
    // fact being recorded is the ASK — a user who presses Start on a process
    // whose command is broken has still un-paused it, and leaving it paused
    // would mean the next launch silently disagreed with the last thing they did.
    persistUserStopped(specId, false);

    const resolved = resolveDefaultShell(dbSettingsProvider());
    const shell = spec.shell || resolved.command;
    const args = buildProcessArgs(shell, spec.meta.command);
    // A service runs at its CONFIGURED cwd every time — never a tracked live_cwd
    // (processes don't meaningfully track cwd, and a stale one is the "doesn't
    // open in the correct location" bug). Normalize for the platform.
    const cwd = path.normalize(spec.cwd);

    // Make the launch context visible in the hover log as CONTEXT, not as
    // commands — location first, then the human command (not the full
    // `bash -lic …` argv) with the shell it runs under in parens. Reads as
    // "launching in <dir>" then "$ <command> (via <shell>)", so a
    // "command not found" / wrong-dir issue is obvious without looking like
    // two out-of-order commands.
    recordProcessOutput(
        specId,
        `\n[genie] launching in ${cwd}\n[genie] $ ${spec.meta.command}  (via ${path.basename(shell)})\n\n`,
    );

    try {
        terminalManager().create({ id: specId, cwd, shell, args });
        // `create()` returning is NOT evidence the command runs — a `command not
        // found` shell exits milliseconds later. The check that IS decidable
        // here is whether a pty registered at all; the rest is the caller's
        // (see {@link settleProcess}, which watches it survive a window).
        if (!terminalManager().isLive(specId)) {
            recordProcessOutput(specId, '[genie] spawn produced no live process\n');
            setStatus(specId, 'crashed');
            return;
        }
        setStatus(specId, 'running');
        // Record the running intent so this process is restored on next launch
        // if Genie goes down (quit/update/crash) while it's up.
        persistWasRunning(specId, true);
    } catch (e) {
        recordProcessOutput(
            specId,
            `[genie] spawn failed: ${e instanceof Error ? e.message : String(e)}\n`,
        );
        setStatus(specId, 'crashed');
    }
}

/** What a {@link stopProcess} call actually established. */
export interface StopResult {
    /** True only when the process is KNOWN to be down — see stopProcess. */
    confirmed: boolean;
    /** Always set: what was established, in the caller's words. */
    note: string;
    /** Set when `confirmed` is false — what would settle it. */
    reason?: string;
}

/**
 * Stop a process (deliberate — never auto-restarts over this), and report what
 * that established rather than assuming it worked.
 *
 * This used to end `try { terminalManager().kill(specId); } catch {}` followed
 * by an unconditional `setStatus(specId, 'stopped')`. `kill(id): boolean`
 * RETURNS FALSE for a missing pty — it does not throw — so that `catch` could
 * never fire, the boolean went nowhere, and `'stopped'` was written whatever
 * happened. Same discovery that fixed `restartProcess` in #368; `stopProcess`
 * was simply not in that PR's scope.
 *
 * A `true` is not much better taken alone. Both backends delete their record and
 * return `true` the moment a kill is REQUESTED, and the host client's `kill()`
 * is `this.send({kind:'kill', id})` over a socket to a detached process — so
 * `true` means "a kill was accepted", never "the process is gone". It also makes
 * `isLive()` false immediately after ANY kill, which is why the confirmation
 * here is not built on it: that check would pass for every stop and prove
 * nothing. The pty's EXIT EVENT is the one thing that reports a real exit, and
 * it is already what turns a process `'stopped'` (see onProcessPtyExit) — so
 * this waits for that, bounded, and reports what it saw.
 *
 * The two honest outcomes:
 *
 *   • `kill()` returned FALSE → the backend has no pty for this id, so there is
 *     nothing running under Genie's supervision and no exit event is coming.
 *     `stopped` is established by that ABSENCE, not by a kill. (What it does not
 *     establish is anything about a process the backend has already forgotten —
 *     that is bookkeeping, and it is the same thing `restartProcess` relies on.)
 *   • `kill()` returned TRUE → wait for the exit. Landed: stopped, verified.
 *     Did not land inside the window: say so, and leave the status alone rather
 *     than write a `stopped` nothing observed.
 */
export async function stopProcess(
    specId: string,
    confirmMs: number = PROCESS_SETTLE_MS,
): Promise<StopResult> {
    const st = ensure(specId);
    clearTimer(st);
    st.userStopped = true;
    st.restartRequested = false;
    st.attempt = 0;

    let killed = false;
    try {
        killed = terminalManager().kill(specId);
    } catch {
        killed = false;
    }

    // A deliberate stop clears the running intent so it does NOT auto-restore,
    // and RECORDS the pause so nothing else restores it either (genie#407) —
    // `autostart` most of all, which is configuration and used to win. Both are
    // written independent of the outcome: the user asked for it down either way,
    // and a kill Genie could not confirm is not the user changing their mind.
    persistWasRunning(specId, false);
    persistUserStopped(specId, true);

    if (!killed) {
        setStatus(specId, 'stopped');
        return { confirmed: true, note: 'There was no live process to stop — it was already down.' };
    }

    const settled = await settleProcess(specId, confirmMs);
    if (settled === 'stopped') {
        return { confirmed: true, note: "The process's pty exited — Genie saw it go." };
    }
    return {
        confirmed: false,
        note: 'The kill was accepted by the pty backend.',
        reason:
            `The kill was accepted, but no exit for this process had landed ${confirmMs}ms later, ` +
            `so it is NOT confirmed stopped — its status is left as \`${settled}\` rather than a ` +
            '`stopped` nothing observed. Poll `manageProcess {action:\'list\'}` until it reads ' +
            '`stopped`; if it does not, the process is still up and `stop` can be retried.',
    };
}

/** Restart a process: kill then respawn once the old pty's exit lands. */
export function restartProcess(specId: string): void {
    const st = ensure(specId);
    clearTimer(st);
    st.attempt = 0;
    if (st.status === 'running' || st.status === 'restarting') {
        st.userStopped = true;
        st.restartRequested = true;
        // The honest intermediate: the kill is out, the respawn has not
        // happened. Set BEFORE the kill, because a backend that reports the
        // exit synchronously would otherwise have its 'running' clobbered.
        setStatus(specId, 'restarting');
        // `kill()` RETURNS FALSE for a missing pty — it does not throw. So this
        // recovery used to hang off a `catch` that could never fire: a restart
        // against a stale `running` killed nothing, waited for an exit event
        // that was never coming, respawned nothing, and reported success.
        let killed = false;
        try {
            killed = terminalManager().kill(specId);
        } catch {
            killed = false;
        }
        if (!killed) {
            // No pty actually died → the exit event won't come; start now.
            // 'stopped' first, or startProcess's own guard bounces this
            // straight back into restartProcess (see onProcessPtyExit).
            st.restartRequested = false;
            st.userStopped = false;
            st.status = 'stopped';
            startProcess(specId);
        }
    } else {
        startProcess(specId);
    }
}

/**
 * Backend exit hook — wired from the single subscribeBackendEvents in ipc.ts so
 * it follows the active backend. No-ops for ids we don't manage.
 */
export function onProcessPtyExit(
    id: string,
    payload: { exitCode: number; signal?: number },
): void {
    const st = procs.get(id);
    if (!st) return;
    if (st.restartRequested) {
        st.restartRequested = false;
        st.userStopped = false;
        // The old pty just died, but the status is still 'running' from before
        // the restart kill. startProcess()'s guard bounces 'running'/'restarting'
        // straight back into restartProcess() — which (the pty already dead)
        // throws, catches, and re-enters startProcess on a still-'running'
        // status, looping without ever spawning. Clear to 'stopped' so the
        // guard passes and a fresh pty actually launches. ('restarting' would
        // also be caught by the guard, so it must be 'stopped'.)
        st.status = 'stopped';
        startProcess(id);
        return;
    }
    const spec = getTerminalSpec(id);
    if (isScheduled(spec)) {
        // ONE-SHOT: the run is over, full stop. No decideOnExit, so no backoff
        // restart — a nightly job that exits non-zero must wait for its next
        // occurrence, not hot-loop until then. The scheduler records the outcome.
        st.attempt = 0;
        st.userStopped = false;
        setStatus(id, 'stopped');
        scheduledRunEnd?.(id, payload.exitCode ?? 0);
        return;
    }
    const restartOnExit = spec?.meta?.restart_on_exit !== false;
    const d = decideOnExit({
        userStopped: st.userStopped,
        restartOnExit,
        exitCode: payload.exitCode ?? 0,
        attempt: st.attempt,
    });
    st.attempt = d.nextAttempt;
    st.userStopped = false;
    setStatus(id, d.status);
    // A permanently-broken process (retries exhausted) clears its running
    // intent so it doesn't boot-loop on the next launch. A 'restarting' exit
    // keeps the intent (it's coming back); 'crashed'/'stopped' from a non-
    // deliberate clean exit also keep it so a recoverable process still
    // restores, matching "if it was active, bring it back".
    if (d.status === 'failed') persistWasRunning(id, false);
    if (d.restartInMs !== null) {
        st.restartTimer = setTimeout(() => {
            st.restartTimer = null;
            startProcess(id);
        }, d.restartInMs);
    }
}

/**
 * Start every process that should be live on app launch: those the user marked
 * `autostart`, AND those that were RUNNING when Genie last went down
 * (`was_running` — restored like a service). startProcess() no-ops if the pty
 * is already live (e.g. a detached host kept it alive and Genie reattached), so
 * this only spawns the ones that actually died. A permanently-failed process has
 * `was_running === false`, so it stays down.
 *
 * And a process the user PAUSED stays down whatever its configuration says
 * (genie#407). That guard is separate from `was_running` on purpose: the OR
 * below is a union of reasons to start, so a stop expressed only by clearing one
 * of them is outvoted by the other. `autostart` is exactly that other — set by
 * every GApp service and by any agent calling `manageProcess {autostart:true}` —
 * and it used to restart, on every launch, a process the user had just stopped.
 * The user's own decision does not get outvoted by config.
 */
export function startAutostartProcesses(): void {
    for (const spec of listTerminalSpecs()) {
        if (
            spec.type === 'process' &&
            spec.enabled !== false &&
            // Already up — leave it EXACTLY as it is. `startProcess` treats a
            // redundant start as a RESTART, so this pass used to kill and
            // respawn everything a surviving pty-host had kept alive, despite
            // the paragraph above saying it no-ops. Latent until genie#389's
            // drain restore began starting processes before this ran: the
            // restore brings them back three seconds apart and this then
            // restarted every one of them in a single tick, which is the
            // thundering herd the stagger exists to prevent.
            !isProcessLive(spec.id) &&
            // Genie may restore what IT stopped; it may never restart what the
            // USER stopped. Only an explicit start lifts this.
            spec.meta?.user_stopped !== true &&
            // Scheduled tasks are startSchedules()' business — starting one here
            // would run it at launch instead of at its scheduled time.
            !isScheduled(spec) &&
            (spec.meta?.autostart === true || spec.meta?.was_running === true) &&
            spec.meta?.command
        ) {
            startProcess(spec.id);
        }
    }
}

/** Forget a deleted process (called when its spec is removed). */
export function forgetProcess(specId: string): void {
    const st = procs.get(specId);
    if (st) clearTimer(st);
    procs.delete(specId);
    procLogs.delete(specId);
}
