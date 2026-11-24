import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { releaseLookOf } from '../src/core/release-kind.js';
import { sliceStateOf } from '../src/core/slice-state.js';
import { parseBoard } from '../src/core/tynn-board.js';
import { parseVip, parseWip } from '../src/core/tynn-pages.js';
import { TynnBoardPanel } from '../src/renderer/components/TynnBoardPanel.js';
import { TynnVipPanel } from '../src/renderer/components/TynnVipPanel.js';
import { TynnWipPanel } from '../src/renderer/components/TynnWipPanel.js';

/**
 * PM G-0 AGAINST workspace-ux 0.13.0 (Tynn #933). 0.13.0 adds to 0.12.0: a story row's `state` (the persisted Slice
 * state, "never inferred from legacy status") and a version row's `release_kind` and `colour`, on the board, WIP and
 * the VIP lane. A pin is a claim that Genie conforms, so each of them is READ and SHOWN here:
 *
 * - A row WITH a `state` field shows that state; one Genie does not know shows as Unknown and is never replaced by the
 *   status map. Only a row with NO `state` field at all (a Tynn older than 0.13.0) is mapped from its legacy status.
 * - A version's kind is marked (Hotfix) and painted with Tynn's colour token, as tynn.ai's own kind badge is.
 */
const noop = () => {};

describe("a Slice's state is Tynn's, never inferred when Tynn sent one", () => {
    it('a present state is never overridden by the status map', () => {
        expect(sliceStateOf({ state: 'ready', status: 'done' })).toBe('ready');
        expect(sliceStateOf({ state: 'rejected', status: 'qa' })).toBe('rejected');
    });

    it('a present state Genie does not know is unknown, not the mapped status', () => {
        expect(sliceStateOf({ state: 'nonsense', status: 'qa' })).toBe('unknown');
        expect(sliceStateOf({ state: null, status: 'qa' })).toBe('unknown');
        expect(sliceStateOf({ state: 7, status: 'done' })).toBe('unknown');
    });

    it('CONTROL: a row with no state field at all (an older Tynn) is still mapped from its status', () => {
        expect(sliceStateOf({ status: 'qa' })).toBe('awaiting_review');
        expect(sliceStateOf({ status: 'archived' })).toBeNull();
    });
});

const story = (over: Record<string, unknown>) => ({ id: 's', story_number: 1, title: 'S', status: 'backlog', order: 0, task_count: 0, tasks_done: 0, claimed_by: null, can_start: true, can_move_to_qa: true, version_active: true, ...over });
const stories = (rows: unknown[]) => parseBoard({
    project_id: 'p1', level: 'stories', version_id: 'v1', story_id: null, active_story: null,
    active_version: { id: 'v1', number: '0.4', title: 'Line', status: 'active' }, versions: [], tasks: null, stories: rows,
})!;
const version = (over: Record<string, unknown>) => ({ id: 'v', number: '1.0.0', title: 'V', status: 'active', story_count: 2, stories_done: 1, task_count: 0, tasks_done: 0, ...over });
const versions = (rows: unknown[]) => parseBoard({
    project_id: 'p1', level: 'versions', version_id: null, story_id: null, stories: null, tasks: null, active_version: null, active_story: null, versions: rows,
})!;
/** The markup of one board card, by its id (to the next card or the end). */
const cardHtml = (html: string, id: string) => {
    const at = html.indexOf(`data-tynn-card="${id}"`);
    expect(at, `card ${id} is drawn`).toBeGreaterThan(-1);
    const next = html.indexOf('data-tynn-card="', at + 1);
    return html.slice(at, next === -1 ? undefined : next);
};

describe("the board's story cards (0.13.0 `state`)", () => {
    it('a card with an unknown state says Unknown, in the column its status names', () => {
        const view = stories([story({ id: 'u', status: 'qa', state: 'nonsense' }), story({ id: 'k', status: 'qa', state: 'awaiting_review' })]);
        expect(view.cards.map((c) => [c.id, c.status, c.state])).toEqual([['u', 'qa', 'unknown'], ['k', 'qa', 'awaiting_review']]);
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view }} onScope={noop} onAction={noop} />);
        expect(cardHtml(html, 'u')).toMatch(/data-tynn-card-state="unknown"[^>]*>Unknown</);
        // CONTROL: the card whose state is its column's carries no second label.
        expect(cardHtml(html, 'k')).not.toMatch(/data-tynn-card-state=/);
    });
});

describe("a version's kind and colour (0.13.0 `release_kind`, `colour`)", () => {
    it('reads the kind and the colour token; anything else is not a kind or a token', () => {
        expect(releaseLookOf({ release_kind: 'hotfix', colour: 'orange' })).toEqual({ kind: 'hotfix', colour: 'orange' });
        expect(releaseLookOf({ release_kind: 'normal', colour: 'teal' })).toEqual({ kind: 'normal', colour: 'teal' });
        // Tynn's token only: a free value never reaches a class name.
        expect(releaseLookOf({ release_kind: 'hotfix', colour: '#ff0000' })).toEqual({ kind: 'hotfix', colour: null });
        expect(releaseLookOf({ release_kind: 'weird', colour: 'teal' })).toBeNull();
        // CONTROL: a Tynn older than 0.13.0 sends neither.
        expect(releaseLookOf({ id: 'v', status: 'active' })).toBeNull();
    });

    it('the board marks a hotfix version and paints each version with its token', () => {
        const view = versions([
            version({ id: 'h', release_kind: 'hotfix', colour: 'orange' }),
            version({ id: 'n', status: 'draft', release_kind: 'normal', colour: 'teal' }),
            version({ id: 'd', status: 'accepted', release_kind: 'hotfix', colour: null }),
            version({ id: 'o', status: 'review' }),
        ]);
        expect(view.cards.map((c) => [c.id, c.release])).toEqual([
            ['h', { kind: 'hotfix', colour: 'orange' }], ['n', { kind: 'normal', colour: 'teal' }], ['d', { kind: 'hotfix', colour: null }], ['o', null],
        ]);
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view }} onScope={noop} onAction={noop} />);
        expect(cardHtml(html, 'h')).toMatch(/data-release-kind="hotfix" data-release-colour="orange"[^>]*>.*Hotfix/s);
        expect(cardHtml(html, 'n')).toMatch(/data-release-kind="normal" data-release-colour="teal"/);
        expect(cardHtml(html, 'n')).not.toMatch(/Hotfix/);
        // A hotfix with no token of its own is red, as on tynn.ai.
        expect(cardHtml(html, 'd')).toMatch(/data-release-kind="hotfix" data-release-colour="red"[^>]*>.*Hotfix/s);
        // CONTROL: an older Tynn's version card has no kind mark.
        expect(cardHtml(html, 'o')).not.toMatch(/data-release-kind=/);
    });

    it('CONTROL: a story card has no kind mark', () => {
        expect(stories([story({ id: 'a', release_kind: 'hotfix', colour: 'red' })]).cards[0]!.release).toBeNull();
    });

    const wipJson = (active: Record<string, unknown>, available: unknown[]) => ({
        project_id: 'p1', view: 'active', available_versions: available, active_version: { id: 'v1', number: '0.4.0', title: 'The line', ...active },
        stories: [], selected_story: null, tasks: [], story_counts: { active: 0, attention: 0, done: 0, backlog: 0 },
    });

    it('WIP marks the served version and each active version it offers', () => {
        const wip = parseWip(wipJson({ release_kind: 'hotfix', colour: 'pink' }, [
            { id: 'v1', number: '0.4.0', title: 'The line', status: 'active', release_kind: 'hotfix', colour: 'pink', story_count: 1, stories_done: 0 },
            { id: 'v2', number: '0.5.0', title: 'Next', status: 'active', release_kind: 'normal', colour: 'blue', story_count: 1, stories_done: 0 },
        ]))!;
        expect(wip.version!.release).toEqual({ kind: 'hotfix', colour: 'pink' });
        expect(wip.versions.map((v) => [v.id, v.release])).toEqual([['v1', { kind: 'hotfix', colour: 'pink' }], ['v2', { kind: 'normal', colour: 'blue' }]]);
        const html = renderToStaticMarkup(<TynnWipPanel state={{ state: 'ready', view: wip }} onLens={noop} onStory={noop} onAction={noop} />);
        const banner = html.slice(html.indexOf('data-wip-banner'));
        expect(banner).toMatch(/data-release-kind="hotfix" data-release-colour="pink"[^>]*>.*Hotfix/s);
        expect(html).toMatch(/data-wip-version="v2".*data-release-kind="normal" data-release-colour="blue"/s);
    });

    it('CONTROL: WIP from an older Tynn has no kind mark', () => {
        const wip = parseWip(wipJson({}, []))!;
        expect(wip.version!.release).toBeNull();
        expect(renderToStaticMarkup(<TynnWipPanel state={{ state: 'ready', view: wip }} onLens={noop} onStory={noop} onAction={noop} />)).not.toMatch(/data-release-kind=/);
    });

    const vipStory = (over: Record<string, unknown>) => ({ id: 's', slug: 's', story_number: 1, title: 'S', status: 'backlog', description: null, task_count: 0, tasks_done: 0, ...over });
    const vipJson = (v: Record<string, unknown>, rows: unknown[]) => ({
        project_id: 'p1', vip_version: { id: 'v9', number: '1.0.1', title: 'Fire', status: 'active', ...v }, stories: rows, past_vips: [], can_start_vip: true,
    });
    const vipCard = (html: string, id: string) => {
        const at = html.indexOf(`data-vip-story="${id}"`);
        expect(at, `story ${id} is drawn`).toBeGreaterThan(-1);
        const next = html.indexOf('data-vip-story="', at + 1);
        return html.slice(at, next === -1 ? undefined : next);
    };

    it("the hotfix lane marks its version, and a story whose state is not its column's says which", () => {
        const vip = parseVip(vipJson({ release_kind: 'hotfix', colour: 'violet' }, [
            vipStory({ id: 'r', status: 'backlog', state: 'rejected' }), vipStory({ id: 'p', status: 'backlog', state: 'proposed' }), vipStory({ id: 'u', status: 'qa', state: 'nonsense' }),
        ]))!;
        expect(vip.version!.release).toEqual({ kind: 'hotfix', colour: 'violet' });
        const html = renderToStaticMarkup(<TynnVipPanel state={{ state: 'ready', view: vip }} onAction={noop} onStart={noop} />);
        expect(html.slice(html.indexOf('data-vip-banner'), html.indexOf('data-vip-story='))).toMatch(/data-release-kind="hotfix" data-release-colour="violet"[^>]*>.*Hotfix/s);
        expect(vipCard(html, 'r')).toMatch(/data-vip-story-state="rejected"[^>]*>Rejected</);
        expect(vipCard(html, 'u')).toMatch(/data-vip-story-state="unknown"[^>]*>Unknown</);
        // CONTROL: the column already says it.
        expect(vipCard(html, 'p')).not.toMatch(/data-vip-story-state=/);
    });

    it('CONTROL: the lane from an older Tynn has no kind mark and no state chip', () => {
        const vip = parseVip(vipJson({}, [vipStory({ id: 'a', status: 'in_progress' })]))!;
        expect(vip.version!.release).toBeNull();
        const html = renderToStaticMarkup(<TynnVipPanel state={{ state: 'ready', view: vip }} onAction={noop} onStart={noop} />);
        expect(html).not.toMatch(/data-release-kind=/);
        expect(html).not.toMatch(/data-vip-story-state=/);
    });
});
