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
