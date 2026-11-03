export const ACL_FAILURE = 'PRIVATE_CREDENTIAL_ACL_FAILURE';

/** The only files that provoke it on purpose, each saying which of its tests do. */
const PROVOKES = new Set(['private-credentials-launch-count.test.ts', 'private-credentials-windows.test.ts']);

export function aclLinesOf(warned: readonly (readonly unknown[])[]): (readonly unknown[])[] {
    return warned.filter((args) => args[0] === ACL_FAILURE);
}

export function unexplainedAclFailures(testPath: string | undefined, lines: readonly (readonly unknown[])[]): (readonly unknown[])[] {
    return testPath !== undefined && PROVOKES.has(testPath.split(/[\\/]/).pop() ?? '') ? [] : [...lines];
}

export function checkAclLines(warned: unknown[][], testPath: string | undefined, when: string): void {
    const unexplained = unexplainedAclFailures(testPath, aclLinesOf(warned.splice(0)));
    if (unexplained.length > 0) throw new Error(`A failed ACL no test provoked, ${when}: ${JSON.stringify(unexplained)}. This is a question about secrets at rest, not noise. See test/acl-guard.test.ts.`);
}

export interface Moment { readonly monotonicMs: number; readonly wallMs: number }

/**
 * THE GUARD'S OWN CLOCK, HELD FROM LOAD. This module loads in the setup file, before any test can mock a timer, and these references are what it uses from then on. It asks one question, about
 * ACL lines, so nothing about time may fail a file: not fake timers left on (the global setTimeout never fires), and not a stalled worker (vitest fails a hook that ran past its time however it
 * ended, which six workers did on omarchy-test on 2026-11-03, after 10.7 s). 5 minutes is the outer limit for a wait of 25 ms.
 */
const realSetTimeout = globalThis.setTimeout;
const realMonotonic = performance.now.bind(performance);
const realWall = Date.now;
export const END_OF_FILE_HOOK_MS = 300_000;
const MOMENT_MS = 25;
/** Longer than this for a wait of 25 ms is worth a line in the log. */
const STALL_REPORT_MS = 1_000;

async function aMoment(ms: number): Promise<Moment> {
    const monotonic = realMonotonic();
    const wall = realWall();
    await new Promise((r) => realSetTimeout(r, ms));
    return { monotonicMs: Math.round(realMonotonic() - monotonic), wallMs: realWall() - wall };
}

/**
 * The moment, then the check. A stall is not a failure, but it is evidence (genie#1479), so it is said, by both clocks: the two agreeing is a pause, the wall alone is a clock that stepped. A line
 * is still a failure, stalled or not.
 */
export async function endOfFileCheck(warned: unknown[][], testPath: string | undefined, options: { moment?: (ms: number) => Promise<Moment>; report?: (line: string) => void } = {}): Promise<void> {
    const { monotonicMs, wallMs } = await (options.moment ?? aMoment)(MOMENT_MS);
    if (monotonicMs >= STALL_REPORT_MS || wallMs >= STALL_REPORT_MS) options.report?.(`TEST_CLOCK_STALL the guard's ${MOMENT_MS} ms wait took ${monotonicMs} ms monotonic, ${wallMs} ms wall, ending ${new Date(realWall()).toISOString()}, ${testPath ?? 'no test file'}`);
    checkAclLines(warned, testPath, 'at the end of this file');
}
