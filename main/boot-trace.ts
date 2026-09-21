import fs from 'node:fs';
import path from 'node:path';

/**
 * WHERE DID THE BOOT GO? — an always-on phase trace.
 *
 * The owner: *"something just made genie completely crash recently and when I
 * came back up the main screen was frozen with a circle spinning for about 30
 * seconds before it resolved."* Neither half was diagnosable afterwards:
 *
 *   - there was **no Crashpad directory at all**, so the crash wrote no dump;
 *   - the only logs are the pty host and the background service, and the
 *     service records two lines per boot (a registry write);
 *   - `grep` for boot/ready/startup logging in `background.ts` returned **zero**.
 *
 * So the app crashed, restarted, hung for half a minute, and recorded nothing
 * about either. A spinner is a promise that something is happening; with no
 * record of WHAT, it is undiagnosable the moment it stops.
 *
 * ## Why this is not `--genie-debug`
 *
 * That flag exists and is good, and it is **opt-in and off by default**. It
 * answers "reproduce it with the flag on" — which cannot answer "what happened
 * half an hour ago", and a hang that resolves after 30 seconds is precisely the
 * failure nobody reproduces on demand. This is always on, and is therefore kept
 * deliberately small: a line per phase, not application logging.
 *
 * ## The one property that matters
 *
 * Each phase is written **synchronously, as it is entered**. A hung boot never
 * reaches the end, so anything buffered in memory dies with it — the trace is
 * only useful if the bytes are already on disk when the process stops
 * answering. Which means:
 *
 *   **The last line in the file names the phase that never finished.**
 *
 * That is the whole deliverable. A completed boot ends with `ready`; a file
 * ending anywhere else is a boot that stopped there, and the elapsed column says
 * how long it had been waiting.
 *
 * Bounded by rotation rather than by cleverness — a boot trace that grows
 * forever becomes the next thing someone has to clean up (see genie#735, 425
 * token files nobody reaped).
 */

/** Keep this many boots. Enough to cover "it did it again", small enough to read. */
export const BOOT_TRACE_KEEP = 20;

/** The marker a completed boot ends with. Its ABSENCE is the signal. */
export const BOOT_DONE = 'ready';

/** One line: elapsed since boot start, the phase, and the wall clock. */
export function formatPhase(phase: string, elapsedMs: number, at: Date): string {
    return `${at.toISOString()} +${String(elapsedMs).padStart(6)}ms ${phase}`;
}

/** The phase name out of a trace line, or null when the line is not one. */
export function phaseOf(line: string): string | null {
    const m = /^\S+ \+\s*\d+ms (.+)$/.exec(line.trim());
    return m ? m[1]! : null;
}

/**
 * Read a trace and say where the LAST boot stopped.
 *
 * Returns null when that boot completed — i.e. its final phase is {@link
 * BOOT_DONE}. Otherwise the phase it was in when it stopped, which is the
 * answer to "what was the spinner waiting for".
 */
export function whereBootStopped(contents: string): string | null {
    const phases = contents
        .split(/\r?\n/)
        .map(phaseOf)
        .filter((p): p is string => p !== null);
    const last = phases.at(-1);
    if (!last || last === BOOT_DONE) return null;
    return last;
}

/** Drop whole boots from the FRONT, keeping the most recent `keep`. */
export function rotate(contents: string, keep: number): string {
    const lines = contents.split(/\r?\n/).filter((l) => l.trim().length > 0);
    // A boot begins at its first phase after a `ready`, so count completed boots
    // and trim from the front on whole-boot boundaries — never mid-boot, which
    // would leave a fragment that reads as a boot that stopped early.
    const starts: number[] = [];
    let expectStart = true;
    lines.forEach((line, i) => {
        if (expectStart) {
            starts.push(i);
            expectStart = false;
        }
        if (phaseOf(line) === BOOT_DONE) expectStart = true;
    });
    if (starts.length <= keep) return lines.join('\n') + (lines.length ? '\n' : '');
    const from = starts[starts.length - keep]!;
    return lines.slice(from).join('\n') + '\n';
}

let startedAt: number | null = null;
let file: string | null = null;

/** Begin a boot. Rotates the existing trace and records the first phase. */
export function beginBootTrace(logsDir: string, now: Date = new Date()): void {
    startedAt = now.getTime();
    file = path.join(logsDir, 'boot.log');
    try {
        fs.mkdirSync(logsDir, { recursive: true });
        let existing = '';
        try {
            existing = fs.readFileSync(file, 'utf8');
        } catch {
            /* first boot on this machine */
        }
        fs.writeFileSync(file, rotate(existing, BOOT_TRACE_KEEP - 1));
    } catch {
        /* a trace that cannot be written must never stop the boot */
    }
    bootPhase('start', now);
}

/**
 * Record entering a phase. Synchronous on purpose — see the module docblock:
 * buffered bytes are exactly the ones a hang loses.
 */
export function bootPhase(phase: string, now: Date = new Date()): void {
    if (file === null || startedAt === null) return;
    try {
        fs.appendFileSync(file, formatPhase(phase, now.getTime() - startedAt, now) + '\n');
    } catch {
        /* never let tracing break the thing it is tracing */
    }
}
