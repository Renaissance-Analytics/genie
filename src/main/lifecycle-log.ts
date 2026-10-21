import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE LIFECYCLE LOG — `~/.genie/runtime/lifecycle.log` (hosting plan 1.6; lifecycle review F10, 2026-10-20).
 *
 * One line per spawn, kill, verified exit, refusal and sweep. The installed app wrote no log file: the sweep and the
 * refused reaps went to `console.log`, which nobody sees, so the owner's question — did the restart leave the old Claude
 * running? — could not be settled from evidence. Appended synchronously (a crash right after a kill must not lose the
 * line that says so), one line per event, and rotated: past `maxBytes` the file becomes `lifecycle.log.1`.
 *
 * Never throws into its caller: a stop must not fail because its log could not be written.
 */
export function openLifecycleLog(dir: string, options: { now?: () => number; maxBytes?: number } = {}): (line: string) => void {
    const file = join(dir, 'lifecycle.log');
    const now = options.now ?? Date.now;
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    let size: number | null = null;
    return (line: string) => {
        try {
            const text = `${new Date(now()).toISOString()} ${line.replace(/[\r\n]+/g, ' ')}\n`;
            if (size === null) {
                mkdirSync(dir, { recursive: true });
                size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
            }
            if (size + Buffer.byteLength(text) > maxBytes && size > 0) {
                renameSync(file, `${file}.1`);
                size = 0;
            }
            appendFileSync(file, text, 'utf8');
            size += Buffer.byteLength(text);
        } catch {
            // Not written. The event itself already happened; nothing here may undo or interrupt it.
            size = null;
        }
    };
}
