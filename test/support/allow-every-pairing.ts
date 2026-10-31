import type { PairConfirm } from '../../src/core/pair-confirm.js';

/**
 * A "Pair this device?" that the person always allows at once — for tests whose subject is what happens AFTER pairing
 * (Genie 1's tests did the same with `confirmPair: async () => true`). The confirm itself is held by
 * test/pair-confirm.test.ts. The host still sends its `pairing` frame first, so a test client skips it.
 */
export const allowEveryPairing: PairConfirm = {
    ask: () => ({ id: 'pair_auto', expiresAt: Number.MAX_SAFE_INTEGER, answer: Promise.resolve('allow') }),
    cancel: () => {},
};
