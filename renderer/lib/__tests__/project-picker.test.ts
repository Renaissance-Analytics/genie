import { describe, expect, it } from 'vitest';
import { projectPickerOptions } from '../project-picker';

/**
 * Labels for a project picker.
 *
 * Every row used to read `[TYNN] The Ripple Effect`, on every project, in every
 * picker. The tag exists to tell two BACKENDS apart (`tynn` and `aionima`) — but
 * when every project in the list comes from the same one it distinguishes
 * nothing, and twenty rows of `[TYNN]` is a column of noise the eye has to skip
 * before it reaches the name it is looking for.
 *
 * So the tag earns its place: shown when the list actually mixes backends, gone
 * when it does not.
 */
const tynn = (id: string, name: string, owner?: string) => ({
    id,
    name,
    backend: 'tynn' as const,
    ...(owner ? { owner_name: owner } : {}),
});

describe('a picker whose projects all come from one backend', () => {
    it('shows the NAME alone — the tag would distinguish nothing', () => {
        const options = projectPickerOptions([
            tynn('1', 'The Ripple Effect'),
            tynn('2', 'Impact Hub'),
        ]);

        expect(options.map((o) => o.label)).toEqual(['The Ripple Effect', 'Impact Hub']);
    });

    it('keeps the value as the project id, so nothing about selection changes', () => {
        const options = projectPickerOptions([tynn('abc', 'Aionima')]);
        expect(options[0]).toEqual({ value: 'abc', label: 'Aionima' });
    });

    it('treats a project with NO backend as the default one', () => {
        // `backend` is optional on the wire; an older row without it is a tynn
        // project, and must not be mistaken for a second backend and drag the
        // tag back onto every row.
        const options = projectPickerOptions([
            { id: '1', name: 'Old Row' },
            tynn('2', 'New Row'),
        ]);

        expect(options.map((o) => o.label)).toEqual(['Old Row', 'New Row']);
    });
});

describe('a picker whose projects come from DIFFERENT backends', () => {
    it('tags every row, so the two are told apart', () => {
        const options = projectPickerOptions([
            tynn('1', 'The Ripple Effect'),
            { id: '2', name: 'Some Envelope', backend: 'aionima' as const },
        ]);

        // Tagged on BOTH, not just the odd one out: a bare name beside a tagged
        // one reads as "untagged means the other thing", which is a guess.
        expect(options.map((o) => o.label)).toEqual([
            '[TYNN] The Ripple Effect',
            '[AIONIMA] Some Envelope',
        ]);
    });
});

describe('the owner suffix', () => {
    it('is appended when asked for, and left off when there is no owner', () => {
        const options = projectPickerOptions(
            [tynn('1', 'AI Trader', 'Aaron Johnson'), tynn('2', 'No Owner')],
            { withOwner: true },
        );

        expect(options.map((o) => o.label)).toEqual(['AI Trader · Aaron Johnson', 'No Owner']);
    });

    it('is off by default', () => {
        const options = projectPickerOptions([tynn('1', 'AI Trader', 'Aaron Johnson')]);
        expect(options[0]!.label).toBe('AI Trader');
    });
});

/**
 * The Genie App marker (Tynn `is_gapp`, tynn.ai#204 / genie#245).
 *
 * A GApp project is where a Genie App is DEVELOPED. Tynn only publishes the flag
 * on the project row, so the picker is the first place a user meets it — and the
 * picker is exactly where they need it, because "which of my projects is the app
 * I'm building" is the question they are answering when they link a workspace.
 *
 * Marker form is a trailing parenthetical rather than another ` · ` suffix, so it
 * can never be misread as an owner name — and it echoes how Ops mode already
 * announces itself ("(Ops project — full access)").
 */
describe('the Genie App marker', () => {
    it('marks a GApp project and leaves a plain one alone', () => {
        // Both asserted in ONE list: a marker hardcoded on would fail the second
        // row, and a marker never applied would fail the first.
        const options = projectPickerOptions([
            { ...tynn('1', 'AI Trader'), isGapp: true },
            { ...tynn('2', 'The Ripple Effect'), isGapp: false },
        ]);

        expect(options.map((o) => o.label)).toEqual([
            'AI Trader (Genie App)',
            'The Ripple Effect',
        ]);
    });

    it('treats a row with NO flag as not a GApp', () => {
        // Older payload, or a backend that has no such concept. Absent must read
        // as "no", never as a marker on every row.
        const options = projectPickerOptions([{ id: '1', name: 'Old Row' }]);
        expect(options[0]!.label).toBe('Old Row');
    });

    it('sits after the owner, so both suffixes stay legible together', () => {
        const options = projectPickerOptions(
            [{ ...tynn('1', 'AI Trader', 'Aaron Johnson'), isGapp: true }],
            { withOwner: true },
        );

        expect(options[0]!.label).toBe('AI Trader · Aaron Johnson (Genie App)');
    });

    it('composes with the backend tag when the list mixes backends', () => {
        const options = projectPickerOptions([
            { ...tynn('1', 'AI Trader'), isGapp: true },
            { id: '2', name: 'Some Envelope', backend: 'aionima' as const },
        ]);

        expect(options.map((o) => o.label)).toEqual([
            '[TYNN] AI Trader (Genie App)',
            '[AIONIMA] Some Envelope',
        ]);
    });
});
