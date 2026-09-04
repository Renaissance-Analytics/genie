/**
 * The filter surface — props in, yes or no out.
 *
 * Every operator is asserted in BOTH directions. An operator that always returns
 * false satisfies half of these tests perfectly, and half a test suite is how a
 * filter ships broken.
 *
 * The other half of this file is about the difference between "this event does
 * not match" and "this predicate is nonsense", which must never be confused: the
 * first is ordinary, the second is a Wish that will never fire and must be
 * caught when it is written.
 */

import { describe, expect, it } from 'vitest';
import { matchesWishFilter, validateWishFilter, WishFilterError } from '../filter';
import { FILE_ADDED_EVENT } from '../file-source';
import type { WishEventDefinition, WishFilterOp } from '../types';

const props = {
    relPath: 'assets/big-video.MP4',
    name: 'big-video.MP4',
    extension: 'mp4',
    sizeBytes: 6_000_000,
    tracked: false,
};

const DEF: WishEventDefinition = {
    id: 'demo:happened',
    label: 'Demo',
    props: [
        { key: 'relPath', type: 'string', label: 'Path' },
        { key: 'name', type: 'string', label: 'Name' },
        { key: 'extension', type: 'string', label: 'Extension' },
        { key: 'sizeBytes', type: 'number', label: 'Size' },
        { key: 'tracked', type: 'boolean', label: 'Tracked' },
    ],
};

/** [op, prop, matching value, non-matching value] */
const CASES: Array<[WishFilterOp, string, unknown, unknown]> = [
    ['eq', 'sizeBytes', 6_000_000, 5],
    ['ne', 'sizeBytes', 5, 6_000_000],
    ['gt', 'sizeBytes', 5_242_880, 6_000_000],
    ['gte', 'sizeBytes', 6_000_000, 6_000_001],
    ['lt', 'sizeBytes', 6_000_001, 6_000_000],
    ['lte', 'sizeBytes', 6_000_000, 5_999_999],
    ['matches', 'relPath', '\\.MP4$', '\\.png$'],
    ['startsWith', 'relPath', 'assets/', 'src/'],
    ['endsWith', 'name', '.MP4', '.png'],
    ['contains', 'relPath', 'big-', 'small-'],
    ['in', 'extension', ['mp4', 'mov'], ['png', 'gif']],
    ['notIn', 'extension', ['png', 'gif'], ['mp4', 'mov']],
    ['eq', 'tracked', false, true],
];

describe('every operator, in both directions', () => {
    it.each(CASES)('%s on %s', (op, prop, matching, notMatching) => {
        expect(
            matchesWishFilter({ all: [{ prop, op, value: matching as never }] }, props),
            `${op} should match`,
        ).toBe(true);
        expect(
            matchesWishFilter({ all: [{ prop, op, value: notMatching as never }] }, props),
            `${op} should not match`,
        ).toBe(false);
    });
});

describe('the groups compose', () => {
    it('matches everything when there is no filter — a trigger may have no predicate', () => {
        expect(matchesWishFilter(undefined, props)).toBe(true);
        expect(matchesWishFilter({}, props)).toBe(true);
    });

    it('requires all of `all`', () => {
        const clause = { prop: 'sizeBytes', op: 'gt' as const, value: 5_242_880 };
        expect(matchesWishFilter({ all: [clause] }, props)).toBe(true);
        expect(
            matchesWishFilter(
                { all: [clause, { prop: 'extension', op: 'eq', value: 'png' }] },
                props,
            ),
        ).toBe(false);
    });

    it('requires one of `any`', () => {
        expect(
            matchesWishFilter(
                {
                    any: [
                        { prop: 'extension', op: 'eq', value: 'png' },
                        { prop: 'extension', op: 'eq', value: 'mp4' },
                    ],
                },
                props,
            ),
        ).toBe(true);
        expect(
            matchesWishFilter({ any: [{ prop: 'extension', op: 'eq', value: 'png' }] }, props),
        ).toBe(false);
    });

    it('requires none of `none` — "these, but not those"', () => {
        const big = { prop: 'sizeBytes', op: 'gt' as const, value: 5_242_880 };
        expect(
            matchesWishFilter(
                { all: [big], none: [{ prop: 'relPath', op: 'startsWith', value: '.genie/' }] },
                props,
            ),
        ).toBe(true);
        expect(
            matchesWishFilter(
                { all: [big], none: [{ prop: 'relPath', op: 'startsWith', value: 'assets/' }] },
                props,
            ),
        ).toBe(false);
    });

    it('does not match on a prop this event did not carry', () => {
        // Ordinary: events of one kind may omit an optional prop. Not an error,
        // and not a reason to throw.
        expect(matchesWishFilter({ all: [{ prop: 'absent', op: 'eq', value: 1 }] }, props)).toBe(
            false,
        );
    });
});

describe('a broken predicate is a fault, not a non-match', () => {
    it('throws for an unknown operator rather than quietly never matching', () => {
        expect(() =>
            matchesWishFilter(
                { all: [{ prop: 'sizeBytes', op: 'approximately' as WishFilterOp, value: 1 }] },
                props,
            ),
        ).toThrow(WishFilterError);
    });

    it('throws when the comparison value is the wrong shape for the operator', () => {
        expect(() =>
            matchesWishFilter(
                { all: [{ prop: 'sizeBytes', op: 'gt', value: 'big' as never }] },
                props,
            ),
        ).toThrow(WishFilterError);
        expect(() =>
            matchesWishFilter({ all: [{ prop: 'extension', op: 'in', value: 'mp4' }] }, props),
        ).toThrow(WishFilterError);
    });
});

describe('validateWishFilter, against what the event declares', () => {
    it('passes the reference-case filter on the real event definition', () => {
        expect(
            validateWishFilter(
                { all: [{ prop: 'sizeBytes', op: 'gt', value: 5_242_880 }] },
                FILE_ADDED_EVENT,
            ),
        ).toEqual([]);
    });

    it('catches the misspelling that would otherwise be a silent night', () => {
        const errors = validateWishFilter(
            { all: [{ prop: 'sizeBtyes', op: 'gt', value: 1 }] },
            FILE_ADDED_EVENT,
        );
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('sizeBtyes');
        // The message lists what IS available, so the fix does not need a doc.
        expect(errors[0]).toContain('sizeBytes');
    });

    it('catches an operator applied to the wrong type', () => {
        expect(
            validateWishFilter({ all: [{ prop: 'relPath', op: 'gt', value: 1 }] }, DEF).join(' '),
        ).toContain('cannot be applied to string');
    });

    it('catches a value of the wrong type', () => {
        expect(
            validateWishFilter({ all: [{ prop: 'sizeBytes', op: 'eq', value: 'big' }] }, DEF).join(
                ' ',
            ),
        ).toContain('number');
    });

    it('catches a list where a single value belongs, and the reverse', () => {
        expect(
            validateWishFilter({ all: [{ prop: 'extension', op: 'eq', value: ['a'] }] }, DEF),
        ).toHaveLength(1);
        expect(
            validateWishFilter({ all: [{ prop: 'extension', op: 'in', value: 'a' }] }, DEF),
        ).toHaveLength(1);
    });

    it('catches a regex that does not compile', () => {
        expect(
            validateWishFilter({ all: [{ prop: 'relPath', op: 'matches', value: '([' }] }, DEF).join(
                ' ',
            ),
        ).toContain('regular expression');
    });

    it('reports every problem at once, not just the first', () => {
        const errors = validateWishFilter(
            {
                all: [
                    { prop: 'nope', op: 'eq', value: 1 },
                    { prop: 'relPath', op: 'gt', value: 1 },
                ],
                none: [{ prop: 'alsoNope', op: 'eq', value: 1 }],
            },
            DEF,
        );
        expect(errors).toHaveLength(3);
    });
});
