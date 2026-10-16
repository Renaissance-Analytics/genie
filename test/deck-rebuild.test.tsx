import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Question } from '../src/core/attention.js';
import { deckSections, dismissableStale, needsYouCount, type DeckItem, type SignalState } from '../src/core/deck.js';
import { deckItemsFrom, questionStale } from '../src/core/deck-sources.js';
import type { PendingQuestion } from '../src/main/attention-store.js';
import { Deck, type DeckProps } from '../src/renderer/components/Deck.js';

/**
 * THE DECK, REBUILT (the owner, 2026-10-15, answering the Deck's purpose):
 *
 * - "Grouped by workspace": sections per workspace, then rows — each thing that needs the person, with the agent, the
 *   question or request, its age, and Answer / Open / Dismiss in place.
 * - Old items, "Keep, but mark stale": a question whose agent no longer waits (gone, session ended, or asked by an
 *   earlier run) stays, greyed and said, with one-click Dismiss and "Dismiss all stale".
 *
 * Names are RFC 2606 (`*.example`); agent names are fixtures.
 */
const QUIET: SignalState = { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false };
const ONE: Question[] = [{ header: 'Engine', question: 'Which **engine**?', options: [{ label: 'sqlite' }, { label: 'postgres' }] }];

const question = (id: string, workspaceId: string | null, workspaceName: string | undefined, over: Partial<DeckItem> = {}): DeckItem => ({
    id,
    source: 'agent-question',
    agentId: `agent_${id}`,
    agentName: 'kai',
    workspaceId,
    ...(workspaceName === undefined ? {} : { workspaceName }),
    title: 'Engine',
    blocking: true,
    priority: 'normal',
    at: 1_760_000_000_000,
    answer: { kind: 'form', fields: 1, questions: ONE },
    forwardedFrom: null,
    ...over,
});

/** Four workspaces' worth: the most-worth-doing LIVE item is in blog.example, so that section comes first. */
const ITEMS: DeckItem[] = [
    // Stale and urgent: on origin/main's single ranked band these two came FIRST (blocking + urgent).
    question('q_c1', 'ws_c', 'docs.example', { priority: 'urgent', stale: 'agent-gone' }),
    question('q_a3', 'ws_a', 'shop.example', { priority: 'urgent', stale: 'session-ended' }),
    question('q_a2', 'ws_a', 'shop.example', { priority: 'low', at: 1_759_999_000_000 }),
    question('q_a1', 'ws_a', 'shop.example', { priority: 'normal' }),
    question('q_b1', 'ws_b', 'blog.example', { priority: 'high' }),
    // Genie's own item: no workspace, no agent; it blocks nobody.
    {
        id: 'genie:main-error:1', source: 'genie', agentId: null, agentName: null, workspaceId: null, title: 'Genie caught an error and kept running',
        blocking: false, priority: 'urgent', at: 1_760_000_000_000, answer: { kind: 'inline', options: [{ id: 'dismiss', label: 'Dismiss', tone: 'neutral' }] }, forwardedFrom: null,
    },
];

const render = (over: Partial<DeckProps> = {}) =>
    renderToStaticMarkup(<Deck items={ITEMS} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} onDismiss={() => {}} now={1_760_000_060_000} {...over} />);

/** The markup of each section, in order, keyed by its `data-deck-section`. */
const sectionsOf = (html: string): { key: string; rows: string[] }[] =>
    html.split('<section').slice(1).map((chunk) => ({
        key: /^[^>]*data-deck-section="([^"]+)"/.exec(chunk)?.[1] ?? '',
        rows: [...chunk.split('</section>')[0]!.matchAll(/data-deck-item="([^"]+)"/g)].map((m) => m[1]!),
    }));

describe('grouped by workspace — the model', () => {
    it('sections in the order of their best LIVE item, Genie’s own section for workspace-less items, stale-only last; rows live then stale, each in rank order', () => {
        const sections = deckSections(ITEMS);
        // COUNTED: four sections, in this order, with exactly these rows.
        expect(sections.map((s) => s.key)).toEqual(['ws_b', 'ws_a', 'genie:', 'ws_c']);
        expect(sections.map((s) => s.items.map((i) => i.id))).toEqual([['q_b1'], ['q_a1', 'q_a2', 'q_a3'], ['genie:main-error:1'], ['q_c1']]);
        expect(sections.map((s) => [s.live, s.stale])).toEqual([[1, 0], [2, 1], [1, 0], [0, 1]]);
        expect(sections.map((s) => s.label)).toEqual(['blog.example', 'shop.example', 'Genie', 'docs.example']);
    });

    it('a workspace this machine has no name for is said as such — never its id', () => {
        const [only] = deckSections([question('q_x', 'ws_01HUNNAMED', undefined)]);
        expect(only!.label).toBe('A workspace not known here');
        expect(only!.label).not.toContain('ws_01HUNNAMED');
    });

    it('the count waiting on you leaves out a stale question (its agent is not waiting); control: the live ones are all counted', () => {
        expect(needsYouCount(ITEMS)).toBe(4);
        expect(needsYouCount(ITEMS.map((i) => ({ ...i, stale: undefined })))).toBe(6);
    });
});

describe('grouped by workspace — on screen', () => {
    const html = render();

    it('one section per workspace, in order, each with its rows (counted)', () => {
        const sections = sectionsOf(html);
        expect(sections).toEqual([
            { key: 'ws_b', rows: ['q_b1'] },
            { key: 'ws_a', rows: ['q_a1', 'q_a2', 'q_a3'] },
            { key: 'genie:', rows: ['genie:main-error:1'] },
            { key: 'ws_c', rows: ['q_c1'] },
        ]);
    });

    it('each section is headed by the workspace’s NAME, with how many wait and how many are stale; the id is never text', () => {
        expect(html).toMatch(/data-deck-workspace="ws_b"[^>]*>blog\.example</);
        expect(html).toMatch(/data-deck-workspace="ws_a"[^>]*>shop\.example<\/span><span[^>]*>2 waiting · 1 stale</);
        expect(html).toMatch(/data-deck-workspace=""[^>]*>Genie</);
        for (const id of ['ws_a', 'ws_b', 'ws_c']) expect(html).not.toContain(`>${id}<`);
    });

    it('the header counts what waits on you (4) and says the stale ones (2) beside it', () => {
        expect(html).toContain('data-deck-count="4"');
        expect(html).toMatch(/data-deck-stale-count="2"[^>]*>2 stale</);
    });

    it('a row has Open (its agent) beside its age; Genie’s own item has no agent to open (control)', () => {
        expect(html).toMatch(/data-deck-age="q_a1"[^>]*>[^<]*<\/time><button[^>]*data-action="deck-open"[^>]*data-deck-open="q_a1"[^>]*>Open</);
        expect((html.match(/data-action="deck-open"/g) ?? []).length).toBe(5);
        expect(html).not.toContain('data-deck-open="genie:main-error:1"');
    });
});

describe('stale: kept, and marked', () => {
    const html = render({ onDismissStale: () => {} });
    const rowOf = (id: string) => html.split(`data-deck-item="${id}"`)[1]!.split('data-deck-item="')[0]!;

    it('a stale question is greyed and SAYS why; its form is folded behind "Answer anyway"; one-click Dismiss', () => {
        expect(html).toContain('data-deck-item-stale="agent-gone"');
        expect(html).toContain('data-deck-item-stale="session-ended"');
        expect(rowOf('q_c1')).toMatch(/data-deck-stale-reason="agent-gone"[\s\S]*?>agent gone</);
        expect(rowOf('q_a3')).toMatch(/data-deck-stale-reason="session-ended"[\s\S]*?>session ended</);
        expect(html).toMatch(/data-deck-item="q_c1"[^>]*class="[^"]*opacity-60/);
        expect(html).not.toContain('data-deck-form="q_c1"');
        expect(html).toContain('data-deck-answer-anyway="q_c1"');
        expect(rowOf('q_c1')).toMatch(/data-action="question-dismiss"[^>]*data-deck-dismiss="q_c1"[^>]*>Dismiss</);
        // A stale question is not drawn as an agent that has STOPPED for you.
        expect(rowOf('q_c1')).not.toContain('data-blocking-dot');
    });

    it('control: a LIVE question is not marked — no stale attribute, no badge, its form open, its blocking dot', () => {
        const live = rowOf('q_a1');
        expect(live).not.toContain('data-deck-item-stale');
        expect(live).not.toContain('data-deck-stale-reason');
        expect(live).toContain('data-deck-form="q_a1"');
        expect(live).toContain('data-blocking-dot');
        // Not greyed: the ROW's own class (the form's buttons have a `disabled:opacity-60` of their own).
        expect(html).not.toMatch(/data-deck-item="q_a1"[^>]*class="[^"]*opacity-60/);
    });

    it('"Dismiss all stale" says how many, and removes exactly the stale questions shown (counted)', () => {
        expect(html).toMatch(/data-action="deck-dismiss-stale"[^>]*data-deck-stale="2"[^>]*>Dismiss all stale \(2\)</);
        expect(dismissableStale(ITEMS).map((i) => i.id)).toEqual(['q_c1', 'q_a3']);
    });

    it('control: nothing stale → no "Dismiss all stale"; no handler → not offered', () => {
        const live = ITEMS.map((i) => ({ ...i, stale: undefined }));
        expect(render({ items: live, onDismissStale: () => {} })).not.toContain('deck-dismiss-stale');
        expect(render()).not.toContain('deck-dismiss-stale');
    });

    it('only stale questions: nothing is waiting on you, and it says so — the stale ones are still there', () => {
        const only = render({ items: [ITEMS[0]!], onDismissStale: () => {} });
        expect(only).toContain('data-deck="only-stale"');
        expect(only).not.toContain('data-deck-count');
        expect(only).toContain('data-deck-item="q_c1"');
    });
});

describe('which questions are stale (the source)', () => {
    const asked = '2026-10-15T09:00:00.000Z';
    const at = Date.parse(asked);
    const pending = (id: string, agentId: string): PendingQuestion => ({ id, key: id, agentId: agentId as never, agentName: agentId, workspaceId: 'ws_a', questions: ONE, priority: 'normal', askedAt: asked });
    const agents = { kai: { name: 'kai', workspaceId: 'ws_a' }, wren: { name: 'wren', workspaceId: 'ws_a' }, ivy: { name: 'ivy', workspaceId: 'ws_a' } };
    const sessions: Record<string, { running: boolean; startedAt: number | null }> = {
        kai: { running: true, startedAt: at - 60_000 },
        wren: { running: false, startedAt: at - 60_000 },
        ivy: { running: true, startedAt: at + 60_000 },
    };
    const input = {
        questions: [pending('q_live', 'kai'), pending('q_ended', 'wren'), pending('q_earlier', 'ivy'), pending('q_gone', 'ghost')],
        userList: [], unreadDms: [], finished: [], agents,
    };

    it('gone from the roster, session ended, an earlier run asked it — each said; control: the agent still waiting is not marked', () => {
        const items = deckItemsFrom({ ...input, asker: (id) => sessions[id] ?? null });
        expect(Object.fromEntries(items.map((i) => [i.id, i.stale ?? 'live']))).toEqual({ q_live: 'live', q_ended: 'session-ended', q_earlier: 'earlier-run', q_gone: 'agent-gone' });
    });

    it('LIVENESS NOT KNOWN yet (the asker answers undefined): 0 stale — not even the agent gone from the roster — and all are counted waiting', () => {
        const items = deckItemsFrom({ ...input, asker: () => undefined });
        expect(items.filter((i) => i.stale !== undefined)).toHaveLength(0);
        expect(needsYouCount(items)).toBe(4);
    });

    it('control: once liveness IS known, the gone agent’s question is stale (and no longer counted)', () => {
        const items = deckItemsFrom({ ...input, asker: (id) => sessions[id] ?? null });
        expect(items.find((i) => i.id === 'q_gone')!.stale).toBe('agent-gone');
        expect(needsYouCount(items)).toBe(1);
    });

    it('control: with no liveness to judge by, nothing is called stale', () => {
        expect(deckItemsFrom(input).filter((i) => i.stale !== undefined)).toHaveLength(0);
    });

    it('a session with no recorded start is not judged "earlier" — "we have not heard" is not "it was earlier"', () => {
        expect(questionStale(at, true, { running: true, startedAt: null })).toBeNull();
        expect(questionStale(at, true, null)).toBe('session-ended');
    });
});
