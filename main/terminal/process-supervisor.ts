import path from 'node:path';
import {
    terminalManager,
    resolveDefaultShell,
} from '@particle-academy/fancy-term-host';
import {
    getAllSettings,
    getTerminalSpec,
    listTerminalSpecs,
    updateTerminalSpec,
} from '../db';
import { dbSettingsProvider } from './genie-adapter';
import { buildProcessArgs } from './process-spawn';
import { buildTynnCliEnv } from '../cli/tynn-cli';
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

function setStatus(id: string, status: ProcessStatus): void {
    ensure(id).status = status;
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
    try {
        const spec = getTerminalSpec(id);
        if (!spec || spec.type !== 'process') return;
        if ((spec.meta?.was_running ?? false) === value) return; // no change
        updateTerminalSpec(id, { meta: { ...spec.meta, was_running: value } });
    } catch {
        /* best-effort — persistence failure shouldn't break the supervisor */
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

    const resolved = resolveDefaultShell(dbSettingsProvider());
    const shell = spec.shell || resolved.command;
    const args = buildProcessArgs(shell, spec.meta.command);
    const cliEnabled = getAllSettings().cli_tools_in_terminals !== 'off';
    // A service runs at its CONFIGURED cwd every time — never a tracked live_cwd
    // (processes don't meaningfully track cwd, and a stale one is the "doesn't
    // open in the correct location" bug). Normalize for the platform.
    const cwd = path.normalize(spec.cwd);
    const env = buildTynnCliEnv(cwd, cliEnabled);

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
        terminalManager().create({ id: specId, cwd, shell, args, env });
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

/** Stop a process (deliberate — never auto-restarts over this). */
export function stopProcess(specId: string): void {
    const st = ensure(specId);
    clearTimer(st);
    st.userStopped = true;
    st.restartRequested = false;
    st.attempt = 0;
    try {
        terminalManager().kill(specId);
    } catch {
        /* no live pty — fine */
    }
    setStatus(specId, 'stopped');
    // A deliberate stop clears the running intent so it does NOT auto-restore.
    persistWasRunning(specId, false);
}

/** Restart a process: kill then respawn once the old pty's exit lands. */
export function restartProcess(specId: string): void {
    const st = ensure(specId);
    clearTimer(st);
    st.attempt = 0;
    if (st.status === 'running' || st.status === 'restarting') {
        st.userStopped = true;
        st.restartRequested = true;
        try {
            terminalManager().kill(specId);
        } catch {
            // No pty actually died → the exit event won't come; start now.
            st.restartRequested = false;
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
 * this only spawns the ones that actually died. A deliberately-stopped or
 * permanently-failed process has `was_running === false`, so it stays down.
 */
export function startAutostartProcesses(): void {
    for (const spec of listTerminalSpecs()) {
        if (
            spec.type === 'process' &&
            spec.enabled !== false &&
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
