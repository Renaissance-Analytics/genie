import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { resolveDeckAnswer } from '../src/core/deck-resolve.js';

/**
 * RESOLVING A DECK ITEM IN PLACE (§4.5) — one answer, one effect. The Deck renders four sources as
 * one band; this is the other half: what pressing an option on each kind MEANS, as a plain command
 * the main process executes. Pure, so every branch is a table here and the dispatcher in main stays
 * a switch with no judgement in it. An answer that makes no sense for its source is refused, never
 * guessed into the nearest thing.
 */

const base = (over: Partial<DeckItem>): DeckItem => ({
    id: 'x', source: 'agent-question', agentId: 'agent_a', agentName: 'atlas', workspaceId: 'tynn', title: 't',
    blocking: true, priority: 'normal', at: 0, answer: { kind: 'inline', options: [{ id: 'a', label: 'a', tone: 'neutral' }] }, forwardedFrom: null,
    ...over,
});

describe('agent questions', () => {
    it('a ForceTheQuestion item (q_…) answers the question with the chosen label as the single selection and an empty note', () => {
        const item = base({ id: 'q_1', answer: { kind: 'inline', options: [{ id: 'webContents', label: 'webContents', tone: 'neutral' }, { id: 'BrowserWindow', label: 'BrowserWindow', tone: 'neutral' }] } });
        expect(resolveDeckAnswer(item, 'webContents')).toEqual({ kind: 'answer-question', questionId: 'q_1', selections: [['webContents']], note: '' });
    });

    it('a form-shaped question cannot be answered by an option id — it needs the form', () => {
        const item = base({ id: 'q_2', answer: { kind: 'form', fields: 2 } });
        expect(resolveDeckAnswer(item, 'anything')).toEqual({ kind: 'refused', reason: 'this question needs the full form; there is no one-click answer' });
    });

    it('a tool approval (appr_…) resolves the approval queue with allow or deny', () => {
        const item = base({ id: 'appr_1', answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }, { id: 'deny', label: 'Deny', tone: 'bad' }] } });
        expect(resolveDeckAnswer(item, 'allow')).toEqual({ kind: 'resolve-approval', approvalId: 'appr_1', choice: 'allow' });
        expect(resolveDeckAnswer(item, 'deny')).toEqual({ kind: 'resolve-approval', approvalId: 'appr_1', choice: 'deny' });
        expect(resolveDeckAnswer(item, 'maybe')).toEqual({ kind: 'refused', reason: 'maybe is not one of this item’s options' });
    });

    it('a provider approval (approval:<agent>) goes back to the agent with the provider’s own option id, verbatim', () => {
        const item = base({ id: 'approval:agent_a', answer: { kind: 'inline', options: [{ id: 'allow_once', label: 'Allow once', tone: 'ok' }] } });
        expect(resolveDeckAnswer(item, 'allow_once')).toEqual({ kind: 'answer-provider-approval', agentId: 'agent_a', optionId: 'allow_once' });
    });

    it('a forwarded question is answered ELSEWHERE — refused here with the host named', () => {
        const item = base({ id: 'q_3', forwardedFrom: 'studio', answer: { kind: 'elsewhere', host: 'studio' } });
        expect(resolveDeckAnswer(item, 'a')).toEqual({ kind: 'refused', reason: 'this question was raised on studio and must be answered there' });
    });
});

describe('the other three sources', () => {
    it('user-list: done marks the item done in its workspace', () => {
        const item = base({ id: 'li_1', source: 'user-list', blocking: false, answer: { kind: 'inline', options: [{ id: 'done', label: 'Done', tone: 'neutral' }] } });
        expect(resolveDeckAnswer(item, 'done')).toEqual({ kind: 'list-done', workspaceId: 'tynn', itemId: 'li_1' });
    });

    it('unread-dm: read commits the human’s cursor through that message', () => {
        const item = base({ id: 'msg_1', source: 'unread-dm', blocking: false, answer: { kind: 'inline', options: [{ id: 'read', label: 'Mark read', tone: 'neutral' }] } });
        expect(resolveDeckAnswer(item, 'read')).toEqual({ kind: 'mark-read', messageId: 'msg_1' });
    });

    it('finished-handoff: open navigates to the agent, restart restarts it with the handoff, seen marks it seen', () => {
        const item = base({ id: 'fin_1', source: 'finished-handoff', blocking: false, answer: { kind: 'inline', options: [{ id: 'open', label: 'Open', tone: 'neutral' }, { id: 'restart', label: 'Restart with this', tone: 'neutral' }, { id: 'seen', label: 'mark read', tone: 'neutral' }] } });
        expect(resolveDeckAnswer(item, 'open')).toEqual({ kind: 'navigate', route: 'genie://agent/agent_a?tab=stream' });
        expect(resolveDeckAnswer(item, 'restart')).toEqual({ kind: 'restart-with-handoff', agentId: 'agent_a', finishedId: 'fin_1' });
        expect(resolveDeckAnswer(item, 'seen')).toEqual({ kind: 'mark-seen', finishedId: 'fin_1' });
    });

    it('a user-list item with no workspace cannot be marked done — refused, not guessed into a workspace', () => {
        const item = base({ id: 'li_2', source: 'user-list', workspaceId: null, blocking: false, answer: { kind: 'inline', options: [{ id: 'done', label: 'Done', tone: 'neutral' }] } });
        expect(resolveDeckAnswer(item, 'done')).toEqual({ kind: 'refused', reason: 'this item names no workspace; it cannot be marked done from here' });
    });
});

describe('which channel an answer travels', () => {
    it('a provider approval goes back to the session layer with the agent; everything else is a feature action', async () => {
        const { deckAnswerChannel } = await import('../src/core/deck-resolve.js');
        expect(deckAnswerChannel(base({ id: 'approval:agent_a' }))).toEqual({ kind: 'provider', agentId: 'agent_a' });
        expect(deckAnswerChannel(base({ id: 'q_1' }))).toEqual({ kind: 'feature' });
        expect(deckAnswerChannel(base({ id: 'appr_1' }))).toEqual({ kind: 'feature' });
        expect(deckAnswerChannel(base({ id: 'li_1', source: 'user-list' }))).toEqual({ kind: 'feature' });
        // A provider approval with no agent cannot be answered anywhere — refused, not routed.
        expect(deckAnswerChannel(base({ id: 'approval:x', agentId: null }))).toEqual({ kind: 'refused', reason: 'this approval names no agent' });
    });
});
