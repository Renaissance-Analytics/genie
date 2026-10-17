import { composeServices, type ComposedServices } from '../../src/main/compose.js';
import { onceIssuer } from './once-issuer.js';

/**
 * EVERY COMPOSITION A TEST STARTS IS SHUT DOWN BEFORE ITS FOLDER IS REMOVED — including one still composing when the
 * test ended (B13).
 *
 * The failure this closes (GitHub's Windows release runner): a test timed out while `composeServices` was still
 * running; vitest went straight to `afterEach`, which shut down only the services ASSIGNED so far (none — the
 * assignment waits for the composition) and removed the folder while the composition held `runtime/knowledge.db`
 * open: `EBUSY … unlink …\runtime\knowledge.db`. The composition then finished in the background and nobody ever
 * shut it down — an open database, a listening front door and live timers in that worker for the rest of the run.
 *
 * So the tracker keeps the composition's PROMISE, from the moment it starts: `shutdownAll()` waits for each one to
 * settle and shuts down every one that came up (a shutdown is idempotent, so one the test already shut down is fine).
 */
export interface ComposeTracker {
    compose(input: Parameters<typeof composeServices>[0]): Promise<ComposedServices>;
    /** Waits for every composition started, shuts down each that came up, and forgets them. Never rejects for a failed composition. */
    shutdownAll(): Promise<void>;
}

export function composeTracker(): ComposeTracker {
    let started: Promise<ComposedServices | null>[] = [];
    return {
        compose(input) {
            // The real issuer, made once per file (support/once-issuer.ts), unless the test brings its own.
            const composing = composeServices({ certIssuer: onceIssuer, ...input });
            // A composition that failed has nothing to shut down; its failure is the test's to report, not the cleanup's.
            started.push(composing.catch(() => null));
            return composing;
        },
        async shutdownAll() {
            const all = started;
            started = [];
            for (const services of await Promise.all(all)) await services?.shutdown();
        },
    };
}
