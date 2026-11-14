import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HUMAN } from '../src/core/inbox.js';
import { answerDeck } from '../src/main/deck-answer.js';
import { RECIPIENT } from './helpers/features-host-workspace-caller.js';
import { CALLER_A, item, presentationFixture, type PresentationFixture } from './helpers/features-host-presentation.js';

let f: PresentationFixture;
beforeEach(async () => { f = await presentationFixture(); });
afterEach(async () => { await f?.close(); vi.restoreAllMocks(); });
const questions = [{ header: 'Choice', question: 'Pick one fixture option', options: [{ label: 'Yes' }, { label: 'No' }] }];
async function ask(name = 'fixture') {
    const made = await f.attention.ask({ agentId: RECIPIENT, agentName: name, workspaceId: 'work',
        questions: questions.map(q => ({ ...q, question: q.question + name })) }, { userActive: true });
    return item({ id: made.questionId, answer: { kind: 'inline', options: [{ id: 'Yes', label: 'Yes', tone: 'neutral' }] } });
}

describe('the last host feature ports retain their human action contracts (Tynn #720)', () => {
    it('Leave safe mode uses its existing host operation with no window', async () => {
        f.windows.clear(); await f.answer({ kind: 'safeMode.leave' }); expect(f.systemCalls).toEqual(['safe-mode']);
    });
    it('the reopened-window notice dismisses through its existing host owner', async () => {
        await f.answer({ kind: 'hangNotice.dismiss' }); expect(f.systemCalls).toEqual(['hang-dismiss']);
    });
    it('Stop all on the reopened-window notice reaches the host exactly once', async () => {
        await f.answer({ kind: 'hangNotice.stopAll' }); expect(f.systemCalls).toEqual(['hang-stop']);
    });
    it('a host notice refusal preserves the operation reason', async () => {
        f.systemFailure.reason = 'fixture host has not finished starting';
        expect(await f.invoke({ kind: 'safeMode.leave' })).toEqual({ ok: false, reason: f.systemFailure.reason });
    });
    it('an absent safe-mode owner refuses with the canonical no-host reason', async () => {
        Object.assign(f.service.ports, { system: undefined });
        expect(await f.invoke({ kind: 'safeMode.leave' })).toEqual({ ok: false, reason: 'Genie’s host is not connected, so safe mode cannot be left from here.' });
    });
    it('opening Remote access rereads the real debounced firewall owner', async () => {
        const reads = f.firewallState.reads; await f.answer({ kind: 'remote.readFirewall' });
        expect(f.firewallState.reads).toBe(reads + 1);
    });
    it('a question answer is saved and mailed by the real attention owner', async () => {
        const question = await ask(); await f.answer({ kind: 'deck.answer', item: question, optionId: 'Yes', note: 'fixture note' });
        expect(f.attention.pending()).toHaveLength(0);
        expect(f.attention.asked(question.id)).toMatchObject({ outcome: 'answered', selections: [['Yes']], note: 'fixture note' });
        expect(f.inbox.unread(RECIPIENT)).toHaveLength(1); expect(f.inbox.unread(RECIPIENT)[0]?.from).toBe(HUMAN);
    });
    it('a form answer keeps every selection and per-question note', async () => {
        const question = await ask(); question.answer = { kind: 'form', fields: 1, questions };
        await f.answer({ kind: 'deck.answerForm', item: question, selections: [['No']], notes: ['fixture field note'], note: '' });
        expect(f.attention.asked(question.id)).toMatchObject({ selections: [['No']], notes: ['fixture field note'] });
    });
    it('a stale copy of a question is refused before any answer or mail', async () => {
        const question = await ask(); question.revision = 1;
        expect(await f.invoke({ kind: 'deck.answer', item: question, optionId: 'Yes' }))
            .toMatchObject({ ok: false, reason: expect.stringContaining('changed since you opened it') });
        expect(f.attention.pending()).toHaveLength(1); expect(f.inbox.unread(RECIPIENT)).toHaveLength(0);
    });
    it('dismissing a question records the person notes and mails the asker', async () => {
        const question = await ask(); await f.answer({ kind: 'deck.dismiss', item: question, notes: ['fixture later'] });
        expect(f.attention.asked(question.id)).toMatchObject({ outcome: 'dismissed', notes: ['fixture later'] });
        expect(f.inbox.unread(RECIPIENT)).toHaveLength(1);
    });
    it('an approval cannot be dismissed as an ordinary question', async () => {
        expect(await f.invoke({ kind: 'deck.dismiss', item: item({ id: 'appr_fixture' }), notes: [] }))
            .toMatchObject({ ok: false, reason: expect.stringContaining('only an agent’s question can be dismissed') });
        expect(f.calls).toEqual([]);
    });
    it('Dismiss stale rechecks the actual Deck and leaves an unseen stale question pending', async () => {
        const seen = await ask('seen'), unseen = await ask('unseen');
        f.deckItems.push({ ...seen, stale: 'agent-gone' }, { ...unseen, stale: 'agent-gone' });
        await f.answer({ kind: 'deck.dismissStale', ids: [seen.id] });
        expect(f.attention.pending().map(q => q.id)).toEqual([unseen.id]);
        expect(f.attention.asked(seen.id)?.outcome).toBe('dismissed');
    });
    it('Dismiss stale with no still-stale item says why and does not mail anyone', async () => {
        const question = await ask(); f.deckItems.push(question);
        expect(await f.invoke({ kind: 'deck.dismissStale', ids: [question.id] }))
            .toMatchObject({ ok: false, reason: expect.stringContaining('None of these questions is still waiting as a stale one here') });
        expect(f.attention.pending()).toHaveLength(1); expect(f.inbox.unread(RECIPIENT)).toHaveLength(0);
    });
    it('Dismiss older delegates the cutoff to the real store clock', async () => {
        const older = vi.spyOn(f.attention, 'dismissOlderThan');
        await f.answer({ kind: 'deck.dismissOlder', olderThanMs: 86_400_000 }); expect(older).toHaveBeenCalledExactlyOnceWith(86_400_000);
    });
    it('an approval note reaches its agent with the same allow verdict', async () => {
        const approval = item({ id: 'appr_fixture', answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'neutral' }] } });
        await f.answer({ kind: 'deck.answer', item: approval, optionId: 'allow', note: 'fixture approval note' });
        expect(f.calls).toEqual([{ owner: 'host', effect: 'approval', value: ['appr_fixture', 'allow'] }]);
        expect(f.deliveries).toHaveLength(1); expect(f.deliveries[0]?.[0]).toBe(RECIPIENT);
        expect(f.deliveries[0]?.[1]).toContain('fixture approval note');
    });
    it('Done on a real user-list item uses the human actor and notifies its asker', async () => {
        const made = await f.attention.lists.add({ list: 'user', workspaceId: 'work', agentId: RECIPIENT, text: 'Complete fixture task' });
        expect(made.kind).toBe('added'); if (made.kind !== 'added') throw new Error('fixture list was not created');
        await f.answer({ kind: 'deck.answer', item: item({ id: made.item.id, source: 'user-list' }), optionId: 'yes' });
        expect(f.attention.lists.show({ list: 'user', workspaceId: 'work', agentId: RECIPIENT })[0]?.done).toBe(true);
        expect(f.inbox.unread(RECIPIENT)).toHaveLength(1);
    });
    it('a mail Deck answer records the human read receipt in the real inbox', async () => {
        const message = await f.inbox.send({ from: RECIPIENT, to: HUMAN, text: 'fixture mail' });
        await f.answer({ kind: 'deck.answer', item: item({ id: message.id, source: 'unread-dm' }), optionId: 'yes' });
        expect(f.inbox.unread(HUMAN)).toHaveLength(0);
    });
    it('own-screen pairing preserves the canonical missing-request refusal', async () => {
        expect(await f.invoke({ kind: 'remote.answerPair', id: 'missing-fixture-pair', allow: true }))
            .toEqual({ ok: false, reason: (await f.access.pairing.answer('missing-fixture-pair', true) as { ok: false; reason: string }).reason });
    });
    it('pairing cannot be answered by a nonlocal caller even through the direct host API', async () => {
        const pair = vi.spyOn(f.machine.services.pairing, 'answer');
        expect(await f.invoke({ kind: 'remote.answerPair', id: 'fixture', allow: true }, { ...CALLER_A, origin: 'relay' }))
            .toMatchObject({ ok: false, reason: expect.stringContaining('own screen') }); expect(pair).not.toHaveBeenCalled();
    });
    it('CONTROL: the canonical Deck answer itself records a real question answer without the aggregator', async () => {
        const question = await ask(); await answerDeck({ kind: 'deck.answer', item: question, optionId: 'Yes' }, f.deck);
        expect(f.attention.asked(question.id)).toMatchObject({ outcome: 'answered', selections: [['Yes']] });
    });
    it('CONTROL: the canonical Deck rule itself refuses an out-of-date question without mutating it', async () => {
        const question = await ask(); question.revision = 1;
        await expect(answerDeck({ kind: 'deck.answer', item: question, optionId: 'Yes' }, f.deck)).rejects.toThrow(/changed since you opened it/);
        expect(f.attention.pending()).toHaveLength(1);
    });
});
