import { describe, expect, it } from 'vitest';
import { approvalFrom, type PermissionRequestLike } from '../src/core/approval.js';

/**
 * A PARKED APPROVAL — what the protocol sends, turned into something a person can answer.
 *
 * ## The shape the wire gives us is deliberately loose
 *
 * `PermissionRequest` is `{ toolCall: Record<string, unknown>, options: Record<string, unknown>[] }`.
 * Both are open records, because ACP's permission options are provider-defined — their ids,
 * their labels and their meanings all come from the other end.
 *
 * That makes this module a narrowing boundary, and it has to narrow **without inventing**. An
 * option whose id cannot be read is an option that cannot be answered, and offering a button
 * that resolves to nothing is worse than offering none: the human presses it, the agent stays
 * parked, and the UI says the question was answered.
 */

const request = (over: Partial<PermissionRequestLike> = {}): PermissionRequestLike => ({
    toolCall: { title: 'php artisan migrate --force', name: 'Bash', toolCallId: 't1' },
    options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
    ...over,
});

describe('the question', () => {
    it('is the tool call’s own title, which is what the agent asked about', () => {
        const approval = approvalFrom(request());
        expect(approval?.question).toBe('php artisan migrate --force');
    });

    it('falls back to the tool NAME when there is no title', () => {
        const approval = approvalFrom(request({ toolCall: { name: 'Bash', toolCallId: 't1' } }));
        expect(approval?.question).toBe('Bash');
    });

    it('is REFUSED when the call describes nothing at all', () => {
        /**
         * A question with no subject cannot be answered responsibly. "Allow?" with nothing
         * after it asks somebody to approve an action neither of you can name — and the whole
         * point of an approval is that a human decided about a specific thing.
         */
        expect(approvalFrom(request({ toolCall: {} }))).toBeNull();
    });
});

describe('the options', () => {
    it('keeps the provider’s own ids and labels', () => {
        // The ids go back over the wire verbatim. Renaming them here would be inventing a
        // protocol value, and ACP's options are provider-defined.
        expect(approvalFrom(request())?.options).toEqual([
            { id: 'allow', label: 'Allow', tone: 'ok' },
            { id: 'deny', label: 'Deny', tone: 'bad' },
        ]);
    });

    it('DROPS an option whose id cannot be read, rather than rendering a dead button', () => {
        /**
         * Offering a button that resolves to nothing is worse than offering none: the human
         * presses it, the agent stays parked, and the UI has already said the question was
         * answered. A dropped option is at least visibly absent.
         */
        const approval = approvalFrom(
            request({
                options: [
                    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                    { name: 'Mystery', kind: 'allow_always' },
                ],
            }),
        );

        expect(approval?.options.map((o) => o.id)).toEqual(['allow']);
    });

    it('is REFUSED when NO option survives — a question with no answers is not a question', () => {
        // Rendering a question with no buttons leaves somebody staring at something they
        // cannot resolve, on a surface whose entire job is resolving things.
        expect(approvalFrom(request({ options: [{ name: 'Mystery' }] }))).toBeNull();
        expect(approvalFrom(request({ options: [] }))).toBeNull();
    });

    it('labels an option from its id when the provider sent no name', () => {
        /**
         * An id is at least the provider's own word for it. A blank button is not.
         *
         * **Neutral, not `ok`** — and the first draft of this expectation got that wrong in the
         * precise way the module exists to prevent. The id here READS as `allow_always`, but
         * there is no `kind` field, and inferring a colour from an id is the same mistake as
         * inferring it from a label: the id is a provider-chosen string that may mean anything.
         */
        const approval = approvalFrom(request({ options: [{ optionId: 'allow_always' }] }));
        expect(approval?.options).toEqual([{ id: 'allow_always', label: 'allow_always', tone: 'neutral' }]);

        // POSITIVE CONTROL: the same id WITH a declared kind does get a tone.
        expect(approvalFrom(request({ options: [{ optionId: 'allow_always', kind: 'allow_always' }] }))?.options[0]?.tone)
            .toBe('ok');
    });
});

describe('tone — read from the protocol’s KIND, never guessed from the label', () => {
    it('reads allow and reject kinds', () => {
        const approval = approvalFrom(
            request({
                options: [
                    { optionId: 'a', name: 'Yes', kind: 'allow_always' },
                    { optionId: 'b', name: 'No', kind: 'reject_always' },
                ],
            }),
        );
        expect(approval?.options.map((o) => o.tone)).toEqual(['ok', 'bad']);
    });

    it('is NEUTRAL for a kind it does not recognise', () => {
        /**
         * Guessing from the label is the trap. A provider could ship an option called
         * "Allow once and remember" that actually denies, or one in another language, and a
         * substring match on "allow" would paint a deny button green — which is the single
         * most dangerous way for this surface to be wrong.
         *
         * Unknown kind, neutral tone. The reader sees the provider's own words and no
         * colour-coded claim about what they mean.
         */
        const approval = approvalFrom(
            request({ options: [{ optionId: 'x', name: 'Allow once and remember', kind: 'something_new' }] }),
        );
        expect(approval?.options[0]?.tone).toBe('neutral');
    });

    it('does not infer tone from a label that merely CONTAINS allow or deny', () => {
        // The same trap, stated as a test so nobody adds the "helpful" heuristic later.
        const approval = approvalFrom(request({ options: [{ optionId: 'x', name: 'Deny and allow next time' }] }));
        expect(approval?.options[0]?.tone).toBe('neutral');
    });

    it('COUNTS that no unrecognised kind is ever coloured', () => {
        const kinds = ['something_new', 'allow_maybe', '', 'ALLOW_ONCE', 'reject', undefined];
        const tones = kinds.map(
            (kind) =>
                approvalFrom(request({ options: [{ optionId: 'x', name: 'x', ...(kind === undefined ? {} : { kind }) }] }))
                    ?.options[0]?.tone,
        );

        expect(tones.filter((t) => t !== 'neutral')).toEqual([]);

        // POSITIVE CONTROL: the recognised kinds DO get a tone, so neutral is a reading.
        expect(approvalFrom(request())?.options.map((o) => o.tone)).toEqual(['ok', 'bad']);
    });
});
