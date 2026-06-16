import { BrowserWindow } from 'electron';
import {
    terminalManager,
    resolveDefaultShell,
} from '@particle-academy/fancy-term-host';
import { getAllSettings, getTerminalSpec, listTerminalSpecs } from '../db';
import { dbSettingsProvider } from './genie-adapter';
import { buildProcessArgs } from './process-spawn';
import { buildTynnCliEnv } from '../cli/tynn-cli';
import { decideOnExit, type ProcessStatus } from './process-lifecycle';

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
const PROC_LOG_CAP = 8000; // chars of tail kept per process
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Record pty output for a managed process (no-op for non-process ids). Wired
 * from the single subscribeBackendEvents onData in ipc.ts. Keeps only the tail.
 */
export function recordProcessOutput(id: string, data: string): void {
    if (!procs.has(id)) return;
    const next = (procLogs.get(id) ?? '') + data;
    procLogs.set(id, next.length > PROC_LOG_CAP ? next.slice(-PROC_LOG_CAP) : next);
}

/** The recent output tail for a process (ANSI stripped), or '' if none. */
export function getProcessLog(id: string): string {
    return (procLogs.get(id) ?? '').replace(ANSI_RE, '');
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
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.webContents.isDestroyed()) {
            w.webContents.send('process:status', { id, status });
        }
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
    const env = buildTynnCliEnv(spec.cwd, cliEnabled);

    try {
        terminalManager().create({
            id: specId,
            cwd: spec.live_cwd ?? spec.cwd,
            shell,
            args,
            env,
        });
        setStatus(specId, 'running');
    } catch {
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
    if (d.restartInMs !== null) {
        st.restartTimer = setTimeout(() => {
            st.restartTimer = null;
            startProcess(id);
        }, d.restartInMs);
    }
}

/** Start every autostart-enabled process across all workspaces (app launch). */
export function startAutostartProcesses(): void {
    for (const spec of listTerminalSpecs()) {
        if (
            spec.type === 'process' &&
            spec.enabled !== false &&
            spec.meta?.autostart === true &&
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
