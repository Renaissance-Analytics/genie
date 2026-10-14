import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { doctorHoldFile, doctorHoldFrom, genieRunningFile, genieRunningFrom, type DoctorHold, type GenieRunning } from '../core/genie-running.js';

const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** When this Genie started — kept across the rewrites as the set of started agents changes. */
let startedAt: string | undefined;

/**
 * Normal Genie: "I am running", and which agents it has started (core/genie-running.ts) — written at boot and again
 * whenever that set changes, so doctor can tell which workspaces are free. A failed write is reported, never fatal.
 */
export function markGenieRunning(genieHome: string, agents: readonly string[] = []): void {
    const file = genieRunningFile(genieHome);
    try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: startedAt ??= new Date().toISOString(), agents: [...agents] }), 'utf8');
    } catch (error) {
        console.error(`[genie] could not write ${file}: ${(error as Error).message}`);
    }
}

/** Normal Genie, at quit: removed only if it is still ours. */
export function clearGenieRunning(genieHome: string): void {
    const file = genieRunningFile(genieHome);
    try {
        if ((JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }).pid === process.pid) rmSync(file, { force: true });
    } catch { /* nothing to remove */ }
}

/** Doctor mode: is normal Genie running now, and what has it started? `process.kill(pid, 0)` asks the OS whether the pid is alive. */
export function genieRunningNow(genieHome: string): GenieRunning {
    let raw: string | null = null;
    try { raw = readFileSync(genieRunningFile(genieHome), 'utf8'); } catch { raw = null; }
    return genieRunningFrom(raw, alive, process.pid);
}

/** Doctor mode: hold a workspace while it runs an agent there beside a running Genie. */
export function writeDoctorHold(genieHome: string, hold: Omit<DoctorHold, 'pid'>): void {
    const file = doctorHoldFile(genieHome);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ pid: process.pid, ...hold }), 'utf8');
}

/** Doctor mode: let go — only our own hold. */
export function clearDoctorHold(genieHome: string): void {
    const file = doctorHoldFile(genieHome);
    try {
        if ((JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }).pid === process.pid) rmSync(file, { force: true });
    } catch { /* nothing to remove */ }
}

/** Normal Genie: doctor's live hold, or `null`. */
export function doctorHoldNow(genieHome: string): DoctorHold | null {
    let raw: string | null = null;
    try { raw = readFileSync(doctorHoldFile(genieHome), 'utf8'); } catch { raw = null; }
    return doctorHoldFrom(raw, alive);
}
