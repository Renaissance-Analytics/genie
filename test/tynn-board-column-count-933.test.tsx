import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseBoard, type BoardView } from '../src/core/tynn-board.js';
import { TynnBoardPanel } from '../src/renderer/components/TynnBoardPanel.js';

/**
 * A BOARD COLUMN'S COUNT IS THE CARDS IN IT (Tynn #933, found on the G-0 screenshot: "Proposed 0" over four cards).
 * react-fancy's Kanban.Column counts only Kanban.Card elements among its direct children; the board draws each card
 * through its own Card component, so that count was 0 under every column whatever it held. The heading a person reads
 * says the column's name and how many cards are under it, and there is one heading per column.
 */
const noop = () => {};

/** Each column as drawn: its heading's text, how many headings it has, and how many cards are under it. */
function columnsOf(html: string): Array<{ id: string; heading: string; headings: number; cards: number }> {
    const parts = html.split(/(?=<div[^>]*data-react-fancy-kanban-column="")/).slice(1);
    return parts.map((part) => {
        const id = part.match(/data-column-id="([^"]+)"/)?.[1] ?? '?';
        const h3s = [...part.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)];
        return {
            id,
            heading: (h3s[0]?.[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
            headings: h3s.length,
            cards: (part.match(/data-tynn-card="/g) ?? []).length,
        };
    });
}

const render = (view: BoardView) => renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view }} onScope={noop} onAction={noop} />);

let n = 0;
const story = (status: string, state: string) => ({ id: `s${++n}`, story_number: String(n), title: `Story ${n}`, status, state, order: n, task_count: 2, tasks_done: 1, claimed_by: null, claimed_by_me: false, can_start: false, can_move_to_qa: false, version_active: true });
const version = (id: string, status: string) => ({ id, number: id, title: id, status, release_kind: 'normal', colour: 'blue', story_count: 1, stories_done: 0, task_count: 1, tasks_done: 0 });

describe('a board column\'s heading counts the cards under it', () => {
    it('stories: four under Proposed (ready, rejected and an unknown state among them), one each under Blocked, Running, Awaiting review and Accepted', () => {
        const view = parseBoard({
            level: 'stories', version_id: 'v1',
            stories: [story('backlog', 'proposed'), story('backlog', 'ready'), story('backlog', 'rejected'), story('backlog', 'from_a_newer_tynn'), story('blocked', 'blocked'), story('in_progress', 'running'), story('qa', 'awaiting_review'), story('done', 'accepted')],
        })!;
        const cols = columnsOf(render(view));
        expect(cols.map((c) => c.id)).toEqual(['backlog', 'blocked', 'in_progress', 'qa', 'done']);
        expect(cols.map((c) => c.cards)).toEqual([4, 1, 1, 1, 1]);
        expect(cols.map((c) => c.heading)).toEqual(['Proposed 4', 'Blocked 1', 'Running 1', 'Awaiting review 1', 'Accepted 1']);
        for (const c of cols) expect(c.headings, `${c.id} has one heading`).toBe(1);
    });

    it('versions: an empty column says 0, and two active versions say 2', () => {
        const view = parseBoard({ level: 'versions', versions: [version('d1', 'draft'), version('a1', 'active'), version('a2', 'active')] })!;
        const cols = columnsOf(render(view));
        expect(cols.map((c) => [c.id, c.cards])).toEqual([['draft', 1], ['accepted', 0], ['active', 2], ['review', 0]]);
        expect(cols.map((c) => c.heading)).toEqual(['Draft 1', 'Accepted 0', 'Active 2', 'Review 0']);
        for (const c of cols) expect(c.headings, `${c.id} has one heading`).toBe(1);
    });
});
