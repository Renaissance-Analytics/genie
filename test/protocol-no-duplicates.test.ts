import { describe, expect, it } from 'vitest';
import { sharedProtocol } from '../src/core/genie-protocol.js';

/**
 * THE PROTOCOL DOES NOT REPEAT THE TOOLS (the owner, 2026-10-18: "if these descriptions are provided by the genie mcp
 * which already gets put into agent context on run, then we should not be bloating the system prompt chain with
 * duplicate info"). `shared.md` is read into every agent's instructions through CLAUDE.md / AGENTS.md, and it used to
 * copy every tool's full description — which the MCP tool list already gives the agent. It names the tools once and
 * says where their descriptions are.
 */
const TOOLS = [
    { name: 'imDone', description: 'Signal that you have finished in THIS terminal. A long description the MCP list carries.' },
    { name: 'lists', description: 'Two lists per workspace: your own checklist and things only a PERSON can do.' },
];

describe('shared.md', () => {
    it('names each tool once and points at the tool list for what it does', () => {
        const md = sharedProtocol(TOOLS);
        expect(md).toContain('`imDone`, `lists`');
        expect(md).toMatch(/Each describes itself in your tool list/);
        expect(md.match(/`imDone`/g)!.length).toBeGreaterThanOrEqual(1);
    });

    it('carries none of their descriptions (COUNTED: zero of two)', () => {
        const md = sharedProtocol(TOOLS);
        expect(TOOLS.filter((t) => md.includes(t.description))).toEqual([]);
    });

    it('CONTROL: with no tools listening it still says so', () => {
        expect(sharedProtocol([])).toMatch(/not listening right now/);
    });
});
