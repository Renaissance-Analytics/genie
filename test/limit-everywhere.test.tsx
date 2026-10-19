import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { chatContext } from '../src/core/chat-view.js';
import { statusOf, type AgentRow } from '../src/core/dashboard-view.js';
import { limitWords } from '../src/core/limit-words.js';
import { agentRowFor, type LiveSession } from '../src/core/roster.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * THE COUNTDOWN EVERYWHERE AN AGENT IS SHOWN (Tynn #794). #900 put it on the Agent view; a held agent still read `Idle`
 * on the Dashboard and in the chat. One wording (`limitWords`) for all of them: until when, the next try on the
 * backoff, or that it needs the person — never a guessed time.
 */
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
const hhmm = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
const paused = { state: 'paused' as const, window: 'five_hour', resetsAtMs: NOW + 60_000, resumeAtMs: NOW + 180_000, message: null };

describe('one wording', () => {
    it('paused / retrying / needs you; open and absent are nothing', () => {
        expect(limitWords(paused)).toBe(`rate limit · resumes ${hhmm(NOW + 180_000)}`);
        expect(limitWords({ state: 'retrying', nextTryAtMs: NOW + 900_000, attempt: 2, message: null })).toBe(`rate limit · next try ${hhmm(NOW + 900_000)}`);
        expect(limitWords({ state: 'needs-person', message: 'out of usage credits' })).toBe('rate limit · needs you: out of usage credits');
        expect(limitWords({ state: 'needs-person', message: null })).toBe('rate limit · needs you');
        expect(limitWords({ state: 'open' })).toBeNull();
        expect(limitWords(undefined)).toBeNull();
    });
});

describe('the Dashboard row', () => {
    const row = (over: Partial<AgentRow> = {}): AgentRow => ({
        id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'idle', duration: null,
        ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null,
        commsAgeSeconds: null, links: null, contextUsed: null, contextSize: null, ...over,
    } as AgentRow);
    it('a held agent reads Paused with the wording, warn; a waiting one still reads Waiting (CONTROL); open is Idle (CONTROL)', () => {
        expect(statusOf(row({ limit: paused }))).toEqual({ word: 'Paused', detail: limitWords(paused), tone: 'warn' });
        expect(statusOf(row({ state: 'waiting', ask: 'Run it?', limit: paused })).word).toBe('Waiting on you');
        expect(statusOf(row({ limit: { state: 'open' } })).word).toBe('Idle');
    });
    it('agentRowFor carries the session’s limit onto the row', () => {
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        const session = { running: true, turnState: 'idle', startedAt: NOW, pendingApproval: null, failure: null, limit: paused } as unknown as LiveSession;
        expect(agentRowFor(record, session, () => NOW).limit).toEqual(paused);
    });
});

describe('the chat', () => {
    it('the context line says Paused with the wording; a parked question still wins (CONTROL)', () => {
        const detail = (over: Partial<LiveSession>) => ({ agent: { fidelity: 'declared', provider: 'claude' }, session: { running: true, turnState: 'idle', pendingApproval: null, failure: null, plan: null, ...over }, rows: [] }) as never;
        expect(chatContext(detail({ limit: paused }))).toEqual({ text: `Paused · ${limitWords(paused)}`, tone: 'warn' });
        expect(chatContext(detail({ limit: paused, pendingApproval: { question: 'Run?' } as never })).text).toBe('Parked · waiting on you');
    });

    it('Resume now sits on the context line when offered, once; absent otherwise', () => {
        const base: ChatThread = { agentId: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'tynn', context: { text: `Paused · ${limitWords(paused)}`, tone: 'warn' }, messages: [] } as unknown as ChatThread;
        const html = renderToStaticMarkup(<ChatFlyout thread={base} onSend={() => {}} onClose={() => {}} onResumeLimit={() => {}} />);
        const line = html.slice(html.indexOf('data-chat-context="warn"'), html.indexOf('data-chat-scroll'));
        expect(line.split('data-action="resume-limit"').length - 1).toBe(1);
        expect(renderToStaticMarkup(<ChatFlyout thread={base} onSend={() => {}} onClose={() => {}} />)).not.toContain('resume-limit');
    });
});
