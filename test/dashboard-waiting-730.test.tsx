// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { DAY_MS, type DeckItem, type SignalState } from '../src/core/deck.js';
import { Dashboard, type DashboardWaiting } from '../src/renderer/components/Dashboard.js';

/**
 * THE DECK, MERGED INTO THE DASHBOARD (Tynn #730, the owner's option B): no separate Waiting section — each agent's row
 * carries a badge for what waits on it, opens it inline with its actions, and a "Needs you" chip filters to the agents with
 * something waiting. Items with no agent are the Genie row's. Names are RFC 2606 fixtures.
 */
const NOW = 1_760_000_000_000;
const QUIET: SignalState = { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false };

const row = (over: Partial<AgentRow>): AgentRow => ({
    id: 'x', name: 'x', provider: 'claude', workspaceId: 'ws_atlas', fidelity: 'declared', state: 'working', duration: null, ask: null,
    reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null,
    commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over,
});
const ROWS: AgentRow[] = [
    row({ id: 'a_meridian', name: 'meridian' }),
    row({ id: 'a_ember', name: 'ember', state: 'idle' }),
    row({ id: 'a_vesper', name: 'vesper' }),
    row({ id: 'a_quill', name: 'quill', state: 'idle' }),
    row({ id: 'a_cobalt', name: 'cobalt', state: 'sleeping' }),
];
const WORKSPACES = [{ id: 'ws_atlas', path: '/w/atlas.example', name: 'atlas.example' }];

function item(id: string, over: Partial<DeckItem> = {}): DeckItem {
    return {
        id, source: 'agent-question', agentId: 'a_meridian', agentName: 'meridian', workspaceId: 'ws_atlas', workspaceName: 'atlas.example',
        title: `title of ${id}`, blocking: true, priority: 'high', at: NOW,
        answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }, { id: 'deny', label: 'Deny', tone: 'bad' }] },
        forwardedFrom: null, ...over,
    };
}
const questionOf = (agentId: string, name: string, id = 'q_1', over: Partial<DeckItem> = {}) => item(id, {
    agentId, agentName: name, answer: { kind: 'form', fields: 1, questions: [{ header: 'Order', question: 'Which docs order?', options: [{ label: 'A' }, { label: 'B' }] }] as never }, ...over,
});
const APPROVAL = item('appr_1');
const QUESTION = questionOf('a_ember', 'ember');
const MAIL = item('msg_1', { source: 'unread-dm', agentId: 'a_quill', agentName: 'quill', answer: { kind: 'inline', options: [{ id: 'done', label: 'Collect', tone: 'neutral' }] }, blocking: false });
const STALE = questionOf('a_cobalt', 'cobalt', 'q_stale', { stale: 'earlier-run', at: NOW - 3 * DAY_MS });
const FLOW = item('genie:flow', { source: 'genie', agentId: null, agentName: null, workspaceId: null, blocking: false, answer: { kind: 'inline', options: [{ id: 'open', label: 'Open', tone: 'neutral' }] } });
const ITEMS = [APPROVAL, QUESTION, MAIL, STALE, FLOW];

const noop = () => {};
function waiting(over: Partial<DashboardWaiting> = {}): DashboardWaiting {
    return { items: ITEMS, signals: QUIET, answering: null, onAnswer: noop, onOpenItem: noop, now: NOW, ...over };
}
const ssr = (w: DashboardWaiting | null = waiting()): string => renderToStaticMarkup(
    <Dashboard rows={ROWS} workspaces={WORKSPACES} onOpenAgent={noop} onAddAgent={noop} {...(w !== null ? { waiting: w } : {})} />,
);
const count = (s: string, re: RegExp): number => s.match(re)?.length ?? 0;
/** One agent row's markup, so an assertion cannot read a sibling's. */
function rowHtml(html: string, id: string): string {
    const start = html.indexOf(`data-agent="${id}"`);
    expect(start, `row ${id} is in the markup`).toBeGreaterThan(-1);
    const root = html.lastIndexOf('<div', start);
    const tags = /<\/?div\b[^>]*>/g; tags.lastIndex = root;
    let depth = 0;
    for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
        depth += tag[0].startsWith('</') ? -1 : 1;
        if (depth === 0) return html.slice(root, tags.lastIndex);
    }
    throw new Error(`row ${id} did not close`);
}

describe('the badges on each agent’s row', () => {
    it('an agent with something waiting carries a badge per kind, counted; one with nothing carries none', () => {
        const html = ssr();
        expect(rowHtml(html, 'a_meridian')).toMatch(/data-waiting-badge="approval"[^>]*>[\s\S]*?1 approval/);
        expect(rowHtml(html, 'a_ember')).toMatch(/data-waiting-badge="question"[^>]*>[\s\S]*?1 question/);
        expect(rowHtml(html, 'a_quill')).toMatch(/data-waiting-badge="mail"[^>]*>[\s\S]*?1 mail/);
        // CONTROL: vesper has nothing waiting.
        expect(rowHtml(html, 'a_vesper')).not.toContain('data-waiting-badge');
        // COUNTED over the board: three badges on the three shown agents (cobalt sleeps, hidden by default).
        expect(count(html, /data-waiting-badge="/g)).toBe(3 + 2 /* and the Genie row’s two */);
    });

    it('no Deck handed in, no badges, no chip, no Genie row — the board as it was', () => {
        const html = ssr(null);
        expect(html).not.toContain('data-waiting-badge');
        expect(html).not.toContain('data-dashboard-filter="needsYou"');
        expect(html).not.toContain('data-waiting-genie');
    });

    it('the badges are real buttons, and a click on one does not open the agent’s chat', () => {
        // The row's own click opens the chat; the badge stops it (proved in the interaction block below).
        expect(rowHtml(ssr(), 'a_meridian')).toMatch(/<button[^>]*data-waiting-badge="approval"/);
    });
});

describe('opening a row shows its items with their own actions', () => {
    it('closed by default: no items under any row', () => {
        expect(ssr()).not.toContain('data-waiting-items=');
    });

    it('a question: its form in place, with Answer and Dismiss', () => {
        const html = ssr(waiting({ initiallyOpen: ['a_ember'], onDismiss: noop, onAnswerForm: noop }));
        expect(html).toContain('data-waiting-items="a_ember"');
        expect(html).toContain('data-deck-item="q_1"');
        expect(html).toContain('Which docs order?');
        expect(html).toContain('data-action="question-dismiss"');
    });

    it('an approval a toast carries: a marker, and no second set of buttons; CONTROL: not carried, its own card answers', () => {
        const carried = ssr(waiting({ initiallyOpen: ['a_meridian'], toastIds: new Set(['appr_1']) }));
        expect(carried).toContain('data-approval-marker');
        expect(carried).not.toContain('data-approval-option');
        const own = ssr(waiting({ initiallyOpen: ['a_meridian'] }));
        expect(own).not.toContain('data-approval-marker');
        expect(own).toContain('data-approval-option="allow"');
    });

    it('mail: Collect, in place', () => {
        const html = ssr(waiting({ initiallyOpen: ['a_quill'] }));
        expect(html).toContain('data-waiting-items="a_quill"');
        expect(html).toMatch(/data-approval-option="done"[\s\S]*?Collect/);
    });

    it('stale: kept, said, with Dismiss and "Answer" — on its agent’s row once that row is on screen', () => {
        const html = ssr(waiting({ initiallyOpen: ['a_cobalt'], onDismiss: noop }));
        // cobalt sleeps and is hidden by default, so its item is on the Genie row (nothing is unreachable).
        expect(html).not.toContain('data-waiting-items="a_cobalt"');
        const genie = ssr(waiting({ initiallyOpen: ['genie:'], onDismiss: noop }));
        expect(genie).toContain('data-deck-item-stale="earlier-run"');
        expect(genie).toContain('data-deck-dismiss="q_stale"');
    });

    it('the item the reader was sent to (`?item=`) opens its agent’s row, marked', () => {
        const html = ssr(waiting({ focusItemId: 'q_1' }));
        expect(html).toContain('data-waiting-items="a_ember"');
        expect(html).toContain('data-deck-focus="true"');
        // CONTROL: the other rows stay closed.
        expect(html).not.toContain('data-waiting-items="a_meridian"');
    });
});

describe('the Genie row', () => {
    it('items with no agent — and items whose agent has no row on screen — are the Genie row’s, never dropped', () => {
        const html = ssr();
        const genie = html.slice(html.indexOf('data-waiting-genie'));
        expect(genie).toContain('Genie');
        // The flow signal (no agent) and cobalt's stale question (cobalt is hidden): 2 items, badges for both kinds.
        expect(genie).toMatch(/data-waiting-badge="genie"/);
        expect(genie).toMatch(/data-waiting-badge="stale"/);
    });

    it('opened, it lists them with their actions', () => {
        const html = ssr(waiting({ initiallyOpen: ['genie:'] }));
        expect(html).toContain('data-waiting-items="genie:"');
        expect(html).toContain('data-deck-item="genie:flow"');
        expect(html).toContain('data-deck-item="q_stale"');
    });

    it('no such items, no Genie row', () => {
        expect(ssr(waiting({ items: [APPROVAL] }))).not.toContain('data-waiting-genie');
    });
});

describe('the Deck’s other doors, still here', () => {
    it('"Dismiss all older than 1 day" and "Dismiss all stale" appear with their counts, only when there are such, and only when offered', () => {
        const html = ssr(waiting({ onDismissOlder: noop, onDismissStale: noop }));
        expect(html).toMatch(/data-action="deck-dismiss-older"[^>]*data-deck-older="1"/);
        expect(html).toMatch(/data-action="deck-dismiss-stale"[^>]*data-deck-stale="1"/);
        // CONTROL: not offered without the handlers, and absent when nothing is old or stale.
        expect(ssr(waiting())).not.toContain('deck-dismiss-older');
        const quiet = ssr(waiting({ items: [APPROVAL, QUESTION], onDismissOlder: noop, onDismissStale: noop }));
        expect(quiet).not.toContain('deck-dismiss-older');
        expect(quiet).not.toContain('deck-dismiss-stale');
    });

    it('a refused bulk dismissal is said under the header', () => {
        const html = ssr(waiting({ formRefusal: { itemId: 'deck:older', reason: 'the host refused' } }));
        expect(html).toMatch(/data-deck-refusal="deck:older"[^>]*>the host refused</);
    });

    it('the signal strip: silent unless something is true, and every signal a door', () => {
        expect(ssr()).not.toContain('data-signal-strip');
        const html = ssr(waiting({ signals: { ...QUIET, flowsRunning: 2 } }));
        expect(html).toContain('data-signal-strip');
        expect(html).toContain('data-signal="flows"');
    });

    it('the answers: a question’s form submits through the Deck’s own handler', () => {
        const html = ssr(waiting({ initiallyOpen: ['a_ember'], onAnswerForm: noop }));
        expect(html).toContain('data-deck-item="q_1"');
    });
});

// ---- the interactions: a real DOM -------------------------------------------------------------------------------------

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    window.localStorage.clear();
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    window.localStorage.clear();
});
function draw(w: DashboardWaiting, extra: { onOpenAgent?: (id: string) => void } = {}): void {
    act(() => root.render(<Dashboard rows={ROWS} workspaces={WORKSPACES} onOpenAgent={extra.onOpenAgent ?? noop} onAddAgent={noop} waiting={w} />));
}
const click = (el: Element | null): void => { expect(el).not.toBeNull(); act(() => { (el as HTMLElement).click(); }); };
const agents = (): string[] => [...host.querySelectorAll('[data-agent]')].map((el) => el.getAttribute('data-agent')!);

describe('the badge expands the row in place', () => {
    it('one click on a badge opens its items; one more folds them; the agent’s chat is not opened by it', () => {
        const opened: string[] = [];
        draw(waiting(), { onOpenAgent: (id) => opened.push(id) });
        expect(host.querySelector('[data-waiting-items="a_ember"]')).toBeNull();
        click(host.querySelector('[data-agent="a_ember"] [data-waiting-badge="question"]'));
        expect(host.querySelector('[data-waiting-items="a_ember"]')).not.toBeNull();
        click(host.querySelector('[data-agent="a_ember"] [data-waiting-badge="question"]'));
        expect(host.querySelector('[data-waiting-items="a_ember"]')).toBeNull();
        expect(opened).toEqual([]);
        // CONTROL: the row itself still opens the chat.
        click(host.querySelector('[data-agent="a_ember"]'));
        expect(opened).toEqual(['a_ember']);
    });

    it('Collect on opened mail answers THAT item with its option, once', () => {
        const answered: string[][] = [];
        draw(waiting({ onAnswer: (i, o) => answered.push([i.id, o]) }));
        click(host.querySelector('[data-agent="a_quill"] [data-waiting-badge="mail"]'));
        click(host.querySelector('[data-waiting-items="a_quill"] [data-approval-option="done"]'));
        expect(answered).toEqual([['msg_1', 'done']]);
    });

    it('bulk dismiss: "older than 1 day" asks for a day, exactly', () => {
        const asked: number[] = [];
        draw(waiting({ onDismissOlder: (ms) => asked.push(ms) }));
        click(host.querySelector('[data-action="deck-dismiss-older"]'));
        expect(asked).toEqual([DAY_MS]);
    });

    it('bulk dismiss: "all stale" sends exactly the ids shown stale', () => {
        const sent: string[][] = [];
        draw(waiting({ onDismissStale: (ids) => sent.push(ids) }));
        click(host.querySelector('[data-action="deck-dismiss-stale"]'));
        expect(sent).toEqual([['q_stale']]);
    });
});

describe('the Needs you filter', () => {
    it('the chip counts what waits (not a stale item) and sits beside the status chips', () => {
        draw(waiting());
        const chip = host.querySelector('[data-dashboard-filter="needsYou"]');
        expect(chip?.textContent).toContain('Needs you 4');
        // approval, question, mail and the flow signal wait on the person; the stale question does not.
        expect(chip?.getAttribute('aria-pressed')).toBe('false');
        expect(host.querySelector('[data-dashboard-filter="sleeping"]')).not.toBeNull();
    });

    it('off: every shown agent; on: only the agents with something waiting, items open — and the choice is remembered', () => {
        draw(waiting());
        expect(agents()).toEqual(['a_ember', 'a_meridian', 'a_quill', 'a_vesper']);
        click(host.querySelector('[data-dashboard-filter="needsYou"]'));
        // vesper has nothing waiting and is gone; cobalt SLEEPS and has a stale item, so it is shown though Sleeping is off.
        expect(agents()).toEqual(['a_cobalt', 'a_ember', 'a_meridian', 'a_quill']);
        expect(host.querySelector('[data-dashboard-filter="needsYou"]')?.getAttribute('aria-pressed')).toBe('true');
        expect(host.querySelector('[data-waiting-items="a_ember"]')).not.toBeNull();
        expect(window.localStorage.getItem('genie.dashboard.needsYou')).toBe('1');
        click(host.querySelector('[data-dashboard-filter="needsYou"]'));
        expect(agents()).toEqual(['a_ember', 'a_meridian', 'a_quill', 'a_vesper']);
        expect(window.localStorage.getItem('genie.dashboard.needsYou')).toBe('0');
    });

    it('nothing waiting and the filter on: it says so', () => {
        window.localStorage.setItem('genie.dashboard.needsYou', '1');
        draw(waiting({ items: [] }));
        expect(agents()).toEqual([]);
        expect(host.querySelector('[data-needs-you="empty"]')?.textContent).toContain('Nothing needs you');
    });

    it('it shares the Sleeping / Stopped filters’ store: setting it elsewhere shows here at once', () => {
        draw(waiting());
        act(() => { window.localStorage.setItem('genie.dashboard.needsYou', '1'); window.dispatchEvent(new StorageEvent('storage', { key: 'genie.dashboard.needsYou' })); });
        expect(host.querySelector('[data-dashboard-filter="needsYou"]')?.getAttribute('aria-pressed')).toBe('true');
    });
});
