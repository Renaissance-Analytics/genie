import { describe, expect, it } from 'vitest';
import { shuttleEnabledFor } from '../enabled';

/**
 * WHETHER GENIE SERVES AGENTS THROUGH THE SHUTTLE (genie#346).
 *
 * It is not a setting. beta.324 shipped it as an opt-in switch, off by default,
 * and the next upgrade dropped every agent's connection again. The owner: "I never
 * even told you to make it an option" — keeping agents connected through an update
 * is how Genie works, not something a person turns on.
 *
 * The one exception is the E2E suite: every spec there shares one profile and one
 * MCP port, and a detached shuttle left behind by one spec would answer the next
 * spec's agents. So a spec opts in per launch, and the spec that proves the swap
 * does exactly that.
 */
describe('shuttleEnabledFor', () => {
    it('is ALWAYS on in the product — nothing in the environment turns it off', () => {
        expect(shuttleEnabledFor({ e2e: false, env: {} })).toBe(true);
        expect(shuttleEnabledFor({ e2e: false, env: { GENIE_E2E_MCP_SHUTTLE: '0' } })).toBe(true);
        expect(shuttleEnabledFor({ e2e: false, env: { GENIE_MCP_SHUTTLE: 'off' } })).toBe(true);
    });

    it('is opt-in per launch inside E2E, so one spec\'s shuttle cannot serve the next spec', () => {
        expect(shuttleEnabledFor({ e2e: true, env: {} })).toBe(false);
        expect(shuttleEnabledFor({ e2e: true, env: { GENIE_E2E_MCP_SHUTTLE: '1' } })).toBe(true);
    });
});
