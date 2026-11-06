import type { CrashRecord } from '../core/crash-record.js';

/**
 * THE CRASH RECORDS ON DISK (Tynn story #386): `<genieRoot()>/runtime/crash/<ISO time>.json`. Synchronous (the paths that
 * write them are where a process is about to end) and never throwing.
 */

export function writeCrashRecord(_dir: string, _record: CrashRecord): string | null {
    throw new Error('not built yet (Tynn #386)');
}

export function removeCrashRecord(_file: string): void {
    throw new Error('not built yet (Tynn #386)');
}

export function latestCrashRecord(_dir: string): CrashRecord | null {
    throw new Error('not built yet (Tynn #386)');
}

export function readLifecycleTail(_runtime: string): string[] {
    throw new Error('not built yet (Tynn #386)');
}
