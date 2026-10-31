import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseIssueQueue, performIssueAction, type IssueOp } from '../src/core/tynn-issues.js';
import { TynnIssuesPanel } from '../src/renderer/components/TynnIssuesPanel.js';
import { ICON_NAMES } from '../src/renderer/icons.js';
import { ISSUE_TYPE_LOOK } from '../src/core/tynn-issues.js';

/**
 * THE TYNN TAB'S ISSUES LOOK AND BEHAVE LIKE tynn.ai's ISSUES PAGE (genie#1295 row I1).
 *
 * tynn.ai: status tabs (Open first), a source filter (Any source / From people), a search; a grid of cards, each with its
 * number, title, a short body, its type (icon, the type's colour on the card's edge), who raised it, its GitHub repo and
 * number, and its status when it is not open; "No issues match" when nothing does; a New issue button; an issue opens
 * into its form, with Delete / Resolve / Discard / Convert only on an open issue for a person who may triage. Genie's
 * rules on top (the owner): icons over words, named for a screen reader; every action a real button that says it is
 * running, then that it worked, or Tynn's reason with Retry; a live icon while it follows Tynn.
 */
const issue = (over: Record<string, unknown> = {}) => ({
    id: 'i1', issue_number: 7, title: 'Dark <mode>', description: 'Please **bold**', status: 'open', type: 'fix', priority: 'normal',
    source: 'issue', context_url: null, from: 'Ada', version_number: null, feature_ids: [], solutions: [], converted_story_id: null,
    converted_story_number: null, github: null, created_at: '2026-10-31T10:00:00+00:00', ...over,
});
const QUEUE = (over: Record<string, unknown> = {}) => parseIssueQueue({
    project_id: 'p1', cursor: 'c1',
    issues: [
        issue(),
        issue({ id: 'i2', issue_number: 6, title: 'Slow export', type: 'enhancement', from: null, source: 'github', github: { repo: 'acme/app', number: 42, url: 'https://github.com/acme/app/issues/42', state: 'open' } }),
        issue({ id: 'i3', issue_number: 5, title: 'Old', status: 'resolved' }),
    ],
    filters: { status: 'open', source: null, q: '' },
    statuses: ['open', 'converted', 'discarded', 'resolved'],
    features: [{ id: 'f1', title: 'Theming', slug: 'theming' }],
    convertible_versions: [{ id: 'v1', number: '0.4', title: 'Now', status: 'active' }],
    can_triage: true,
    ...over,
})!;
const noop = () => {};
const render = (props: Partial<Parameters<typeof TynnIssuesPanel>[0]> = {}) =>
    renderToStaticMarkup(<TynnIssuesPanel state={{ state: 'ready', view: QUEUE() }} onFilters={noop} onAction={noop} {...props} />);
const tag = (html: string, attr: string) => html.match(new RegExp(`<[^>]*${attr}[^>]*>`))?.[0] ?? '';
/** The element whose opening tag carries `attr`, with what it holds (to the first closing tag of that name). */
function el(html: string, attr: string): string {
    const open = tag(html, attr);
    if (open === '') return '';
    const name = open.slice(1).split(/[ >]/)[0]!;
    const start = html.indexOf(open);
    const end = html.indexOf(`</${name}>`, start);
    return end < 0 ? open : html.slice(start, end + name.length + 3);
}

describe('the queue\'s toolbar', () => {
    it('has tynn.ai\'s status tabs in tynn.ai\'s order, Open pressed first', () => {
        const html = render();
        const order = ['open', 'converted', 'resolved', 'discarded', 'all'].map((s) => html.indexOf(`data-issues-status="${s}"`));
        expect(order.every((i) => i >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(tag(html, 'data-issues-status="open"')).toContain('aria-pressed="true"');
        expect(tag(html, 'data-issues-status="all"')).toContain('aria-pressed="false"');
    });

    it('has the source filter (Any source / From people) and a search', () => {
        const html = render();
        expect(tag(html, 'data-issues-source="any"')).toContain('aria-pressed="true"');
        expect(tag(html, 'data-issues-source="feedback"')).toMatch(/aria-label="From people"/);
        expect(html).toMatch(/<input[^>]*aria-label="Search issues"/);
    });

    it('offers a New issue button, an icon named for a screen reader', () => {
        expect(tag(render(), 'data-issues-new')).toMatch(/aria-label="New issue"/);
    });
});

describe('the cards', () => {
    it('show the number, the title as text (never markup), who raised it, the type as an icon, GitHub, and a closed status', () => {
        const html = render();
        expect(html).toContain('#7');
        expect(html).toContain('Dark &lt;mode&gt;');
        expect(html).toContain('Ada');
        expect(tag(html, 'data-issue-type="fix"')).toMatch(/aria-label="Fix"/);
        expect(html).toContain('acme/app#42');
        expect(el(html, 'data-issue-status-chip="resolved"')).toMatch(/Resolved/);
        // An open card says nothing about its status; no submitter is a blank, never an invented name.
        expect(html).not.toMatch(/data-issue-status-chip="open"/);
    });

    it('colour the card\'s edge by its type, as tynn.ai does', () => {
        expect(tag(render(), 'data-issue-card="i1"')).toMatch(/border-left-color:var\(--rose-500\)/);
    });

    it('say "No issues match" when nothing does, and offer a new issue', () => {
        const html = render({ state: { state: 'ready', view: QUEUE({ issues: [] }) } });
        expect(html).toContain('No issues match');
        expect(html).toMatch(/data-issues-empty/);
    });

    it('register every type\'s icon (an unregistered name is a blank)', () => {
        for (const look of Object.values(ISSUE_TYPE_LOOK)) expect(ICON_NAMES).toContain(look.icon);
    });
});

describe('an open issue', () => {
    it('opens into its form with who raised it, and the triage buttons for a person who may triage', () => {
        const html = render({ open: 'i1' });
        expect(html).toMatch(/data-issue-form="i1"/);
        expect(html).toContain('Raised by Ada');
        for (const a of ['delete', 'resolve', 'discard', 'convert']) expect(html).toMatch(new RegExp(`data-issue-action="${a}"`));
        expect(tag(html, 'data-issue-action="resolve"')).toMatch(/aria-label="Resolve"/);
        expect(html).toMatch(/<select[^>]*aria-label="Convert to a story on"/);
    });

    it('has no triage buttons and no Save for a person who may not triage', () => {
        const html = render({ open: 'i1', state: { state: 'ready', view: QUEUE({ can_triage: false }) } });
        for (const a of ['delete', 'resolve', 'discard', 'convert', 'save']) expect(html).not.toMatch(new RegExp(`data-issue-action="${a}"`));
    });

    it('has no triage buttons on a closed issue', () => {
        const html = render({ open: 'i3' });
        for (const a of ['delete', 'resolve', 'discard', 'convert']) expect(html).not.toMatch(new RegExp(`data-issue-action="${a}"`));
    });

    it('says an issue that is gone is gone', () => {
        expect(render({ open: 'nope' })).toContain('This issue may have been deleted.');
    });

    it('asks for a reason before it resolves or discards', () => {
        const html = render({ open: 'i1', closing: 'issue.discard' });
        expect(html).toMatch(/<textarea[^>]*aria-label="Why is this not being done\?"/);
        expect(tag(html, 'data-issue-confirm-close')).toContain('disabled');
    });
});

describe('a new issue', () => {
    it('opens the web form with its defaults: enhancement, normal, the features to tick', () => {
        const html = render({ open: 'new' });
        expect(html).toMatch(/data-issue-form="new"/);
        expect(html).toMatch(/<select[^>]*aria-label="Type"[\s\S]*?<option value="enhancement" selected/);
        expect(html).toMatch(/<select[^>]*aria-label="Priority"[\s\S]*?<option value="normal" selected/);
        expect(html).toContain('Theming');
        expect(el(html, 'data-issue-action="create"')).toMatch(/Raise issue/);
    });
});

describe('every action says what it is doing', () => {
    it('running, then done — or Tynn\'s reason with Retry', async () => {
        const ops: IssueOp[] = [];
        const ok = await performIssueAction({ act: async () => ({ ok: true, issue: null }) }, 'w1', { action: 'issue.delete', issueId: 'i1' }, (op) => ops.push(op));
        expect(ok.ok).toBe(true);
        expect(ops).toEqual([{ action: 'issue.delete', phase: 'running' }, { action: 'issue.delete', phase: 'done' }]);

        ops.length = 0;
        await performIssueAction({ act: async () => ({ ok: false, state: 'transition-refused', reason: 'Issue #5 is already resolved and cannot be closed again.' }) }, 'w1', { action: 'issue.resolve', issueId: 'i3', body: { reason: 'x' } }, (op) => ops.push(op));
        expect(ops.at(-1)).toEqual({ action: 'issue.resolve', phase: 'failed', reason: 'Issue #5 is already resolved and cannot be closed again.' });

        const failed = render({ open: 'i1', op: { action: 'issue.convert', phase: 'failed', reason: 'This issue has already been converted.' }, onRetry: noop });
        expect(failed).toContain('This issue has already been converted.');
        expect(el(failed, 'data-issue-retry')).toMatch(/Retry/);
        const running = render({ open: 'i1', op: { action: 'issue.convert', phase: 'running' } });
        expect(running).toContain('Converting…');
        expect(tag(running, 'data-issue-action="convert"')).toContain('disabled');
    });
});

describe('the states with nothing to show, and live', () => {
    it('says why there is no queue', () => {
        expect(render({ state: { state: 'loading' } })).toContain('Reading Tynn…');
        expect(render({ state: { state: 'not-linked' } })).toContain('This workspace has no Tynn project.');
        expect(render({ state: { state: 'signed-out', reason: 'Sign in to Tynn again.' } })).toContain('Sign in to Tynn again.');
    });

    it('shows a live icon while it follows Tynn, and reconnecting while the link is down', () => {
        expect(tag(render({ live: 'live' }), 'data-tynn-live')).toMatch(/aria-label="Live: following Tynn"/);
        expect(tag(render({ live: 'reconnecting' }), 'data-tynn-live')).toMatch(/aria-label="Reconnecting to Tynn"/);
    });
});

describe('the tab\'s nav', () => {
    it('lists Issues in tynn.ai\'s place (before WIP and the board) with tynn.ai\'s icon', async () => {
        const { TYNN_SECTIONS } = await import('../src/core/tynn-pages.js');
        const ids = TYNN_SECTIONS.map((s) => s.id);
        expect(ids.indexOf('issues')).toBeGreaterThanOrEqual(0);
        expect(ids.indexOf('issues')).toBeLessThan(ids.indexOf('wip'));
        expect(TYNN_SECTIONS.find((s) => s.id === 'issues')).toMatchObject({ icon: 'sparkles', label: 'Issues' });
    });

    it('offers Issues only where the window can reach it', async () => {
        const { TynnSectionNav } = await import('../src/renderer/components/TynnTab.js');
        expect(renderToStaticMarkup(<TynnSectionNav current="board" onSection={noop} />)).toMatch(/aria-label="Issues"/);
        const without = renderToStaticMarkup(<TynnSectionNav current="board" onSection={noop} offered={['wip', 'board']} />);
        expect(without).not.toMatch(/aria-label="Issues"/);
        expect(without).toMatch(/aria-label="Board"/);
    });

    it('opens the Issues page from the tab when the window has an Issues host', async () => {
        const { TynnTab } = await import('../src/renderer/components/TynnTab.js');
        const board = { read: async () => ({ ok: false as const, state: 'error' as const, reason: 'x' }), act: async () => ({ ok: true as const }), page: async () => ({ ok: false as const, state: 'error' as const, reason: 'x' }) };
        const issues = { read: async () => ({ ok: false as const, state: 'error' as const, reason: 'x' }), act: async () => ({ ok: true as const, issue: null }) };
        const html = renderToStaticMarkup(<TynnTab workspaceId="w1" host={board as never} issues={issues} initialSection="issues" />);
        expect(html).toMatch(/data-tynn-issues-state="loading"/);
        expect(html).toMatch(/data-tynn-section="issues"[^>]*aria-current="page"|aria-current="page"[^>]*data-tynn-section="issues"/);
    });
});
