import { describe, expect, it } from 'vitest';
import { AGENT_DETAIL_CACHE_MAX_BYTES, AgentDetailCache, detailBytes } from '../src/renderer/agent-detail.js';

/*
 * THE AGENT-DETAIL CACHE IS BOUNDED BY BYTES, NOT ONLY BY COUNT (#386 review; the owner's page ended out of memory on
 * 2026-11-06). It kept 24 details, and each holds an agent's rows — up to the history read's 4 MiB — so 24 of them could
 * hold about 96 MiB of rows plus their objects. It now keeps at most {@link AGENT_DETAIL_CACHE_MAX_BYTES} of rows as well,
 * the least recently shown going first, and never the one being shown.
 */
type Row = { at: number; event: { kind: 'message'; text: string } };
type D = { agent: { id: string }; rows: Row[] };
const MIB = 1024 * 1024;
const detail = (id: string, mib: number): D => ({ agent: { id }, rows: [{ at: 1, event: { kind: 'message', text: 'x'.repeat(Math.floor(mib * MIB) - 64) } }] });

describe('the agent-detail cache, by bytes', () => {
    it('24 details of 4 MiB each: the cache stays under its byte cap, the newest kept, the oldest gone first', () => {
        const cache = new AgentDetailCache<D>();
        for (let i = 0; i < 24; i++) cache.remember(`agent_${i}`, detail(`agent_${i}`, 4));
        expect(cache.bytes()).toBeLessThanOrEqual(AGENT_DETAIL_CACHE_MAX_BYTES);
        expect(cache.show('agent_23').resolved).toBe(true);
        expect(cache.show('agent_0').resolved).toBe(false);
        // CONTROL: the count cap still holds, and what fits is kept.
        expect(cache.size()).toBeLessThanOrEqual(24);
        expect(cache.size()).toBeGreaterThan(5);
    });

    it('the one being shown is never evicted, even when it alone is past the cap', () => {
        const cache = new AgentDetailCache<D>();
        cache.remember('agent_a', detail('agent_a', 1));
        cache.remember('agent_big', detail('agent_big', 60));
        expect(cache.show('agent_big').resolved).toBe(true);
        expect(cache.show('agent_a').resolved).toBe(false);
    });

    it('a detail kept under its name and its id counts once', () => {
        const cache = new AgentDetailCache<D>();
        const d = detail('agent_a', 2);
        cache.remember('atlas', d);
        expect(cache.show('atlas').resolved).toBe(true);
        expect(cache.show('agent_a').resolved).toBe(true);
        expect(cache.bytes()).toBe(detailBytes(d));
    });
});
