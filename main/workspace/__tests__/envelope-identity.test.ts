import { describe, expect, it } from 'vitest';
import { hasEnvelopeShape, isProjectEnvelope } from '../envelope-identity';

/**
 * ROLE IS NOT SHAPE.
 *
 * Envelope-ness used to be decided entirely by what the DIRECTORY looked like,
 * with nothing consulting what the workspace IS FOR. The workstation operator's
 * own row is written with `shape: 'agi'` and its envelope carries a
 * `project.json`, so orientation told it — in the same JSON object that told it
 * it was the operator — that it was a `.agi` project envelope.
 *
 * These are the two questions, kept apart on purpose: `hasEnvelopeShape` is the
 * fact about the folder, `isProjectEnvelope` is the claim about the workspace.
 */

/** An envelope-shaped folder, by every signal at once. */
const SHAPED = {
    shape: 'agi',
    detectedState: 'FULL_ENVELOPE',
    hasProjectJson: true,
    hasGitmodules: true,
} as const;

/** A plain single-repo folder. */
const PLAIN = {
    shape: 'simple',
    detectedState: 'SIMPLE_REPO',
    hasProjectJson: false,
    hasGitmodules: false,
} as const;

describe('hasEnvelopeShape — the fact about the FOLDER', () => {
    it('is true for any one envelope signal on its own', () => {
        expect(hasEnvelopeShape({ ...PLAIN, shape: 'agi' })).toBe(true);
        expect(hasEnvelopeShape({ ...PLAIN, detectedState: 'FULL_ENVELOPE' })).toBe(true);
        expect(hasEnvelopeShape({ ...PLAIN, hasProjectJson: true })).toBe(true);
        expect(hasEnvelopeShape({ ...PLAIN, hasGitmodules: true })).toBe(true);
    });

    it('is false when the folder carries none of them', () => {
        expect(hasEnvelopeShape(PLAIN)).toBe(false);
    });

    it('does not know or care about the ROLE — the folder is the folder', () => {
        // The whole point of keeping this separate: an operator whose workspace
        // genuinely IS an envelope directory must still be able to learn that.
        expect(hasEnvelopeShape(SHAPED)).toBe(true);
    });

    it('tolerates an unread shape or detection', () => {
        // `detectFolder` is wrapped in a try/catch at the call site and a row's
        // shape can be null; neither absence may read as "envelope".
        expect(hasEnvelopeShape({ hasProjectJson: false, hasGitmodules: false })).toBe(false);
        expect(
            hasEnvelopeShape({
                shape: null,
                detectedState: null,
                hasProjectJson: false,
                hasGitmodules: false,
            }),
        ).toBe(false);
    });
});

describe('isProjectEnvelope — the claim about the WORKSPACE', () => {
    it('is FALSE for the workstation operator, however envelope-shaped its folder', () => {
        expect(isProjectEnvelope({ ...SHAPED, workstationOperator: true })).toBe(false);
    });

    it('POSITIVE CONTROL — an ordinary workspace in the same folder IS one', () => {
        // Without this, "false for the operator" is satisfied by returning false
        // for every workspace on the machine, which would tell every agent in
        // every envelope that its repos are not the primary resource.
        expect(isProjectEnvelope({ ...SHAPED, workstationOperator: false })).toBe(true);
    });

    it('POSITIVE CONTROL — each shape signal alone still makes an ordinary workspace one', () => {
        for (const signal of [
            { shape: 'agi' },
            { detectedState: 'FULL_ENVELOPE' },
            { hasProjectJson: true },
            { hasGitmodules: true },
        ]) {
            expect(isProjectEnvelope({ ...PLAIN, ...signal, workstationOperator: false })).toBe(true);
            // …and the operator is not one on the strength of that same signal.
            expect(isProjectEnvelope({ ...PLAIN, ...signal, workstationOperator: true })).toBe(false);
        }
    });

    it('is false for a plain workspace whether or not it is the operator', () => {
        expect(isProjectEnvelope({ ...PLAIN, workstationOperator: false })).toBe(false);
        expect(isProjectEnvelope({ ...PLAIN, workstationOperator: true })).toBe(false);
    });
});
