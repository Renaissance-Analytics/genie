import { describe, expect, it } from 'vitest';
import { planImDoneNotice } from '../imdone-notice';

/**
 * WHAT THE imDone TOAST HAS TO SAY.
 *
 * Owner, verbatim: *"our imDone toasts also need to be more informative, I have
 * no idea what workspace is firing that sometimes."*
 *
 * Genie hosts many workspaces at once with agents running in several. The toast
 * said only "Genie — agent finished / <terminal label> is done and waiting for
 * you", which names neither the workspace nor the agent — so it announced that
 * SOMETHING finished and left the user to go and find it. That is the exact
 * opposite of `imDone`'s job, which is to pull them to ONE terminal.
 *
 * The identity convention (#258) applies: an agent is shown as tui + NAME.
 * The chat-id is addressing, not identity, and never appears in front of a
 * person — `agentDisplay` has no field for it, and neither does this.
 */
describe('planImDoneNotice', () => {
    it('names the WORKSPACE — the fact the toast was missing', () => {
        const n = planImDoneNotice({
            workspace: 'tynn.ai',
            agent: { tui: 'claude', name: 'caddy-instdir' },
            terminal: 'claude · caddy-instdir',
        });
        expect(`${n.title} ${n.body}`).toContain('tynn.ai');
    });

    it('names the AGENT by tui and name, so one of several is identifiable', () => {
        const n = planImDoneNotice({
            workspace: 'tynn.ai',
            agent: { tui: 'claude', name: 'caddy-instdir' },
            terminal: 'claude · caddy-instdir',
        });
        const all = `${n.title} ${n.body}`;
        expect(all).toContain('Claude Code');
        expect(all).toContain('caddy-instdir');
    });

    it('distinguishes two agents that share a NAME across providers', () => {
        const claude = planImDoneNotice({ workspace: 'tynn.ai', agent: { tui: 'claude', name: 'tynn' } });
        const codex = planImDoneNotice({ workspace: 'tynn.ai', agent: { tui: 'codex', name: 'tynn' } });
        expect(claude.title).not.toBe(codex.title);
        expect(codex.title).toContain('Codex');
    });

    it('NEVER shows a chat id — identity is tui + name (#258)', () => {
        // The facts a notice is built from have no chat-id field at all, which is
        // what stops one leaking in; assert the rendered text too, so a future
        // "helpful" addition of the session id to the label is caught.
        const n = planImDoneNotice({
            workspace: 'tynn.ai',
            agent: { tui: 'claude', name: 'caddy-instdir' },
            terminal: 'claude · caddy-instdir',
        });
        expect(`${n.title} ${n.body}`).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    });

    it('names the TERMINAL when its label is not already the agent', () => {
        const n = planImDoneNotice({
            workspace: 'tynn.ai',
            agent: { tui: 'claude', name: 'reviewer' },
            terminal: 'Terminal 3',
        });
        expect(n.body).toContain('Terminal 3');
    });

    it('does NOT repeat the terminal when its label already carries the agent name', () => {
        const n = planImDoneNotice({
            workspace: 'tynn.ai',
            agent: { tui: 'claude', name: 'caddy-instdir' },
            terminal: 'claude · caddy-instdir',
        });
        // The label adds nothing here, and a toast has two short lines to spend.
        expect(n.body).not.toContain('claude · caddy-instdir');
    });

    it('falls back to the terminal label when the terminal is not an agent', () => {
        // A plain shell running a finish-hook still calls imDone.
        const n = planImDoneNotice({ workspace: 'tynn.ai', agent: null, terminal: 'build' });
        expect(n.title).toContain('tynn.ai');
        expect(n.title).toContain('build');
    });

    it('still says who finished when there is no workspace', () => {
        const n = planImDoneNotice({ agent: { tui: 'codex', name: 'scratch' } });
        expect(n.title).toContain('Codex');
        expect(n.title).toContain('scratch');
    });

    it('degrades to something legible when every fact is missing', () => {
        const n = planImDoneNotice({});
        expect(n.title.trim()).not.toBe('');
        expect(n.body.trim()).not.toBe('');
    });

    it('treats blank strings as missing rather than rendering empty quotes', () => {
        const n = planImDoneNotice({ workspace: '   ', agent: null, terminal: '' });
        expect(n.title).not.toContain('“”');
        expect(n.title).not.toContain('—  ');
    });

    /**
     * The same toast fires on a REMOTE driver when a host's agent finishes
     * (`forwardImDoneToDriver`). It named the host and nothing else — so on a
     * machine driving one host it said only "a terminal, somewhere over there".
     * The host is one more coordinate, not a replacement for the other two.
     */
    it('names the HOST as well as the workspace when the finish came from one', () => {
        const n = planImDoneNotice({
            workspace: 'tynn.ai',
            agent: { tui: 'claude', name: 'caddy-instdir' },
            host: 'moic-desktop',
        });
        expect(n.body).toContain('moic-desktop');
        expect(n.title).toContain('tynn.ai');
        expect(n.title).toContain('caddy-instdir');
    });

    it('says nothing about a host for a LOCAL finish', () => {
        const n = planImDoneNotice({ workspace: 'tynn.ai', agent: { tui: 'claude', name: 'x' } });
        expect(n.body.toLowerCase()).not.toContain(' on ');
    });

    it('tells the user the toast is clickable, because it now goes somewhere', () => {
        const n = planImDoneNotice({
            workspace: 'tynn.ai',
            agent: { tui: 'claude', name: 'caddy-instdir' },
        });
        expect(n.body.toLowerCase()).toContain('click');
    });
});
