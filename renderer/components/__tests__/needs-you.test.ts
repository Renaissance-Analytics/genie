import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NeedsYou } from '../Master/NeedsYou';
import { attentionItems } from '../../lib/attention-queue';
import type { PendingQuestionSpec } from '../../lib/genie';

/**
 * The band that answers "does anything need me", and lets it be answered here.
 *
 * The assertions that matter are about the refusal: a question that cannot be fully
 * answered inline must offer a DIFFERENT affordance, not a disabled one — and it must not
 * render the first sub-question's buttons, which would submit a partial answer and tell
 * the agent the human had decided.
 */

const NOW = 10_000_000;

const single = (over: Partial<PendingQuestionSpec> = {}): PendingQuestionSpec => ({
    id: 'q1',
    index: 0,
    createdAt: NOW - 120_000,
    questions: [
        {
            header: 'Migrate or dual-write?',
            question: 'Which way for the pulse ring?',
            options: [{ label: 'Dual-write' }, { label: 'Migrate now' }],
        },
    ],
    ...over,
});

const render = (
    questions: PendingQuestionSpec[],
    listItems: Array<{ id: string; text: string; agentName?: string }> = [],
    props: Record<string, unknown> = {},
) => {
    const items = attentionItems({ questions, listItems });
    const byId = new Map(questions.map((q) => [q.id, q]));
    return renderToStaticMarkup(
        React.createElement(NeedsYou, {
            items,
            questionsById: byId,
            now: NOW,
            onAnswerOption: () => {},
            onOpenQuestion: () => {},
            onResolveListItem: () => {},
            ...props,
        }),
    );
};

describe('a question that CAN be answered here', () => {
    it('renders its actual options as buttons', () => {
        const html = render([single()]);
        expect(html).toContain('Dual-write');
        expect(html).toContain('Migrate now');
    });

    it('does not offer Open as well, which would be two ways to do one thing', () => {
        expect(render([single()])).not.toContain('>Answer<');
    });

    it('shows how long it has been waiting', () => {
        expect(render([single()])).toContain('2m');
    });

    it('marks it blocking, because an agent has stopped behind it', () => {
        expect(render([single()])).toContain('blocking');
    });
});

describe('a question that must NOT be answered here', () => {
    const multi = single({
        questions: [
            { header: 'A', question: 'a?', options: [{ label: 'yes' }] },
            { header: 'B', question: 'b?', options: [{ label: 'no' }] },
        ],
    });

    it('offers ANSWER instead of buttons — the form is on the row now', () => {
        const html = render([multi]);
        expect(html).toContain('>Answer<');
    });

    it('does NOT render the first part options — that would be a partial answer', () => {
        // The whole reason the refusal exists. Clicking "yes" here would unblock the agent
        // as though the human had decided both parts.
        const html = render([multi]);
        expect(html).not.toContain('>yes<');
        expect(html).not.toContain('>no<');
    });

    it('offers ANSWER for a free-text question too', () => {
        const prose = single({ questions: [{ header: 'Why', question: 'why?', options: [] }] });
        expect(render([prose])).toContain('>Answer<');
    });

    it('offers Open for a question forwarded from another host', () => {
        // It is answered on its own host; resolving the local copy would leave the real one
        // waiting.
        expect(render([single({ remoteHost: 'studio' })])).toContain('>Open<');
    });
});

describe('a list item', () => {
    it('offers all three outcomes', () => {
        const html = render([], [{ id: 'l1', text: 'Rotate the GH token', agentName: 'kai' }]);
        expect(html).toContain('Done');
        expect(html).toContain('Back to kai');
        expect(html).toContain('Won');
    });

    it('names the agent in the throw-back, because resolving NUDGES it', () => {
        const html = render([], [{ id: 'l1', text: 'x', agentName: 'vale' }]);
        expect(html).toContain('Back to vale');
    });

    it('says throw back plainly when no agent is named', () => {
        const html = render([], [{ id: 'l1', text: 'x' }]);
        expect(html).toContain('Throw back');
    });

    it('is NOT marked blocking — a UserList lets the agent carry on', () => {
        // Straight from the service: FTQ parks the agent, a UserList does not.
        const html = render([], [{ id: 'l1', text: 'x' }]);
        expect(html).not.toContain('blocking');
    });
});

describe('empty', () => {
    it('says nothing is waiting, and what would appear', () => {
        const html = render([]);
        expect(html).toContain('Nothing is waiting on you');
        expect(html).toContain('Questions, list items and blocked agents');
    });
});

describe('ANSWERING IN FULL, on the Deck', () => {
    /**
     * The prerequisite for P7's deletion of `QuestionInboxFlyout`.
     *
     * The plan lists that flyout as *"chrome only — all logic kept"*, and measured, that is
     * wrong: `inlineAnswerable` deliberately refuses multi-part, multi-select and free-text
     * questions, for reasons that are right — *"one click cannot express 'these two of four'…
     * a free-text question has no button that could answer it; offering one would send an empty
     * note."* So the flyout was the ONLY surface that could answer those, and deleting it as
     * written would have stranded them outright.
     *
     * `renderer/lib/question-answer.ts` owns the decisions and is tested. This asserts the one
     * thing a pure module cannot: that the form is actually ON the row.
     *
     * Expansion is a PROP rather than internal state, so the expanded shape is assertable at
     * all — the renderer's test environment has no DOM and cannot click.
     */
    const twoPart = (): PendingQuestionSpec => ({
        id: 'q2',
        index: 0,
        createdAt: NOW - 60_000,
        questions: [
            { header: 'Engine', question: 'Which engine?', options: [{ label: 'acp' }, { label: 'pty' }] },
            { header: 'Scope', question: 'For which agents?', options: [{ label: 'all' }, { label: 'one' }] },
        ],
    });

    const freeText = (): PendingQuestionSpec => ({
        id: 'q3',
        index: 0,
        createdAt: NOW - 60_000,
        questions: [{ header: 'Why', question: 'Why that way?', options: [] }],
    });

    it('offers ANSWER rather than Open, because answering happens here now', () => {
        const html = render([twoPart()]);
        expect(html).toContain('Answer');
        // "Open" sent the person to another surface to do the same job. Two ways to do one
        // thing is the duplication P7 exists to remove.
        expect(html).not.toContain('>Open<');
    });

    it('does not render the form until the row is expanded', () => {
        // A four-part form inside every collapsed row would bury the queue the band exists to
        // make readable.
        expect(render([twoPart()])).not.toContain('needs-answer-form');
    });

    it('renders EVERY part when expanded, so half an answer is not offered', () => {
        const html = render([twoPart()], [], { expandedQuestionId: 'q2' });
        expect(html).toContain('needs-answer-form');
        expect(html).toContain('Which engine?');
        expect(html).toContain('For which agents?');
        expect(html).toContain('acp');
        expect(html).toContain('one');
    });

    it('gives a free-text question a note field and no fake options', () => {
        const html = render([freeText()], [], { expandedQuestionId: 'q3' });
        expect(html).toContain('needs-answer-note');
        expect(html).toContain('Why that way?');
    });

    it('offers a note BESIDE the options, because declining every one is a real answer', () => {
        // The modal always does. An answer that takes none of the choices and explains why is
        // frequently the most useful one.
        expect(render([twoPart()], [], { expandedQuestionId: 'q2' })).toContain('needs-answer-note');
    });

    it('cannot SEND until every part is answered', () => {
        // The defect the inline path avoided by refusing these outright: the agent carries on
        // with three quarters of a decision and nothing marks it.
        const html = render([twoPart()], [], { expandedQuestionId: 'q2' });
        // Fancy wraps a button's label in a `<span>`, so the attribute and the text are not
        // adjacent — the reason this is asserted on the MARKUP at all (genie#320: a Fancy
        // component that accepts a prop and shows nothing type-checks perfectly).
        const send = html.slice(html.lastIndexOf('<button', html.indexOf('>Send<')));
        expect(send.slice(0, send.indexOf('>'))).toContain('disabled');
    });

    it('still refuses a FORWARDED question, which is answered on its own host', () => {
        // Resolving the local copy marks it done here while the real one waits forever on the
        // machine that asked.
        const html = render([{ ...twoPart(), remoteHost: 'rig-2' }], [], { expandedQuestionId: 'q2' });
        expect(html).not.toContain('needs-answer-form');
        expect(html).toContain('>Open<');
    });
});

describe('the queue says which row you are ON', () => {
    /**
     * `J/K` resolve to `queue-move` and `moveQueueFocus` decides where they land. The row has to
     * SAY so: a keyboard cursor nobody can see is worse than none, because the next keystroke
     * acts on it.
     */
    it('marks the focused row, and only that one', () => {
        const html = render([single(), single({ id: 'q9' })], [], { focusedKey: 'question:q9' });
        expect(html).toContain('data-focused="true"');
        expect(html.match(/data-focused="true"/g)).toHaveLength(1);
    });

    it('marks nothing when the keyboard has not entered the queue', () => {
        expect(render([single()])).not.toContain('data-focused="true"');
    });

    it('marks nothing for a key that is no longer in the list', () => {
        // Rows resolve and disappear. A stale key must not highlight a neighbour by accident.
        expect(render([single()], [], { focusedKey: 'question:gone' })).not.toContain(
            'data-focused="true"',
        );
    });
});
