import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PendingNudgeNotice from '../Master/PendingNudgeNotice';

/**
 * The banner over a terminal whose notice could not be typed in (genie#333).
 *
 * The owner's screenshot is the specification here: a "Send nudge" button that
 * did nothing, above an input box that was visibly empty, under a sentence
 * insisting it was not. The button was not broken — it re-asked a question whose
 * answer could never change.
 *
 * So the banner has two states, and the second one exists because the first can
 * be WRONG: Genie's idea of the box is built from the bytes going in, and a TUI
 * that clears its own composer leaves that idea stale forever. A refusal hands
 * the question to the person looking at the box, and says what answering yes
 * will cost.
 */
const render = (needsClear: boolean): string =>
    renderToStaticMarkup(
        React.createElement(PendingNudgeNotice, {
            terminalId: 't-1',
            needsClear,
            onSend: () => {},
        }),
    );

describe('the parked-nudge banner', () => {
    it('offers a plain send while Genie has not been contradicted', () => {
        const html = render(false);
        expect(html).toContain('Nudge waiting');
        expect(html).toContain('Your input is untouched');
        expect(html).toContain('>Send nudge<');
        // POSITIVE CONTROL: nothing offers to destroy the box until a send has
        // actually been refused.
        expect(html).not.toContain('Clear input');
    });

    it('offers to clear the box once a send has been refused', () => {
        const html = render(true);
        expect(html).toContain('>Clear input &amp; send<');
        // It names the uncertainty rather than asserting something the person
        // can see is false, and it names the cost before they pay it.
        expect(html).toContain('cannot tell whether your input box is empty');
        expect(html).toContain('discards anything typed there');
        expect(html).not.toContain('Your input is untouched');
    });

    it('keeps the test id the notice is found by in both states', () => {
        for (const needsClear of [false, true]) {
            expect(render(needsClear)).toContain('data-testid="agentinbox-incoming"');
        }
    });
});

describe('what the button asks for', () => {
    /** Capture the options the banner would send for a given state. */
    function clickedWith(needsClear: boolean): { clearInput?: boolean } | undefined {
        let seen: { clearInput?: boolean } | undefined;
        let called = false;
        const el = React.createElement(PendingNudgeNotice, {
            terminalId: 't-1',
            needsClear,
            onSend: (_id: string, options?: { clearInput?: boolean }) => {
                called = true;
                seen = options;
            },
        });
        // The server renderer runs the component but never dispatches events, so
        // reach the handler the way the button would.
        const rendered = (el.type as (p: unknown) => React.ReactElement)(el.props);
        const button = findButton(rendered);
        button.props.onClick();
        expect(called).toBe(true);
        return seen;
    }

    function findButton(node: React.ReactElement): React.ReactElement<{ onClick: () => void }> {
        const children = React.Children.toArray(
            (node.props as { children?: React.ReactNode }).children,
        );
        for (const child of children) {
            if (!React.isValidElement(child)) continue;
            if (child.type === 'button') {
                return child as React.ReactElement<{ onClick: () => void }>;
            }
            const nested = tryFind(child);
            if (nested) return nested;
        }
        throw new Error('the banner rendered no button');
    }

    function tryFind(
        node: React.ReactElement,
    ): React.ReactElement<{ onClick: () => void }> | null {
        try {
            return findButton(node);
        } catch {
            return null;
        }
    }

    it('asks for a plain send first — never to clear anything', () => {
        // POSITIVE CONTROL, and the one that matters: the first click must not
        // be able to destroy a draft. Genie's refusal is what earns the clear.
        expect(clickedWith(false)).toBeUndefined();
    });

    it('asks for the kill-line only after the refusal', () => {
        expect(clickedWith(true)).toEqual({ clearInput: true });
    });
});
