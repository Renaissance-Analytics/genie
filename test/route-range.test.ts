import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute } from '../src/core/route.js';

/**
 * THE RANGE RIDES THE AGENT ROUTE — `genie://agent/<id>?tab=stream&range=<from>-<to>`.
 *
 * §4.2: "the range is kept in the URL". Same reasons as `lane` and `at`: a filtered view is a
 * link, survives a refresh, and an agent can hand a human the forty seconds that matter.
 */

describe('a range on the agent route', () => {
    it('parses and formats, round-tripping exactly', () => {
        const route = 'genie://agent/kai?tab=stream&range=1760000000000-1760000040000';
        const parsed = parseRoute(route);

        expect(parsed).toMatchObject({ surface: 'agent', agentId: 'kai', range: { from: 1_760_000_000_000, to: 1_760_000_040_000 } });
        expect(formatRoute(parsed)).toBe(route);
    });

    it('is null when absent — not filtering', () => {
        expect(parseRoute('genie://agent/kai?tab=stream')).toMatchObject({ range: null });
    });

    it('DROPS a malformed range and keeps the rest of the route', () => {
        // A stale or hand-edited link must still open the agent. The lane and anchor beside it
        // survive — dropping the whole query over one bad parameter would lose the handoff.
        const parsed = parseRoute('genie://agent/kai?tab=stream&lane=edits&range=garbage&at=ev_1');
        expect(parsed).toMatchObject({ surface: 'agent', agentId: 'kai', lane: 'edits', at: 'ev_1', range: null });
        expect(formatRoute(parsed)).not.toContain('range=');
    });

    it('sits beside the chat modifier like any other agent parameter', () => {
        const route = 'genie://agent/kai?tab=stream&range=10-40&chat=kai';
        expect(formatRoute(parseRoute(route))).toBe(route);
    });
});
