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
export const END_OF_FILE_HOOK_MS = 10_000;

// RED: what the guard does today, moved here whole so the tests below can reach it.
async function aMoment(ms: number): Promise<Moment> {
    await new Promise((r) => setTimeout(r, ms));
    return { monotonicMs: ms, wallMs: ms };
}

export async function endOfFileCheck(warned: unknown[][], testPath: string | undefined, options: { moment?: (ms: number) => Promise<Moment>; report?: (line: string) => void } = {}): Promise<void> {
    await (options.moment ?? aMoment)(25);
    checkAclLines(warned, testPath, 'at the end of this file');
}
