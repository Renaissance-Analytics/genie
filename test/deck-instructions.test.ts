import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GENIE_SKILLS } from '../src/main/agent-skills.js';

/**
 * A DECK ITEM IS THE WHOLE INSTRUCTION (the owner, 2026-10-18: "The deck should tell me what to do, not point me to a
 * file … include full instructions to the user, don't leave any step details out"). A person item lands in the person's
 * Deck; an agent that wrote "paste the line from <file>" made them go and find it. The rule lives in ONE place: the
 * `lists` tool's own description, which reaches every agent through Genie's MCP tool list — never repeated in the
 * skills or the protocol file (the owner: "we should not be bloating the system prompt chain with duplicate info").
 */
const RULE = 'include full instructions to the user, don’t leave any step details out';

describe('the rule, once', () => {
    it('the lists tool’s description says a person item is the full instruction, in the Deck, never a pointer to a file', () => {
        const src = readFileSync('src/main/mcp-tools.ts', 'utf8');
        const line = src.split(/\r?\n/).find((l) => l.includes('Two lists per workspace'))!;
        expect(line).toContain('Deck');
        expect(line).toContain(RULE);
        expect(line).toMatch(/never a pointer to a file/);
    });

    it('CONTROL: not repeated in the skills — the tool description already reaches the agent', () => {
        for (const s of GENIE_SKILLS) expect(s.body, s.name).not.toContain(RULE);
    });
});
