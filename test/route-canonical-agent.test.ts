import { describe, expect, it } from 'vitest';
import { canonicalAgentRoute } from '../src/core/route.js';

/**
 * AN AGENT ROUTE BY NAME SETTLES ON THE ID. `genie://agent/genie` resolves to the OS agent, but every
 * live channel (`genie:agent-changed:<id>`) and every link the Agent view builds is keyed by the minted
 * id — a page left at the name would never update. Once the detail says who it is, the renderer replaces
 * the route with the canonical one, keeping tab, lane and range; a route already canonical is left alone.
 */
describe('canonicalAgentRoute', () => {
    it('swaps the name for the resolved id and keeps the query', () => {
        expect(canonicalAgentRoute('genie://agent/genie?tab=stream', 'agent_' + '1'.repeat(32))).toBe(`genie://agent/agent_${'1'.repeat(32)}?tab=stream`);
        expect(canonicalAgentRoute('genie://agent/genie', 'agent_' + '2'.repeat(32))).toBe(`genie://agent/agent_${'2'.repeat(32)}?tab=stream`);
    });

    it('CONTROL: a route already on the id, or not an agent route, yields null — nothing to replace', () => {
        const id = 'agent_' + '3'.repeat(32);
        expect(canonicalAgentRoute(`genie://agent/${id}?tab=files`, id)).toBeNull();
        expect(canonicalAgentRoute('genie://dashboard?group=workspace', id)).toBeNull();
        expect(canonicalAgentRoute('genie://deck', id)).toBeNull();
    });
});
