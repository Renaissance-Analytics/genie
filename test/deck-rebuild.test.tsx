import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Question } from '../src/core/attention.js';
import { dismissableStale, needsYouCount, type DeckItem, type SignalState } from '../src/core/deck.js';
import { deckItemsFrom, questionStale } from '../src/core/deck-sources.js';
import type { PendingQuestion } from '../src/main/attention-store.js';
import { DeckOnDashboard, type DeckOnDashboardProps as DeckProps } from './helpers/deck-on-dashboard.js';
import { control } from './helpers/control-markup.js';

/**
 * WHAT WAITS, KEPT (the owner, 2026-10-15, answering the Deck's purpose; since Tynn #730 on the Dashboard, under each agent's row):
 *
 * - Each thing that needs the person, with the agent, the question or request, its age, and Answer / Open / Dismiss in place.
 * - Old items, "Keep, but mark stale": a question whose agent no longer waits (its agent gone from the roster; Tynn #1085)
 *   stays, greyed and said, with one-click Dismiss and "Dismiss all stale".
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
    question('q_a3', 'ws_a', 'shop.example', { priority: 'urgent', stale: 'agent-gone' }),
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
    renderToStaticMarkup(<DeckOnDashboard items={ITEMS} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} onDismiss={() => {}} now={1_760_000_060_000} {...over} />);

describe('the count', () => {
    it('the count waiting on you leaves out a stale question (its agent is not waiting); control: the live ones are all counted', () => {
        expect(needsYouCount(ITEMS)).toBe(4);
        expect(needsYouCount(ITEMS.map((i) => ({ ...i, stale: undefined })))).toBe(6);
    });
});

describe('on its agent’s row', () => {
    const html = render();

    it('each live item sits on its own agent’s row, in rank order; Genie’s own item (no agent) is on the Genie row', () => {
        for (const id of ['q_a1', 'q_a2', 'q_b1']) expect(html, id).toContain(`data-waiting-items="agent_${id}"`);
        expect(html).toContain('data-waiting-items="genie:"');
        expect(html).toMatch(/data-waiting-items="genie:"[\s\S]*?data-deck-item="genie:main-error:1"/);
        // COUNTED: every item is drawn exactly once.
        expect((html.match(/data-deck-item="/g) ?? []).length).toBe(ITEMS.length);
    });

    it('the chip counts what waits on you (4); the ids are never text a person reads', () => {
        expect(html).toContain('Needs you 4');
        for (const id of ['ws_a', 'ws_b', 'ws_c']) expect(html).not.toContain(`>${id}<`);
    });

    it('a row has Open (its agent) beside its age; Genie’s own item has no agent to open (control)', () => {
        // Beside its age: the <time>, then the Open button (react-fancy's), for THAT item.
        expect(html).toMatch(/data-deck-age="q_a1"[^>]*>[^<]*<\/time><button\b[^>]*data-deck-open="q_a1"/);
        const open = control(html, 'data-deck-open="q_a1"');
        expect(open).toMatchObject({ tag: 'button', fancy: true, text: 'Open' });
        expect(open!.open).toContain('data-action="deck-open"');
        expect((html.match(/data-action="deck-open"/g) ?? []).length).toBe(5);
        expect(html).not.toContain('data-deck-open="genie:main-error:1"');
    });
});

describe('stale: kept, and marked', () => {
    const html = render({ onDismissStale: () => {} });
    const rowOf = (id: string) => html.split(`data-deck-item="${id}"`)[1]!.split('data-deck-item="')[0]!;

    it('a stale question SAYS why; its form is folded behind Answer; one-click Dismiss', () => {
        expect(html).toContain('data-deck-item-stale="agent-gone"');
        expect(rowOf('q_c1')).toMatch(/data-deck-stale-reason="agent-gone"[\s\S]*?>agent gone</);
        expect(rowOf('q_a3')).toMatch(/data-deck-stale-reason="agent-gone"[\s\S]*?>agent gone</);
        expect(html).not.toContain('data-deck-form="q_c1"');
        expect(html).toContain('data-deck-answer-anyway="q_c1"');
        expect(control(rowOf('q_c1'), 'data-deck-dismiss="q_c1"')).toMatchObject({ tag: 'button', fancy: true, text: 'Dismiss' });
        expect(control(rowOf('q_c1'), 'data-deck-dismiss="q_c1"')!.open).toContain('data-action="question-dismiss"');
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
        expect(control(html, 'data-deck-stale="2"')).toMatchObject({ tag: 'button', fancy: true, text: 'Dismiss all stale (2)' });
        expect(control(html, 'data-deck-stale="2"')!.open).toContain('data-action="deck-dismiss-stale"');
        expect(dismissableStale(ITEMS).map((i) => i.id)).toEqual(['q_c1', 'q_a3']);
    });

    it('control: nothing stale → no "Dismiss all stale"; no handler → not offered', () => {
        const live = ITEMS.map((i) => ({ ...i, stale: undefined }));
        expect(render({ items: live, onDismissStale: () => {} })).not.toContain('deck-dismiss-stale');
        expect(render()).not.toContain('deck-dismiss-stale');
    });

    it('only stale questions: nothing is waiting on you (the chip says 0) — the stale ones are still there, badged', () => {
        const only = render({ items: [ITEMS[0]!], onDismissStale: () => {} });
        expect(only).toContain('Needs you 0');
        expect(only).toContain('data-waiting-badge="stale"');
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
        userList: [], unreadDms: [], agents,
    };

    it('only gone from the roster is stale; a session that ended, or a run started after the ask, still gets its answer by mail (Tynn #1085)', () => {
        const items = deckItemsFrom({ ...input, asker: (id) => sessions[id] ?? null });
        expect(Object.fromEntries(items.map((i) => [i.id, i.stale ?? 'live']))).toEqual({ q_live: 'live', q_ended: 'live', q_earlier: 'live', q_gone: 'agent-gone' });
    });

    it('LIVENESS NOT KNOWN yet (the asker answers undefined): 0 stale — not even the agent gone from the roster — and all are counted waiting', () => {
        const items = deckItemsFrom({ ...input, asker: () => undefined });
        expect(items.filter((i) => i.stale !== undefined)).toHaveLength(0);
        expect(needsYouCount(items)).toBe(4);
    });

    it('control: once liveness IS known, the gone agent’s question is stale (and no longer counted)', () => {
        const items = deckItemsFrom({ ...input, asker: (id) => sessions[id] ?? null });
        expect(items.find((i) => i.id === 'q_gone')!.stale).toBe('agent-gone');
        expect(needsYouCount(items)).toBe(3);
    });

    it('control: with no liveness to judge by, nothing is called stale', () => {
        expect(deckItemsFrom(input).filter((i) => i.stale !== undefined)).toHaveLength(0);
    });

    it('questionStale reads only whether the roster knows the agent', () => {
        expect(questionStale(true)).toBeNull();
        expect(questionStale(false)).toBe('agent-gone');
    });
});

/**
 * A STALE QUESTION IS NEVER INVISIBLE (the owner, 2026-11-08: greyed at the bottom of its section read as "nowhere"). On the
 * Dashboard each is badged `stale` on its own agent's row, said in full - not greyed - with Answer and Dismiss, and is counted
 * in the sidebar's earlier-runs badge.
 */
describe('Earlier runs: still unanswered', () => {
    const html = render({ onDismissStale: () => {} });
    const rowOf = (id: string) => html.split(`data-deck-item="${id}"`)[1]!.split('data-deck-item="')[0]!;

    it('each stale question is badged on its agent’s row, and nothing live is badged stale', () => {
        expect((html.match(/data-waiting-badge="stale"/g) ?? []).length).toBe(2);
        expect(html).toMatch(/data-agent="agent_q_c1"[\s\S]*?data-waiting-badge="stale"/);
    });

    it('each is said plainly, not greyed: why it is here, Answer and Dismiss', () => {
        expect(html).not.toMatch(/data-deck-item="q_c1"[^>]*class="[^"]*opacity-60/);
        expect(rowOf('q_c1')).toContain('agent gone');
        expect(control(rowOf('q_c1'), 'data-deck-answer-anyway="q_c1"')).toMatchObject({ tag: 'button', fancy: true, text: 'Answer' });
        expect(control(rowOf('q_c1'), 'data-deck-dismiss="q_c1"')).toMatchObject({ tag: 'button', fancy: true, text: 'Dismiss' });
    });

    it('CONTROL: nothing stale, no stale badge', () => {
        expect(render({ items: ITEMS.map((i) => ({ ...i, stale: undefined })) })).not.toContain('data-waiting-badge="stale"');
    });
});
