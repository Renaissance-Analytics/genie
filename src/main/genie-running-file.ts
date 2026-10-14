import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { genieRunningFile, genieRunningFrom } from '../core/genie-running.js';

/** Normal Genie, at boot: "I am running" (core/genie-running.ts). A failed write is reported, never fatal. */
export function markGenieRunning(genieHome: string): void {
    const file = genieRunningFile(genieHome);
    try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
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

/** Doctor mode: is normal Genie running now? `process.kill(pid, 0)` asks the OS whether the pid is alive. */
export function genieRunningNow(genieHome: string): { running: true; pid: number } | { running: false } {
    let raw: string | null = null;
    try { raw = readFileSync(genieRunningFile(genieHome), 'utf8'); } catch { raw = null; }
    return genieRunningFrom(raw, (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } }, process.pid);
}
