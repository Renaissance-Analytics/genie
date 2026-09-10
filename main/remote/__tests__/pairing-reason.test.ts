import { describe, expect, it } from 'vitest';
import { PIN_REASONS, pairingPrompt, type PinReason } from '../pairing-reason';

/**
 * The sentence the user reads when the PIN field appears.
 *
 * Every reason has to produce a DIFFERENT sentence: the whole complaint in
 * genie#578 is that four causes looked identical, and a UI that says "first
 * time pairing" while the keychain is broken reproduces that on screen no
 * matter how well the main process now distinguishes them.
 */

describe('pairingPrompt', () => {
    it('gives a distinct sentence for every reason', () => {
        const said = PIN_REASONS.map((r) => pairingPrompt(r, 'zeus'));
        expect(new Set(said).size).toBe(PIN_REASONS.length);
        for (const s of said) expect(s.length).toBeGreaterThan(0);
    });

    it('only calls it a first-time pair when it IS one', () => {
        expect(pairingPrompt('first-pair', 'zeus')).toMatch(/first time/i);
        for (const r of PIN_REASONS.filter((x) => x !== 'first-pair')) {
            expect(pairingPrompt(r, 'zeus')).not.toMatch(/first time/i);
        }
    });

    it('names the host it is talking about', () => {
        for (const r of PIN_REASONS) expect(pairingPrompt(r, 'zeus')).toContain('zeus');
    });

    it('says the host threw the pairing out when it did', () => {
        expect(pairingPrompt('token-rejected', 'zeus')).toMatch(/no longer/i);
    });

    it('warns that a re-pair will not be REMEMBERED when there is no keychain', () => {
        expect(pairingPrompt('keychain-unavailable', 'zeus')).toMatch(/remember|again next time|won't be saved/i);
    });

    /**
     * genie#588 — this sentence is the one the reporter read for six days on a
     * machine whose keyring was provably healthy the whole time. Blaming the
     * computer sent them to reinstall gnome-keyring and libsecret that were
     * already installed and already serving `gh`.
     */
    it('does NOT blame the computer when GENIE is the one on the plaintext store', () => {
        const notSelected = pairingPrompt('keychain-not-selected', 'AlphaR');
        expect(notSelected).not.toMatch(/keychain is unavailable|keychain was unavailable/i);
        expect(notSelected).not.toMatch(/install/i);
        // It says what is actually true — a working keyring this process is not
        // using — and it still warns that the pairing will not be kept.
        expect(notSelected).toMatch(/plain ?text|basic/i);
        expect(notSelected).toMatch(/remember|kept|saved/i);
        // Negative control: the genuine no-keychain reason still reads as one,
        // so the assertions above are about the NEW reason, not the wording of
        // both drifting together.
        expect(pairingPrompt('keychain-unavailable', 'AlphaR')).toMatch(/keychain is unavailable/i);
    });

    it('falls back to the first-pair wording for an unknown/absent reason', () => {
        expect(pairingPrompt(undefined, 'zeus')).toBe(pairingPrompt('first-pair', 'zeus'));
        expect(pairingPrompt('nonsense' as PinReason, 'zeus')).toBe(pairingPrompt('first-pair', 'zeus'));
    });
});
