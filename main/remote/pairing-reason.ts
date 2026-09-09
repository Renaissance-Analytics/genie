/**
 * WHY Genie is asking for a pairing PIN — and what to say about it.
 *
 * Four different things put the PIN field back on screen, and until genie#578
 * they were one undifferentiated `needsPin: true`. Three of them are faults, and
 * the UI announced all four as "first time pairing" — which is how the same
 * failure recurred for months with nobody able to name which one it was.
 *
 * Pure and shared: `main` decides the reason, the renderer imports the same
 * union and the same sentences, so the two cannot drift.
 */

export const PIN_REASONS = [
    /** No saved token for this host — a genuine first pair (or after Forget). */
    'first-pair',
    /** A token IS saved and could not be decrypted (written under another key). */
    'token-unreadable',
    /** No keychain to read a saved pairing with — or, just as often, none to
     *  have SAVED it with last time, which is why the store is empty. Either
     *  way the pairing about to be made won't be kept until it comes back. */
    'keychain-unavailable',
    /** The host answered 401: it no longer knows this token. */
    'token-rejected',
] as const;

export type PinReason = (typeof PIN_REASONS)[number];

/** The sentence shown beside the PIN field. Names the host, and names the cause
 *  when the cause is not simply "you have never paired this". */
export function pairingPrompt(reason: PinReason | undefined, hostname: string): string {
    switch (reason) {
        case 'token-unreadable':
            return `The saved pairing for ${hostname} could not be decrypted, so it can't be reused. Enter the PIN shown on ${hostname} to pair again.`;
        case 'keychain-unavailable':
            return `This computer's keychain is unavailable, so pairings can't be read or saved. You can pair with ${hostname} using its PIN now, but it won't be remembered until the keychain is back — which is why it keeps asking.`;
        case 'token-rejected':
            return `${hostname} no longer recognises this device — its pairing was dropped there. Enter the PIN shown on ${hostname} to pair again.`;
        case 'first-pair':
        default:
            return `First time pairing ${hostname}: enter the PIN shown on it.`;
    }
}
