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
    // Manual is the default every undeclared agent gets (genie#408). The mode's
    // own effect on this prompt is pinned in `agent-mode-nudges.test.ts`.
    mode: 'manual',
    handoffPath: '/ws/.ai/handoff/tynn.md',
    tynnLinked: true,
} as const;

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
        //
        // The handoff is now TWO claims, not one, and only the first is
        // conditional: pointing at a note that exists (must not appear here),
        // and asking for one on the way out (must, or the protocol never
        // starts — see the `LEAVE one` block below).
        const out = agentBootPrompt({ genieAvailable: true, mode: 'manual' });

        expect(out).toContain('connectToGenie');
        expect(out).not.toMatch(/left a handoff|read it before/i);
        expect(out).not.toMatch(/tynn/i);
    });

    it('is empty when there is genuinely nothing to say', () => {
        // Including the ask for a handoff: `imDone` is a genie MCP tool, so
        // with no Genie there is nothing to call and asking would send the
        // agent after a tool it does not have.
        expect(agentBootPrompt({ genieAvailable: false, mode: 'manual' })).toBe('');
    });

    it('keeps the persona and the caller’s own instructions', () => {
        const out = agentBootPrompt({
            genieAvailable: true,
            mode: 'manual',
            personaPath: '/ws/.agents/tynn/AGENT.md',
            extra: 'Fix the migration.',
        });

        expect(out).toContain('/ws/.agents/tynn/AGENT.md');
        expect(out).toContain('Fix the migration.');
    });
});

describe('telling an agent to LEAVE one', () => {
    it('asks for a handoff even when there is none to read', () => {
        // The protocol only works if agents write them, and until now only an
        // agent that already RECEIVED one was told to leave one — so the very
        // first run of every agent learned nothing, and left nothing, and the
        // next run again found nothing. A chicken-and-egg that never hatches.
        const prompt = agentBootPrompt({ genieAvailable: true, mode: 'manual', handoffPath: null });

        expect(prompt).toMatch(/imDone/);
        expect(prompt).toMatch(/handoff/i);
    });

    it('does not claim a note is waiting when none is', () => {
        // POSITIVE CONTROL for the test above: asking it to LEAVE one must not
        // become telling it to READ one that does not exist.
        const prompt = agentBootPrompt({ genieAvailable: true, mode: 'manual', handoffPath: null });

        expect(prompt).not.toMatch(/left a handoff|read it before/i);
    });

    it('still says where to read one when there is one', () => {
        const prompt = agentBootPrompt({
            genieAvailable: true,
            mode: 'manual',
            handoffPath: '/ws/.ai/handoff/tynn.md',
        });

        expect(prompt).toMatch(/\/ws\/\.ai\/handoff\/tynn\.md/);
        expect(prompt).toMatch(/read it before/i);
    });
});
