import type { TrustApi } from '../../src/main/hosting-trust.js';

/**
 * A hosting's trust (genie#1519) that has read nothing: every workspace untrusted, every write refused, as a window's
 * replica reads before its first dump. For a fake hosting a test hands compose.
 */
export function closedTrust(): TrustApi {
    return {
        isTrustedPath: () => false,
        view: () => null,
        entries: () => [],
        refresh: async () => null,
        untrust: async () => null,
        trust: async () => null,
        mayWriteInto: async () => false,
        onVerdict: () => () => {},
    };
}
