/** Inert stub (RED): the guard that keeps a machine out of a repo (Tynn #756). The implementation lands after the tests are seen failing. */

export type GuardRule = 'absolute-path' | 'port' | 'secret-key' | 'secret-value' | 'machine-key' | 'unsafe-file-path';

export interface GuardViolation {
    readonly path: string;
    readonly rule: GuardRule;
    readonly reason: string;
}

export function scanForMachineState(_value: unknown, _root = ''): GuardViolation[] {
    return [];
}

export function savePathProblem(_path: string): string | null {
    return null;
}
