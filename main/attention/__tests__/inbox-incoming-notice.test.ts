import { describe, expect, it } from 'vitest';
import { planInboxIncomingNotice } from '../inbox-incoming-notice';

/**
 * WHAT THE AGENTINBOX "a message came in" TOAST HAS TO SAY.
 *
 * Owner, verbatim: *"I just got the notice that a message was incoming but it
 * never ever came and I hit enter like it said but nothing happened. my cursor
 * was in the input, but nothing was typed. I think it confused focus with
 * content"*.
 *
 * That last sentence is the diagnosis. The toast was a fixed app-level string —
 * "A message just came in for **this** agent" — while the notice itself had been
 * appended to whichever terminal the message was ADDRESSED to. "This agent"
 * silently meant "whatever you are looking at", so a notice about a terminal on
 * another workspace read as a notice about the one under the cursor, and Enter
 * went into a genuinely empty box.
 *
 * So the toast must name the SAME two things the `imDone` toast names — the
 * workspace, and the agent as tui + NAME (#258, never the chat id) — and it
 * must only say "press Enter" when there is actually something there to submit.
 */
describe('planInboxIncomingNotice', () => {
    const agent = { tui: 'claude', name: 'reviewer' } as const;

    it('names the WORKSPACE, so the toast is not about "wherever you are looking"', () => {
        const n = planInboxIncomingNotice({ workspace: 'tynn.ai', agent, landed: true });
        expect(`${n.title} ${n.body}`).toContain('tynn.ai');
    });

    it('names the AGENT by tui and name — the fact "this agent" replaced', () => {
        const n = planInboxIncomingNotice({ workspace: 'tynn.ai', agent, landed: true });
        const all = `${n.title} ${n.body}`;
        expect(all).toContain('Claude Code');
        expect(all).toContain('reviewer');
    });

    it('never says "this agent" — the phrase that made the toast unaddressed', () => {
        const n = planInboxIncomingNotice({ workspace: 'tynn.ai', agent, landed: true });
        const all = `${n.title} ${n.body}`;
        // POSITIVE CONTROL: a notice that rendered nothing at all would also
        // "not contain" the phrase, so prove there IS text before trusting that.
        expect(n.title.trim()).not.toBe('');
        expect(n.body.trim()).not.toBe('');
        expect(all.toLowerCase()).not.toContain('this agent');
    });

    it('distinguishes two agents that share a NAME across providers', () => {
        const claude = planInboxIncomingNotice({
            workspace: 'tynn.ai',
            agent: { tui: 'claude', name: 'tynn' },
            landed: true,
        });
        const codex = planInboxIncomingNotice({
            workspace: 'tynn.ai',
            agent: { tui: 'codex', name: 'tynn' },
            landed: true,
        });
        expect(claude.title).not.toBe(codex.title);
        expect(codex.title).toContain('Codex');
    });

    it('NEVER shows a chat id — identity is tui + name (#258)', () => {
        const n = planInboxIncomingNotice({
            workspace: 'tynn.ai',
            agent,
            terminal: 'claude · reviewer',
            landed: true,
        });
        expect(`${n.title} ${n.body}`).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    });

    it('names the TERMINAL when its label is not already the agent', () => {
        const n = planInboxIncomingNotice({
            workspace: 'tynn.ai',
            agent,
            terminal: 'Terminal 3',
            landed: true,
        });
        expect(n.body).toContain('Terminal 3');
    });

    it('does NOT repeat the terminal when its label already carries the agent name', () => {
        const n = planInboxIncomingNotice({
            workspace: 'tynn.ai',
            agent,
            terminal: 'claude · reviewer',
            landed: true,
        });
        expect(n.body).not.toContain('claude · reviewer');
    });

    /**
     * The instruction has to be TRUE. "Press Enter" is only true of a box the
     * notice actually reached — and it is the half of the report that a working
     * append should never have produced ("nothing was typed").
     */
    it('says to press Enter when the notice really is sitting in that prompt', () => {
        const n = planInboxIncomingNotice({ workspace: 'tynn.ai', agent, landed: true });
        expect(n.body.toLowerCase()).toContain('enter');
    });

    it('does NOT say to press Enter when nothing was appended', () => {
        const n = planInboxIncomingNotice({ workspace: 'tynn.ai', agent, landed: false });
        // Same positive control: an empty body would pass the negative alone.
        expect(n.title.trim()).not.toBe('');
        expect(n.body.trim()).not.toBe('');
        expect(n.body.toLowerCase()).not.toContain('enter');
    });

    it('points an undelivered notice at the inbox, which is where the message IS', () => {
        const n = planInboxIncomingNotice({ workspace: 'tynn.ai', agent, landed: false });
        expect(n.body).toContain('AgentInbox');
    });

    it('tells the user the toast is clickable, because it now goes somewhere', () => {
        for (const landed of [true, false]) {
            const n = planInboxIncomingNotice({ workspace: 'tynn.ai', agent, landed });
            expect(n.body.toLowerCase()).toContain('click');
        }
    });

    it('falls back to the terminal label when the terminal is not an agent', () => {
        const n = planInboxIncomingNotice({
            workspace: 'tynn.ai',
            agent: null,
            terminal: 'build',
            landed: true,
        });
        expect(n.title).toContain('tynn.ai');
        expect(n.title).toContain('build');
    });

    it('degrades to something legible when every fact is missing', () => {
        const n = planInboxIncomingNotice({ landed: true });
        expect(n.title.trim()).not.toBe('');
        expect(n.body.trim()).not.toBe('');
    });

    it('treats blank strings as missing rather than rendering empty quotes', () => {
        const n = planInboxIncomingNotice({ workspace: '   ', agent: null, terminal: '', landed: true });
        expect(n.title).not.toContain('“”');
        expect(n.title).not.toContain('—  ');
    });
});
