import { describe, expect, it } from 'vitest';
import { asAgentId, asAgentRef, mintAgentId, OS_AGENT_NAME } from '../src/core/identity.js';

/**
 * THE ONE NAME THAT IS ALSO AN ADDRESS. The rail links `genie://agent/genie` by NAME (the OS agent's id is
 * minted on first boot). The renderer→main boundary narrows ids with `asAgentId`, which rejected the name
 * before the registry could resolve it — the Windows VM smoke (2026-10-11 22:30, check 43) timed out on
 * "No agent is registered as genie" with the registry alias already in place. `asAgentRef` is what the
 * boundary narrows with: a minted id, or exactly the OS agent's name, and nothing else.
 */
describe('asAgentRef', () => {
    it('accepts a minted id, exactly as asAgentId does', () => {
        const id = mintAgentId();
        expect(asAgentRef(id)).toBe(id);
        expect(asAgentId(id)).toBe(id);
    });

    it("accepts the OS agent's name and returns it unchanged", () => {
        expect(OS_AGENT_NAME).toBe('genie');
        expect(asAgentRef('genie')).toBe('genie');
    });

    it('CONTROL: refuses everything else — a near-miss name, a path, an empty string, a malformed id', () => {
        for (const bad of ['Genie', 'genie ', 'agent/genie', '', 'agent_zz', 'agent_' + 'a'.repeat(31)]) expect(asAgentRef(bad), bad).toBeNull();
    });
});
