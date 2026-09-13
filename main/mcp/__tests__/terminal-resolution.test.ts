import { describe, expect, it } from 'vitest';
import { AMBIGUOUS_TERMINAL_MESSAGE, resolveTerminal, type EndpointRoute } from '../terminal-resolution';

/**
 * WHICH TERMINAL A CALL ACTS FOR — one rule, shared by the two things that answer
 * MCP on this machine.
 *
 * Genie's in-process server (`server.ts`) and the MCP shuttle (genie#346) must
 * resolve a call's terminal identically. The spec says "exactly as server.ts does
 * today", and the only way that stays true after the next edit to either is for
 * both to call this. `server.test.ts` still proves the rule over real HTTP; this
 * proves the rule itself, without a server.
 *
 * The rule (genie#17): an explicit `terminalId` must be a MEMBER of the endpoint's
 * workspace; exactly one terminal is not a guess; anything else is refused, never
 * resolved to "whichever terminal was last active" — because `agentinbox` mints an
 * agent's durable identity onto whatever this returns.
 */

const members = (map: Record<string, string[]>) => (workspaceId: string) => map[workspaceId] ?? [];
const workspace = (workspaceId: string): EndpointRoute => ({ kind: 'workspace', workspaceId });

describe('resolveTerminal', () => {
    it('resolves a legacy per-terminal endpoint to its own terminal, whatever the argument says', () => {
        const route: EndpointRoute = { kind: 'terminal', terminalId: 't-legacy' };
        expect(resolveTerminal(route, members({}), undefined)).toBe('t-legacy');
        expect(resolveTerminal(route, members({}), 't-other')).toBe('t-legacy');
    });

    it('honours an explicit terminalId that is a member of the workspace', () => {
        expect(resolveTerminal(workspace('w'), members({ w: ['t-a', 't-b'] }), 't-b')).toBe('t-b');
    });

    it('refuses an explicit terminalId from ANOTHER workspace rather than landing on a local one', () => {
        expect(resolveTerminal(workspace('w'), members({ w: ['t-a'], x: ['t-x'] }), 't-x')).toBeNull();
    });

    it('resolves the only terminal when none is named — one is not a guess', () => {
        expect(resolveTerminal(workspace('w'), members({ w: ['t-only'] }), undefined)).toBe('t-only');
    });

    it('REFUSES when several terminals exist and none is named', () => {
        expect(resolveTerminal(workspace('w'), members({ w: ['t-a', 't-b'] }), undefined)).toBeNull();
    });

    it('resolves nothing for an unknown endpoint', () => {
        expect(resolveTerminal(null, members({ w: ['t-a'] }), 't-a')).toBeNull();
    });

    it('tells the agent the environment variable that fixes the refusal', () => {
        expect(AMBIGUOUS_TERMINAL_MESSAGE).toContain('GENIE_TERMINAL_ID');
        expect(AMBIGUOUS_TERMINAL_MESSAGE).toContain('Genie will not guess');
    });
});
