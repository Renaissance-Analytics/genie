export const ACL_FAILURE = 'PRIVATE_CREDENTIAL_ACL_FAILURE';

/** The only files that provoke it on purpose, each saying which of its tests do. */
const PROVOKES = new Set(['private-credentials-launch-count.test.ts', 'private-credentials-windows.test.ts']);

export function aclLinesOf(warned: readonly (readonly unknown[])[]): (readonly unknown[])[] {
    return warned.filter((args) => args[0] === ACL_FAILURE);
}

export function unexplainedAclFailures(testPath: string | undefined, lines: readonly (readonly unknown[])[]): (readonly unknown[])[] {
    return testPath !== undefined && PROVOKES.has(testPath.split(/[\\/]/).pop() ?? '') ? [] : [...lines];
}
