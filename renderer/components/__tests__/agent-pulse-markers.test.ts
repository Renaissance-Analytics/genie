import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentPulse, AgentPulseMarkerLayer } from '../Master/AgentPulse';
import {
    AGENT_PULSE_MARKER_KINDS,
    type AgentPulseMarkerBucket,
} from '../../../main/terminal/agent-pulse';

/**
 * The workspace-row activity markers, rendered.
 *
 * The whole reason this layer exists is that the sparkline draws pty BYTES and
 * every moment it marks happens with none: a delivery is a broker event, a read
 * and a reply are MCP calls. So the case that matters most here is the one the
 * sparkline itself refuses to draw — a flat ring — and the first test pins it.
 */

const BUCKETS = 60;

/** A marker ring with `bucket` in the newest slot and nothing anywhere else. */
function ringWith(bucket: AgentPulseMarkerBucket, at = BUCKETS - 1): (AgentPulseMarkerBucket | null)[] {
    const ring = new Array<AgentPulseMarkerBucket | null>(BUCKETS).fill(null);
    ring[at] = bucket;
    return ring;
}

const flat = (): number[] => new Array<number>(BUCKETS).fill(0);
const busy = (): number[] => new Array<number>(BUCKETS).fill(0).map((_, i) => (i % 3) * 40);

const render = (el: React.ReactElement): string => renderToStaticMarkup(el);

describe('markers draw on a workspace with no terminal output at all', () => {
    it('renders a marker over a FLAT sparkline', () => {
        // ★ The load-bearing case. `AgentPulseSparkline` bails on `max <= 0`, and
        // an idle agent receiving a message moves not one byte — so if the marker
        // layer inherited that early-out, the feature would be invisible in
        // exactly the situation it was built for.
        const html = render(
            React.createElement(AgentPulse, {
                ring: flat(),
                markers: ringWith({ delivered: 1 }),
                active: false,
            }),
        );
        expect(html).toContain('data-marker="delivered"');
    });

    it('renders nothing at all when there is neither output nor a marker', () => {
        // Positive control for the above: an empty pulse really does render
        // nothing, so the marker in the previous test is the marker and not some
        // wrapper the component always emits.
        const html = render(
            React.createElement(AgentPulse, { ring: flat(), markers: null, active: false }),
        );
        expect(html).toBe('');
    });

    it('still draws the sparkline when there ARE bytes', () => {
        const html = render(
            React.createElement(AgentPulse, { ring: busy(), markers: null, active: true }),
        );
        expect(html).toContain('agent-pulse-spark');
    });

    it('draws both layers together', () => {
        const html = render(
            React.createElement(AgentPulse, {
                ring: busy(),
                markers: ringWith({ replied: 1 }),
                active: true,
            }),
        );
        expect(html).toContain('agent-pulse-spark');
        expect(html).toContain('data-marker="replied"');
    });
});

describe('every declared kind has a glyph', () => {
    it.each(AGENT_PULSE_MARKER_KINDS)('renders the %s marker', (kind) => {
        // Table-driven against the model's OWN list, so adding a sixth kind
        // fails here until its row exists rather than rendering an invisible gap.
        const html = render(
            React.createElement(AgentPulseMarkerLayer, { markers: ringWith({ [kind]: 1 }) }),
        );
        expect(html).toContain(`data-marker="${kind}"`);
    });
});

describe('a collision in one cadence slot loses nothing', () => {
    it('stacks every KIND that landed in the same second', () => {
        const html = render(
            React.createElement(AgentPulseMarkerLayer, {
                markers: ringWith({ delivered: 1, checked: 1, replied: 1 }),
            }),
        );
        // All three are present — none is displaced by the others.
        expect(html).toContain('data-marker="delivered"');
        expect(html).toContain('data-marker="checked"');
        expect(html).toContain('data-marker="replied"');
    });

    it('stacks them in the model order, so a slot reads the same way every time', () => {
        const html = render(
            React.createElement(AgentPulseMarkerLayer, {
                // Declared out of order on purpose.
                markers: ringWith({ replied: 1, delivered: 1 }),
            }),
        );
        expect(html.indexOf('data-marker="delivered"')).toBeLessThan(
            html.indexOf('data-marker="replied"'),
        );
    });

    it('says HOW MANY when one kind repeats inside a single second', () => {
        // A 1s slot is a few pixels wide, so three deliveries draw one diamond.
        // The count is what keeps the other two from being lost rather than
        // merely undrawn — the glyph carries it, so the collapse is legible.
        const html = render(
            React.createElement(AgentPulseMarkerLayer, { markers: ringWith({ delivered: 3 }) }),
        );
        expect(html).toContain('data-count="3"');
        expect(html).toMatch(/3 delivered/i);
    });

    it('does not claim a count for a single occurrence', () => {
        const html = render(
            React.createElement(AgentPulseMarkerLayer, { markers: ringWith({ delivered: 1 }) }),
        );
        expect(html).toContain('data-count="1"');
        expect(html).not.toMatch(/3 delivered/i);
    });
});

describe('markers sit at the time they happened', () => {
    it('places the newest slot at the right edge and an older one to its left', () => {
        const newest = render(
            React.createElement(AgentPulseMarkerLayer, {
                markers: ringWith({ delivered: 1 }, BUCKETS - 1),
            }),
        );
        const oldest = render(
            React.createElement(AgentPulseMarkerLayer, {
                markers: ringWith({ delivered: 1 }, 0),
            }),
        );
        expect(newest).toContain('left:100%');
        expect(oldest).toContain('left:0%');
    });

    it('ignores empty slots rather than drawing a blank for each one', () => {
        const html = render(
            React.createElement(AgentPulseMarkerLayer, { markers: ringWith({ checked: 1 }) }),
        );
        expect(html.match(/data-marker=/g)).toHaveLength(1);
    });

    it('renders nothing for a ring with no markers in it', () => {
        const html = render(
            React.createElement(AgentPulseMarkerLayer, {
                markers: new Array(BUCKETS).fill(null),
            }),
        );
        expect(html).toBe('');
    });
});
