import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentLanes } from '../Master/AgentLanes';
import { agentLanes } from '../../lib/agent-lanes';
import type { StreamRow } from '../../lib/agent-stream';

/**
 * That the lanes STRIP draws what the model says.
 *
 * The arithmetic is tested in `agent-lanes.test.ts`; this asserts the render carries it,
 * because a position computed correctly and then dropped on the floor is indistinguishable
 * from one computed wrong — and `AgentStream.tsx` carried a comment describing this whole
 * feature for a release while no implementation existed.
 */

const row = (over: Partial<StreamRow> & { id: string }): StreamRow => ({
    type: 'event',
    kind: 'tool',
    main: 'something',
    meta: null,
    at: 1_000,
    live: false,
    level: null,
    ...over,
});

const render = (rows: StreamRow[], range: { from: number; to: number } | null = null): string =>
    renderToStaticMarkup(
        React.createElement(AgentLanes, { view: agentLanes(rows), range, onRange: () => {} }),
    );

describe('the lanes strip', () => {
    it('POSITIVE CONTROL: it renders all four lanes', () => {
        const html = render([row({ id: 'a', at: 100 })]);
        for (const label of ['Messages', 'Thoughts', 'Tools', 'Edits']) {
            expect(html).toContain(label);
        }
    });

    it('places a tick at its position in the span', () => {
        const html = render([
            row({ id: 'first', at: 0 }),
            row({ id: 'mid', at: 50 }),
            row({ id: 'last', at: 100 }),
        ]);
        expect(html).toContain('data-tick="first"');
        expect(html).toContain('left:0%');
        expect(html).toContain('left:50%');
        expect(html).toContain('left:100%');
    });

    it('SAYS SO when nothing can be placed in time', () => {
        // Four empty tracks would read as "nothing happened". The truth is that Genie has no
        // times for these rows, which is a different statement with a different remedy.
        const html = render([row({ id: 'a', at: null })]);
        expect(html).toContain('No times reported');
        expect(html).not.toContain('lanes-tick');
    });

    it('draws the selection band for an active range', () => {
        const html = render(
            [row({ id: 'a', at: 0 }), row({ id: 'b', at: 100 })],
            { from: 0, to: 50 },
        );
        expect(html).toContain('lanes-selection');
        expect(html).toContain('Clear range');
    });

    it('offers no Clear when there is no range', () => {
        // A control that is always present but only sometimes means anything trains people
        // to ignore it.
        expect(render([row({ id: 'a', at: 0 })])).not.toContain('Clear range');
    });

    it('reports rows it could not place rather than hiding the discrepancy', () => {
        const html = render([row({ id: 'a', at: 0 }), row({ id: 'u', at: null })]);
        expect(html).toContain('1 unplaced');
    });
});
