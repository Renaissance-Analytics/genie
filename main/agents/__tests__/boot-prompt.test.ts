import { describe, expect, it } from 'vitest';
import { agentBootPrompt } from '../boot-prompt';

/**
 * The boot prompt orients; it does not recite the system prompt back.
 *
 * It used to open every session with "read and follow these instruction files
 * in order: <workspace>/AGENTS.md, …" — files the harness has already expanded
 * into the agent's system prompt via `@` imports. That spent the opening of
 * every run re-fetching what the agent was already given, and said nothing
 * about the three things it genuinely cannot know: whether it is connected to
 * Genie, what its previous run was doing, and what the project expects of it.
 */

const full = {
    genieAvailable: true,
    handoffPath: '/ws/.ai/handoff/tynn.md',
    tynnLinked: true,
};

describe('the agent boot prompt', () => {
    it('does NOT tell the agent to go and read its own system prompt', () => {
        const out = agentBootPrompt(full);

        expect(out).not.toMatch(/read and follow these instruction files/i);
        expect(out).not.toMatch(/AGENTS\.md/);
        expect(out).not.toMatch(/CLAUDE\.md/);
    });

    it('tells it to connect to Genie first, and why', () => {
        const out = agentBootPrompt(full);

        expect(out).toContain('connectToGenie');
        // The reason matters: an agent that does not know its terminal is unread
        // will print its question and wait forever.
        expect(out).toMatch(/nothing you print/i);
    });

    it('points at the handoff, and asks it to leave one', () => {
        const out = agentBootPrompt(full);

        expect(out).toContain('/ws/.ai/handoff/tynn.md');
        expect(out).toMatch(/imDone/);
    });

    it('sends it to Tynn for the lay of the land when the workspace is linked', () => {
        const out = agentBootPrompt(full);

        expect(out).toMatch(/tynn/i);
        expect(out).toMatch(/assigned|claimed/i);
    });

    it('omits each line when the thing it names does not exist', () => {
        // POSITIVE CONTROL against the whole point of this module: a prompt that
        // names a handoff never written, or a Tynn project the workspace is not
        // linked to, is the same lie as a menu item that does nothing.
        const out = agentBootPrompt({ genieAvailable: true });

        expect(out).toContain('connectToGenie');
        expect(out).not.toMatch(/handoff/i);
        expect(out).not.toMatch(/tynn/i);
    });

    it('is empty when there is genuinely nothing to say', () => {
        expect(agentBootPrompt({ genieAvailable: false })).toBe('');
    });

    it('keeps the persona and the caller’s own instructions', () => {
        const out = agentBootPrompt({
            genieAvailable: true,
            personaPath: '/ws/.agents/tynn/AGENT.md',
            extra: 'Fix the migration.',
        });

        expect(out).toContain('/ws/.agents/tynn/AGENT.md');
        expect(out).toContain('Fix the migration.');
    });
});
