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

const render = (questions: PendingQuestionSpec[], listItems: Array<{ id: string; text: string; agentName?: string }> = []) => {
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
        expect(render([single()])).not.toContain('>Open<');
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

    it('offers Open instead of buttons', () => {
        const html = render([multi]);
        expect(html).toContain('>Open<');
    });

    it('does NOT render the first part options — that would be a partial answer', () => {
        // The whole reason the refusal exists. Clicking "yes" here would unblock the agent
        // as though the human had decided both parts.
        const html = render([multi]);
        expect(html).not.toContain('>yes<');
        expect(html).not.toContain('>no<');
    });

    it('offers Open for a free-text question too', () => {
        const prose = single({ questions: [{ header: 'Why', question: 'why?', options: [] }] });
        expect(render([prose])).toContain('>Open<');
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
