import { describe, expect, it } from 'vitest';
import { projectPickerOptions } from '../project-picker';

/**
 * Labels for a project picker.
 *
 * Every row used to read `[TYNN] The Ripple Effect`, on every project, in every
 * picker. The tag told two backends apart; Tynn is now the only one (genie#679),
 * so there is nothing for a tag to distinguish and a row is labelled by its NAME.
 */
const tynn = (id: string, name: string, owner?: string) => ({
    id,
    name,
    backend: 'tynn' as const,
    ...(owner ? { owner_name: owner } : {}),
});

describe('a project picker', () => {
    it('shows the NAME alone — the tag would distinguish nothing', () => {
        const options = projectPickerOptions([
            tynn('1', 'The Ripple Effect'),
            tynn('2', 'Impact Hub'),
        ]);

        expect(options.map((o) => o.label)).toEqual(['The Ripple Effect', 'Impact Hub']);
    });

    it('keeps the value as the project id, so nothing about selection changes', () => {
        const options = projectPickerOptions([tynn('abc', 'Impact Hub')]);
        expect(options[0]).toEqual({ value: 'abc', label: 'Impact Hub' });
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

describe('no backend tag, whatever a row says', () => {
    it('never prefixes a row — there is one backend, so a tag distinguishes nothing', () => {
        // A payload from an older Genie can still carry another backend string;
        // it must not bring the `[…]` column back.
        const options = projectPickerOptions([
            tynn('1', 'The Ripple Effect'),
            { id: '2', name: 'Some Envelope', backend: 'legacy' },
        ]);

        expect(options.map((o) => o.label)).toEqual(['The Ripple Effect', 'Some Envelope']);
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
});
