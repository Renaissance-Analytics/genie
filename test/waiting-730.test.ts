import { describe, expect, it } from 'vitest';
import { DAY_MS, dismissableOlderThan, deckBand, type DeckItem } from '../src/core/deck.js';
import { groupWaiting, needsYouChipCount, needsYouRows, waitingBadges, waitingKind } from '../src/core/waiting.js';

/**
 * THE DECK, ATTACHED TO THE AGENT'S ROW (Tynn #730, option B). Names are RFC 2606 fixtures; ids are fixtures.
 */
const NOW = 1_760_000_000_000;

function item(id: string, over: Partial<DeckItem> = {}): DeckItem {
    return {
        id, source: 'agent-question', agentId: 'a_meridian', agentName: 'meridian', workspaceId: 'ws_atlas', workspaceName: 'atlas.example',
        title: `title of ${id}`, blocking: true, priority: 'high', at: NOW,
        answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }, { id: 'deny', label: 'Deny', tone: 'bad' }] },
        forwardedFrom: null, ...over,
    };
}
const approval = (n: number, over: Partial<DeckItem> = {}) => item(`appr_${n}`, over);
const question = (n: number, over: Partial<DeckItem> = {}) => item(`q_${n}`, { answer: { kind: 'form', fields: 1 }, agentId: 'a_ember', agentName: 'ember', ...over });
const mail = (n: number, over: Partial<DeckItem> = {}) => item(`msg_${n}`, { source: 'unread-dm', agentId: 'a_quill', answer: { kind: 'inline', options: [{ id: 'done', label: 'Collect', tone: 'neutral' }] }, ...over });

describe('what kind an item is', () => {
    it('each source reads as its own badge word', () => {
        expect(waitingKind(approval(1))).toBe('approval');
        expect(waitingKind(item('approval:a_x'))).toBe('approval');
        expect(waitingKind(question(1))).toBe('question');
        expect(waitingKind(mail(1))).toBe('mail');
        expect(waitingKind(item('todo_1', { source: 'user-list' }))).toBe('todo');
        expect(waitingKind(item('genie:cert', { source: 'genie', agentId: null }))).toBe('genie');
    });

    it('stale beats every other kind: its agent no longer waits', () => {
        expect(waitingKind(question(1, { stale: 'agent-gone' }))).toBe('stale');
        expect(waitingKind(approval(1, { stale: 'agent-gone' }))).toBe('stale');
    });
});

describe('the badges on a row', () => {
    it('one badge per kind, counted, in blocking-first order; no items, no badges', () => {
        const badges = waitingBadges([mail(1), question(1), approval(1), approval(2), question(2, { stale: 'agent-gone' })]);
        expect(badges.map((b) => b.label)).toEqual(['2 approvals', '1 question', '1 mail', '1 stale']);
        expect(waitingBadges([])).toEqual([]);
    });

    it('singular and plural', () => {
        expect(waitingBadges([approval(1)])[0]!.label).toBe('1 approval');
        expect(waitingBadges([approval(1), approval(2)])[0]!.label).toBe('2 approvals');
    });
});

describe('where an item sits', () => {
    const shown = new Set(['a_meridian', 'a_ember']);

    it('on its agent’s row when that row is shown, in the Deck’s rank', () => {
        const older = approval(1, { at: NOW - 5_000 });
        const newer = approval(2, { at: NOW });
        const groups = groupWaiting([newer, older, question(1)], shown);
        expect(groups.byAgent.get('a_meridian')!.map((i) => i.id)).toEqual(['appr_1', 'appr_2']);
        expect(groups.byAgent.get('a_ember')!.map((i) => i.id)).toEqual(['q_1']);
        expect(groups.genie).toEqual([]);
    });

    it('an item with no agent, and an item whose agent has no row on screen, go to the Genie row — none is dropped', () => {
        const flow = item('genie:flow', { source: 'genie', agentId: null, agentName: null });
        const hidden = mail(1);
        const groups = groupWaiting([flow, hidden, approval(1)], shown);
        expect(groups.genie.map((i) => i.id).sort()).toEqual(['genie:flow', 'msg_1']);
        // CONTROL: and the row that exists still holds its own.
        expect(groups.byAgent.get('a_meridian')!.map((i) => i.id)).toEqual(['appr_1']);
        // COUNTED: every item is somewhere exactly once.
        const all = [...groups.byAgent.values()].flat().length + groups.genie.length;
        expect(all).toBe(3);
    });
});

describe('the Needs you filter', () => {
    const rows = [{ id: 'a_meridian' }, { id: 'a_ember' }, { id: 'a_vesper' }, { id: 'a_cobalt' }];

    it('keeps exactly the agents with something waiting, in the board’s order', () => {
        expect(needsYouRows(rows, [question(1), approval(1)]).map((r) => r.id)).toEqual(['a_meridian', 'a_ember']);
    });

    it('a stale item still keeps its agent (the Deck kept stale questions); an agent with nothing waiting goes', () => {
        const kept = needsYouRows(rows, [item('q_9', { agentId: 'a_cobalt', stale: 'agent-gone' })]);
        expect(kept.map((r) => r.id)).toEqual(['a_cobalt']);
    });

    it('an item with no agent keeps no row', () => {
        expect(needsYouRows(rows, [item('genie:x', { source: 'genie', agentId: null })])).toEqual([]);
    });

    it('the chip counts what waits, never a stale item — the sidebar badge’s own number', () => {
        expect(needsYouChipCount([approval(1), question(1), question(2, { stale: 'agent-gone' })])).toBe(2);
    });
});

describe('bulk dismiss is still reachable from the same band', () => {
    it('"older than 1 day" finds exactly the old dismissable questions', () => {
        const items = [question(1, { at: NOW - 2 * DAY_MS }), question(2, { at: NOW - 1000 }), approval(1, { at: NOW - 3 * DAY_MS })];
        expect(dismissableOlderThan(deckBand(items), NOW, DAY_MS).map((i) => i.id)).toEqual(['q_1']);
    });
});
