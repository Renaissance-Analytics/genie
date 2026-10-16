import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AgentDetailCache } from '../src/renderer/agent-detail.js';

/**
 * SWITCHING AGENTS DOES NOT BLANK THE CHAT (the owner, 2026-10-16: "the whole screen and chat ux redraws and
 * everything flashes" on clicking an agent tab). The detail hook reset to `null` on every switch — on purpose, so a
 * frame never showed the previous agent's rows under the new one's name — and the chat emptied and refilled.
 *
 * Both rules hold with a cache keyed by agent: a switch shows THAT agent's last detail at once (no empty frame), and
 * never another agent's (an agent not seen yet shows nothing, as before). The live detail replaces it as it lands.
 */

type D = { agent: { id: string }; rows: string[] };
const detail = (id: string, ...rows: string[]): D => ({ agent: { id }, rows });

describe('the detail an agent switch shows first', () => {
    it("A → B → A: A's last detail is shown at once on the way back", () => {
        const cache = new AgentDetailCache<D>();
        const a = detail('agent_a', 'hello from a');
        cache.remember('agent_a', a);
        expect(cache.show('agent_b')).toEqual({ detail: null, resolved: false });
        cache.remember('agent_b', detail('agent_b', 'hello from b'));
        expect(cache.show('agent_a')).toEqual({ detail: a, resolved: true });
    });

    it("CONTROL: an agent never seen shows nothing — never another agent's rows", () => {
        const cache = new AgentDetailCache<D>();
        cache.remember('agent_a', detail('agent_a', 'a'));
        const shown = cache.show('agent_b');
        expect(shown.detail).toBeNull();
        expect(shown.resolved).toBe(false);
    });

    it('an agent reached by NAME is found again by its name and by its id, as the one agent', () => {
        const cache = new AgentDetailCache<D>();
        const moic = detail('agent_m', 'm');
        cache.remember('moic', moic);
        expect(cache.show('moic').detail).toBe(moic);
        expect(cache.show('agent_m').detail).toBe(moic);
    });

    it('the newest detail wins, and the cache is bounded (least recently shown goes first)', () => {
        const cache = new AgentDetailCache<D>(3);
        cache.remember('agent_1', detail('agent_1', 'old'));
        const newer = detail('agent_1', 'new');
        cache.remember('agent_1', newer);
        expect(cache.show('agent_1').detail).toBe(newer);
        cache.remember('agent_2', detail('agent_2'));
        cache.remember('agent_3', detail('agent_3'));
        cache.show('agent_1'); // agent_1 is now the most recently shown; agent_2 is the least
        cache.remember('agent_4', detail('agent_4'));
        expect(cache.show('agent_2').detail).toBeNull();
        expect(cache.show('agent_1').detail).toBe(newer);
    });
});

describe('the hook uses it', () => {
    it("useAgentDetail opens a switch with the cache's detail, not an empty one, and remembers what lands", () => {
        const app = readFileSync('src/renderer/App.tsx', 'utf8').replace(/\r\n/g, '\n');
        const hook = app.slice(app.indexOf('function useAgentDetail('), app.indexOf('function useRemote('));
        expect(hook.length).toBeGreaterThan(200);
        expect(hook).toMatch(/setState\(detailCache\.show\(agentId\)\)/);
        // Every detail that lands is remembered — the first answer and every live update (counted).
        expect(hook.match(/detailCache\.remember\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    });
});
