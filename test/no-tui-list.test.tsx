import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { importedAgents } from '../src/core/agent-adoption.js';
import { agentFileText } from '../src/core/agent-create.js';
import { chatMessages } from '../src/core/chat-view.js';
import type { StreamEvent } from '../src/core/stream-event.js';

/**
 * NO TUI LIST (Tynn story #380). The owner: "why the hell is the agent.md file for agents listing a TUI? We dropped tui as a
 * t1 model, it's just the acp over cli". The provider is Genie's record of the agent, switchable at any time; AGENT.md is the
 * person's persona and Genie never writes a provider into it:
 *  - a new agent's AGENT.md has no `tuis:` line;
 *  - adoption takes the provider from Genie's default; an existing `tuis:` line is only a hint, and never a refusal;
 *  - the switch is never refused for `tuis:` (test/provider-switch-carry-over.test.ts), and Take Over has no such gate;
 *  - the chat shows a carried context as a marker, never as the person's words.
 */
const code = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('nothing writes a tuis: line', () => {
    it('a new agent’s AGENT.md has its name and purpose and no provider list (control: the name and purpose are there)', () => {
        const text = agentFileText({ name: 'atlas', purpose: 'Keeps the docs true.', provider: 'codex' });
        expect(text).toContain('name: atlas');
        expect(text).toContain('purpose: Keeps the docs true.');
        expect(text).not.toMatch(/tuis/);
        expect(text).not.toMatch(/codex/);
    });

    it('Take Over has no tuis gate', () => {
        expect(code('src/main/take-over-host.ts')).not.toMatch(/tuis/);
    });

    it('the switch decision has no tuis refusal', () => {
        expect(code('src/core/agent-ops.ts')).not.toMatch(/tuis/);
    });
});

describe('adoption without tuis', () => {
    it('no tuis: Genie’s default provider; a tuis line naming one Genie runs is a hint; one naming none is NOT a refusal', () => {
        const [plain, hinted, foreign] = importedAgents({
            files: [
                { folder: 'atlas', text: '---\nname: atlas\n---\nYou are atlas.' },
                { folder: 'nova', text: '---\nname: nova\ntuis: [aider, codex]\n---\n' },
                { folder: 'zed', text: '---\nname: zed\ntuis: [aider]\n---\n' },
            ],
            registered: [],
        });
        expect(plain).toMatchObject({ name: 'atlas', provider: 'claude', refusal: null });
        expect(hinted).toMatchObject({ name: 'nova', provider: 'codex', refusal: null });
        expect(foreign).toMatchObject({ name: 'zed', provider: 'claude', refusal: null });
    });
});

describe('the chat marks a carried context', () => {
    it('a marker row "Context carried from claude (12 turns)", with the exact text it sent — never a message of yours', () => {
        const sentText = 'Conversation so far, from claude:\nPerson: Fix the login bug';
        const event = { kind: 'notice', level: 'info', message: 'Context carried from claude (12 turns)', carried: { from: 'claude', turns: 12, text: sentText } } as unknown as StreamEvent;
        const messages = chatMessages({ agent: { id: 'a', name: 'atlas', provider: 'codex', fidelity: 'full' } as never, session: null, rows: [{ id: 'r1', event, at: 1 }] });
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ who: 'system', text: 'Context carried from claude (12 turns)' });
        expect((messages[0] as unknown as { carried?: string }).carried).toBe(sentText);
        expect(messages.some((m) => m.who === 'you')).toBe(false);
    });

    it('the chat draws it collapsed, opening to the exact text', async () => {
        const { ChatCarriedRow } = (await import('../src/renderer/components/ChatFlyout.js')) as unknown as { ChatCarriedRow?: (p: { m: unknown }) => ReactElement };
        expect(ChatCarriedRow, 'ChatCarriedRow in ChatFlyout.tsx').toBeTypeOf('function');
        const html = renderToStaticMarkup(ChatCarriedRow!({ m: { id: 'r1', who: 'system', from: '', text: 'Context carried from claude (12 turns)', delivered: true, at: 1, carried: 'Conversation so far, from claude:\nPerson: hi' } }));
        expect(html).toMatch(/^<details[^>]*data-chat-carried=""/);
        expect(html).not.toMatch(/<details[^>]*\sopen/);
        expect(html).toContain('Context carried from claude (12 turns)');
        expect(html).toContain('Person: hi');
    });
});

describe('the words', () => {
    it('the provider picker’s help says the conversation comes along — not a new conversation', () => {
        const view = code('src/renderer/components/AgentView.tsx');
        expect(view).not.toMatch(/starts a new conversation on the new provider/);
        expect(view).toMatch(/conversation comes with it/i);
        expect(code('src/core/agent-ops-menu.ts')).not.toMatch(/starts a new conversation/);
    });
});
