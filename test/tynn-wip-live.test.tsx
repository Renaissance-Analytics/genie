// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWip, tynnPagePath, wipWhen, WIP_POLL_MS } from '../src/core/tynn-pages.js';
import { TynnWipPanel } from '../src/renderer/components/TynnWipPanel.js';
import { TynnWipTab } from '../src/renderer/components/TynnTab.js';

/**
 * THE WIP VIEW IS LIVE AND READABLE (Tynn story #743; the owner: "the WIP view in Genie needs better renderings and should
 * be live"). Live: the board's channel rings (the path every Tynn page already follows), one read per burst, and a slow poll
 * while that channel is not live and the tab is visible. Every active version is listed. The chosen story's description is
 * Markdown, wrapped to the pane and never clipped; its acceptance criteria are a checklist, its tasks and its PR and commit
 * are shown; the list cards carry status, task progress, the PR and when it last changed.
 *
 * The page's real answer (Tynn's ProjectWip) has no per-version query, and no started / QA / finished times: only
 * `updated_at`. These tests pin what Genie draws from what it is given.
 */
const noop = () => {};
const NOW = Date.parse('2026-11-15T12:00:00Z');
const task = (over: Record<string, unknown>) => ({ id: 't', task_number: 1, title: 'T', status: 'backlog', claimed_by: null, claimed_by_me: false, can_start: true, version_active: true, features: [], updated_at: null, ...over });
const story = (over: Record<string, unknown>) => ({ id: 's', slug: 's', story_number: 1, title: 'S', status: 'in_progress', description: null, task_count: 0, tasks_done: 0, acceptance_criteria: [], pr_id: null, commit_id: null, updated_at: null, ...over });
const LONG = 'x'.repeat(300);
const answer = (over: Record<string, unknown> = {}) => ({
    project_id: 'p1', view: 'active',
    active_version: { id: 'v17', number: '0.17.0', title: 'Hosting', status: 'active' },
    available_versions: [
        { id: 'v17', number: '0.17.0', title: 'Hosting', status: 'active' },
        { id: 'v64', number: 'beta.64', title: 'The line', status: 'active' },
        { id: 'v65', number: 'beta.65', title: 'Next', status: 'accepted' },
    ],
    stories: [
        story({ id: 's1', slug: 'one', story_number: 11, title: 'First', task_count: 4, tasks_done: 1, pr_id: 'https://github.com/o/r/pull/77', updated_at: '2026-11-15T11:00:00Z' }),
        story({ id: 's2', slug: 'two', story_number: 12, title: 'Second', status: 'backlog' }),
    ],
    selected_story: story({
        id: 's1', slug: 'one', story_number: 11, title: 'First', task_count: 4, tasks_done: 1,
        description: `Do **the thing** well.\n\n${LONG}\n\n- one\n- two`,
        acceptance_criteria: ['A moves live', 'Cards show a PR'],
        pr_id: 'https://github.com/o/r/pull/77', commit_id: 'https://github.com/o/r/commit/abc1234', updated_at: '2026-11-15T11:00:00Z',
    }),
    tasks: [task({ id: 't1', task_number: 31, title: 'Wire it', status: 'doing' }), task({ id: 't2', task_number: 32, title: 'Ship it', status: 'done' })],
    story_counts: { active: 1, attention: 0, done: 0, backlog: 1 },
    ...over,
});
const view = (over: Record<string, unknown> = {}) => parseWip(answer(over))!;
const render = (v = view(), props: Partial<Parameters<typeof TynnWipPanel>[0]> = {}) =>
    renderToStaticMarkup(<TynnWipPanel state={{ state: 'ready', view: v }} onLens={noop} onStory={noop} onAction={noop} now={NOW} {...props} />);

describe('every active version', () => {
    it('is read from the available versions: the active ones only, the served one marked', () => {
        const v = view();
        expect(v.versions.map((x) => [x.number, x.served])).toEqual([['0.17.0', true], ['beta.64', false]]);
    });

    it('is listed in a switcher with each version\'s number and title', () => {
        const html = render();
        expect(html).toMatch(/data-wip-version="v17"/);
        expect(html).toMatch(/data-wip-version="v64"/);
        expect(html).not.toMatch(/data-wip-version="v65"/);
        expect(html).toContain('beta.64');
        expect(html).toMatch(/data-wip-version="v17"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-wip-version="v17"/);
    });

    it('is asked for by id, and a version the page did not serve says so instead of showing the wrong stories', () => {
        expect(tynnPagePath('p1', 'wip', { version: 'v64' })).toBe('/api/v1/projects/p1/wip?version=v64');
        const html = render(view(), { version: 'v64' });
        expect(html).toContain('data-wip-state="version-unserved"');
        expect(render(view(), { version: 'v17' })).not.toContain('version-unserved');
    });
});

describe('the detail pane', () => {
    it('renders the description as Markdown, wrapped to the pane and never clipped', () => {
        const html = render();
        expect(html).toContain('<strong>the thing</strong>');
        expect(html).toContain('<li>one</li>');
        const at = html.indexOf('data-wip-description');
        expect(at).toBeGreaterThan(-1);
        const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at));
        expect(tag).toMatch(/min-w-0/);
        expect(tag).toMatch(/break-words|overflow-wrap/);
        expect(html).toContain(LONG);
    });

    it('does not let Tynn\'s text become markup', () => {
        const html = render(view({ selected_story: story({ id: 's1', description: 'hi <script>alert(1)</script> <img src=x onerror=alert(1)>' }) }));
        expect(html).not.toContain('<script');
        expect(html).not.toContain('onerror');
    });

    it('lists the acceptance criteria as a checklist', () => {
        const html = render();
        expect(html).toContain('data-wip-criteria');
        expect(html).toContain('A moves live');
        expect(html).toContain('Cards show a PR');
        expect((html.match(/data-wip-criterion/g) ?? []).length).toBe(2);
    });

    it('lists the tasks with their status, and says briefly when there are none', () => {
        const html = render();
        expect(html).toContain('Wire it');
        expect(html).toMatch(/data-wip-task="t2"[\s\S]*data-wip-status="done"/);
        const none = render(view({ tasks: [] }));
        expect(none).toContain('data-wip-state="no-tasks"');
        expect(none).not.toMatch(/p-6/);
    });

    it('shows the PR and the commit as links that open in the browser, and when it last changed', () => {
        const html = render();
        expect(html).toMatch(/href="https:\/\/github.com\/o\/r\/pull\/77"[^>]*target="_blank"|target="_blank"[^>]*href="https:\/\/github.com\/o\/r\/pull\/77"/);
        expect(html).toMatch(/href="https:\/\/github.com\/o\/r\/commit\/abc1234"/);
        expect(html).toContain('data-wip-changed');
        expect(html).toContain('1 h ago');
    });

    it('shows a PR that is not a link as plain text, never as a dead link', () => {
        const html = render(view({ selected_story: story({ id: 's1', pr_id: '#88' }) }));
        expect(html).toContain('#88');
        expect(html).not.toMatch(/href="#88"/);
    });
});

describe('the list cards', () => {
    it('carry the status pill, task progress, the PR and when the story last changed', () => {
        const html = render();
        const card = html.slice(html.indexOf('data-wip-story="s1"'), html.indexOf('data-wip-story="s2"'));
        expect(card).toContain('data-wip-status="in_progress"');
        expect(card).toContain('1/4');
        expect(card).toContain('data-wip-card-pr');
        expect(card).toContain('#77');
        expect(card).toContain('1 h ago');
    });
});

describe('when', () => {
    it('words a time the way a person says it', () => {
        expect(wipWhen('2026-11-15T11:59:40Z', NOW)).toBe('just now');
        expect(wipWhen('2026-11-15T11:55:00Z', NOW)).toBe('5 min ago');
        expect(wipWhen('2026-11-15T09:00:00Z', NOW)).toBe('3 h ago');
        expect(wipWhen('2026-11-13T12:00:00Z', NOW)).toBe('2 d ago');
        expect(wipWhen('2026-09-01T12:00:00Z', NOW)).toBe('2026-09-01');
        expect(wipWhen(null, NOW)).toBeNull();
        expect(wipWhen('nonsense', NOW)).toBeNull();
    });
});

describe('the tab follows Tynn', () => {
    let root: Root;
    let host: HTMLElement;
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        vi.useFakeTimers();
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
        vi.useRealTimers();
    });

    const moved = answer({
        stories: [story({ id: 's2', slug: 'two', story_number: 12, title: 'Second', status: 'qa', task_count: 1, tasks_done: 1 }), story({ id: 's1', slug: 'one', story_number: 11, title: 'First', status: 'done' })],
        story_counts: { active: 0, attention: 1, done: 1, backlog: 0 },
    });
    const drive = (answers: unknown[], watch?: (id: string, l: (s: unknown) => void) => () => void) => {
        let i = 0;
        const page = vi.fn(async () => {
            const json = answers[Math.min(i++, answers.length - 1)];
            return { ok: true as const, page: 'wip' as const, view: parseWip(json)! };
        });
        const tabHost = { page, ...(watch ? { watch } : {}) } as never;
        return { page, tabHost };
    };
    const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

    it('moves a card when Tynn rings the board: one read for a burst, the card in its new place', async () => {
        let ring: (s: unknown) => void = noop;
        const { page, tabHost } = drive([answer(), moved], (_id, l) => { ring = l; return noop; });
        await act(async () => { root.render(<TynnWipTab workspaceId="w" host={tabHost} />); });
        await flush();
        expect(page).toHaveBeenCalledTimes(1);
        expect(host.querySelector('[data-wip-story="s1"] [data-wip-status="in_progress"]')).not.toBeNull();
        act(() => { ring({ ids: ['s1'], catchUp: false }); ring({ ids: ['s2'], catchUp: false }); });
        await flush(400);
        expect(page).toHaveBeenCalledTimes(2);
        expect(host.querySelector('[data-wip-story="s1"] [data-wip-status="done"]')).not.toBeNull();
        expect(host.querySelector('[data-wip-story="s2"] [data-wip-status="qa"]')).not.toBeNull();
        const order = [...host.querySelectorAll('[data-wip-story]')].map((e) => e.getAttribute('data-wip-story'));
        expect(order).toEqual(['s2', 's1']);
    });

    it('polls while the channel is not live, so a Genie with no live link still updates', async () => {
        const { page, tabHost } = drive([answer(), moved]);
        await act(async () => { root.render(<TynnWipTab workspaceId="w" host={tabHost} />); });
        await flush();
        expect(page).toHaveBeenCalledTimes(1);
        await flush(WIP_POLL_MS + 10);
        expect(page).toHaveBeenCalledTimes(2);
        expect(host.querySelector('[data-wip-story="s2"] [data-wip-status="qa"]')).not.toBeNull();
    });

    it('does not poll while the channel is live', async () => {
        let ring: (s: unknown) => void = noop;
        const { page, tabHost } = drive([answer(), moved], (_id, l) => { ring = l; return noop; });
        await act(async () => { root.render(<TynnWipTab workspaceId="w" host={tabHost} />); });
        await flush();
        act(() => { ring({ state: 'live' }); });
        await flush(WIP_POLL_MS * 3);
        expect(page).toHaveBeenCalledTimes(1);
    });

    it('reads the other version when it is chosen', async () => {
        const { page, tabHost } = drive([answer()]);
        await act(async () => { root.render(<TynnWipTab workspaceId="w" host={tabHost} />); });
        await flush();
        const button = host.querySelector('[data-wip-version="v64"]') as HTMLElement;
        act(() => { button.click(); });
        await flush();
        expect(page).toHaveBeenLastCalledWith('w', 'wip', expect.objectContaining({ version: 'v64' }));
    });
});
