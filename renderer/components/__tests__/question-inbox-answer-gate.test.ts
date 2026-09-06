import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PendingCard } from '../Master/QuestionInboxFlyout';
import { answerGate } from '../../lib/answer-gate';
import type { PendingQuestionSpec } from '../../lib/genie';

/**
 * The question flyout's Answer control, gated on who holds control — genie#468.
 *
 * A non-controlling remote driver still SEES the host's pending questions here,
 * and should: not interrupted is not the same as not told. But it could also
 * still press Answer, and the host 423s that POST while locked. The client threw
 * the rejection away, so the button un-busied, the question stayed put, and
 * nothing was said — silence indistinguishable from success with a slow refresh.
 *
 * A control you cannot use must not look usable, and a greyed button on its own
 * is the same silence in a different costume: the REASON has to be on the page
 * next to it. The phone got this right long ago ("Locked on desktop — answering
 * is disabled"); the desktop flyout never did.
 *
 * The renderer test env has no DOM, so this renders through `react-dom/server` —
 * which runs the component and produces the markup a person would see, minus the
 * effects.
 */
const pending: PendingQuestionSpec = {
    id: 'q1',
    index: 0,
    workspaceLabel: 'genie',
    questions: [
        {
            header: 'Ship',
            question: 'Ship the release?',
            options: [{ label: 'Yes' }, { label: 'Not yet' }],
        },
    ],
};

function render(control: Parameters<typeof answerGate>[0]): string {
    return renderToStaticMarkup(
        React.createElement(PendingCard, {
            pending,
            gate: answerGate(control),
            onAnswered: () => {},
        }),
    );
}

/** The markup of the Answer button itself, so `disabled` cannot be matched off
 *  some other element on the card. */
function answerButton(html: string): string {
    const at = html.indexOf('data-testid="question-answer"');
    expect(at, 'the Answer button is not on the card at all').toBeGreaterThan(-1);
    const open = html.lastIndexOf('<button', at);
    return html.slice(open, html.indexOf('</button>', at));
}

describe('the Answer control while another window holds control (genie#468)', () => {
    it('offers Answer when this window holds control', () => {
        // POSITIVE CONTROL. "The button is disabled while locked" is also true of
        // a card that renders no button at all, and of one that disables it
        // always — both would ship a flyout nobody can answer from.
        const html = render({ locked: false });
        expect(answerButton(html)).not.toContain('disabled');
        expect(html).toContain('Answer');
        // No refusal is claimed when there is nothing refusing.
        expect(html).not.toContain('question-answer-blocked');
    });

    it('disables Answer while somebody else holds control', () => {
        expect(answerButton(render({ locked: true }))).toContain('disabled');
    });

    it('says WHY, on the card, rather than leaving a dead button', () => {
        const html = render({ locked: true });
        expect(html).toContain('question-answer-blocked');
        expect(html).toMatch(/control/i);
    });

    it('names the person holding the baton', () => {
        const html = render({ locked: true, holderName: 'Wish Born', holderEmoji: '🦊' });
        expect(html).toContain('Wish Born');
    });

    it('still SHOWS the question while it cannot be answered', () => {
        // The gate must not turn into a second, quieter way of hiding the host's
        // questions from a view-only driver — that is a different product.
        const html = render({ locked: true });
        expect(html).toContain('Ship the release?');
        expect(html).toContain('Not yet');
    });
});
