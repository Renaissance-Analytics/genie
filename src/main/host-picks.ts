/** STUB (genie#1354, test-first commit): the API the tests need; the behaviour lands with the fix. */

export class HostPicks {
    constructor(readonly limit = 500) {}
    record(_paths: readonly unknown[]): void {}
    has(_path: string): boolean {
        return false;
    }
}

export type FeatureOrigin = { readonly kind: 'remote' } | { readonly kind: 'local'; readonly picks: HostPicks };

export const REMOTE_ORIGIN: FeatureOrigin = Object.freeze({ kind: 'remote' as const });

export function featureOrigin(_input: { remoteWindow: boolean; picks: HostPicks }): FeatureOrigin {
    return REMOTE_ORIGIN;
}
