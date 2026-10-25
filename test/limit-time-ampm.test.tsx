import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { statePill } from '../src/core/agent-view.js';
import { chatContext } from '../src/core/chat-view.js';
import { clockAmPm, fullDateTime } from '../src/core/clock-words.js';
import { statusOf, type AgentRow } from '../src/core/dashboard-view.js';
import { headroomLine, headroomTitle } from '../src/core/headroom.js';
import { limitTitle, limitWords } from '../src/core/limit-words.js';
import type { LiveSession } from '../src/core/roster.js';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * THE RATE-LIMIT TIME IN THE STANDARD AM/PM FORM, WITH THE FULL DATE AND TIME ON HOVER (the owner, 2026-10-25: "don't
 * show the rate limit resume time in military time, use the standard am/pm format and include a tooltip on hover that
 * shows the full date and time"). One formatter for every surface (`clockAmPm`), one for the hover (`fullDateTime`):
 * the resume time and the next try (`limitWords`, every surface), the Agent view's pill, and the plan window's reset.
 * Built from LOCAL times, so the strings are the ones a person reads in their own zone.
 */

const at = (h: number, m: number) => new Date(2026, 9, 25, h, m).getTime(); // Sunday, October 25, 2026
const paused = { state: 'paused' as const, window: 'five_hour', resetsAtMs: at(14, 29), resumeAtMs: at(14, 31), message: null };
const retrying = { state: 'retrying' as const, nextTryAtMs: at(9, 5), attempt: 1, message: null };

describe('the two formatters', () => {
    it('am/pm, no leading zero, noon and midnight the standard way — never a 24-hour clock', () => {
        expect(clockAmPm(at(14, 31))).toBe('2:31 PM');
        expect(clockAmPm(at(9, 5))).toBe('9:05 AM');
        expect(clockAmPm(at(0, 0))).toBe('12:00 AM');
        expect(clockAmPm(at(12, 30))).toBe('12:30 PM');
    });

    it('the hover: the full date and time', () => {
        expect(fullDateTime(at(14, 31))).toBe('Sunday, October 25, 2026 at 2:31 PM');
        expect(fullDateTime(at(0, 0))).toBe('Sunday, October 25, 2026 at 12:00 AM');
    });
});

describe('every surface says it that way, with the hover', () => {
    it('the shared wording, and its title', () => {
        expect(limitWords(paused)).toBe('rate limit · resumes 2:31 PM');
        expect(limitTitle(paused)).toBe('Resumes Sunday, October 25, 2026 at 2:31 PM');
        expect(limitWords(retrying)).toBe('rate limit · next try 9:05 AM');
        expect(limitTitle(retrying)).toBe('Next try Sunday, October 25, 2026 at 9:05 AM');
        // No time, no title: needing the person, open, absent.
        expect(limitTitle({ state: 'needs-person', message: null })).toBeNull();
        expect(limitTitle({ state: 'open' })).toBeNull();
        expect(limitTitle(undefined)).toBeNull();
    });

    it("the Agent view's pill", () => {
        const session = { running: true, turnState: 'idle', startedAt: at(13, 0), pendingApproval: null, failure: null, limit: paused } as unknown as LiveSession;
        expect(statePill(session, () => at(14, 0), { turns: 3 })).toEqual({ word: 'Paused · rate limit · resumes 2:31 PM', elapsed: '31:00', tone: 'warn', title: 'Resumes Sunday, October 25, 2026 at 2:31 PM' });
    });

    it('the Dashboard row and the chat line carry the title', () => {
        const row = { id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'idle', limit: paused } as unknown as AgentRow;
        expect(statusOf(row)).toEqual({ word: 'Paused', detail: 'rate limit · resumes 2:31 PM', tone: 'warn', title: 'Resumes Sunday, October 25, 2026 at 2:31 PM' });
        const detail = { agent: { fidelity: 'declared', provider: 'claude' }, session: { running: true, turnState: 'idle', pendingApproval: null, failure: null, plan: null, limit: paused }, rows: [] } as never;
        expect(chatContext(detail)).toEqual({ text: 'Paused · rate limit · resumes 2:31 PM', tone: 'warn', title: 'Resumes Sunday, October 25, 2026 at 2:31 PM' });
    });

    it('the chat line shows it on hover (title attribute), and only when there is one', () => {
        const thread = (context: ChatThread['context']) => ({ agentId: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'tynn', context, messages: [] }) as unknown as ChatThread;
        const held = renderToStaticMarkup(<ChatFlyout thread={thread({ text: 'Paused · rate limit · resumes 2:31 PM', tone: 'warn', title: 'Resumes Sunday, October 25, 2026 at 2:31 PM' })} onSend={() => {}} onClose={() => {}} />);
        expect(held).toMatch(/data-chat-context="warn"[^>]*title="Resumes Sunday, October 25, 2026 at 2:31 PM"/);
        const idle = renderToStaticMarkup(<ChatFlyout thread={thread({ text: 'Idle', tone: 'muted' })} onSend={() => {}} onClose={() => {}} />);
        expect(idle).not.toMatch(/data-chat-context="muted"[^>]*title=/);
    });

    it("the plan window's reset", () => {
        const h = { plan: 'pro', window: '5h', leftPct: 60, resetsAtMs: at(18, 30), over: false };
        expect(headroomLine(h)).toBe('pro · 60% of 5h window left · resets 6:30 PM');
        expect(headroomTitle(h)).toBe('Resets Sunday, October 25, 2026 at 6:30 PM');
    });
});
