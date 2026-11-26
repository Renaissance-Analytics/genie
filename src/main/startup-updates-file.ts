import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renameOverSync } from '../core/atomic-rename.js';
import type { StartupProgress } from '../core/startup-updates.js';

/**
 * THE START'S UPDATES, FOR A WAITING WINDOW (Tynn #1067). genie-host serves no window until its boot is done, and the due
 * updates come first in it, so the window that waits for the host (host-wait-window.ts) reads what it is doing from this
 * file in Genie's runtime folder. The host writes it at each step and removes it when it is done or at its limit. A file
 * older than its own limit (plus a minute) is from a host that died mid-update and is not shown.
 */

export const startupProgressFile = (runtime: string): string => join(runtime, 'startup-updates.json');

const STALE_GRACE_MS = 60_000;

export function writeStartupProgress(runtime: string, progress: StartupProgress | null): void {
    const file = startupProgressFile(runtime);
    if (progress === null) { rmSync(file, { force: true }); return; }
    const part = `${file}.${process.pid}.part`;
    writeFileSync(part, JSON.stringify(progress));
    renameOverSync(part, file);
}

export function readStartupProgress(runtime: string, now: number): StartupProgress | null {
    try {
        const p = JSON.parse(readFileSync(startupProgressFile(runtime), 'utf8')) as Partial<StartupProgress>;
        if (typeof p.step !== 'string' || typeof p.startedAt !== 'number' || typeof p.limitMs !== 'number') return null;
        if (now > p.startedAt + p.limitMs + STALE_GRACE_MS) return null;
        return { step: p.step, startedAt: p.startedAt, limitMs: p.limitMs };
    } catch {
        return null;
    }
}
