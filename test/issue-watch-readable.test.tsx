import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { issueWatchPanelView, parseIssueWatchEntry, type IssueWatchSummary } from '../src/core/issue-watch.js';
import { IssueWatchPanel } from '../src/renderer/components/IssueWatchPanel.js';

/**
 * THE GITHUB PANEL, READABLE AND HONEST ABOUT ITS AGE (the owner, 2026-10-21, a screenshot of merged PRs still listed:
 * "the issue watch screen is busted. this should be live. This is also very messy and hard to read. You can do better").
 *
 * - HONEST: it said "Live from Tynn" whenever its socket was up, however old the list was. Now it says when Tynn last
 *   sent the list, and a list older than STALE says so in warning words instead of "Live". A Refresh asks Tynn now.
 * - READABLE: one flat list of `owner/repo#N title` rows, every repo mixed. Now grouped by repo — its name once, with
 *   its counts — each row `#N`, the title, who opened it and how long ago; a repo's Dependabot alerts are ONE row
 *   ("3 Dependabot alerts — 1 high") linking to the repo's Dependabot page. Security first, as before.
 * (Why merged PRs stayed listed is Tynn's — it learns of a close only by polling; its webhook part is separate.)
 */
const NOW = Date.parse('2026-10-21T18:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3_600_000;
const M = 60_000;

const raw = {
    projectId: 'p1',
    items: [
        { key: 'g-1051', kind: 'pr', owner: 'Renaissance-Analytics', repo: 'genie', number: 1051, title: 'Site panels are live pages', url: 'https://github.com/Renaissance-Analytics/genie/pull/1051', author: 'wishborn', createdAt: ago(5 * H) },
        { key: 'g-1100', kind: 'issue', owner: 'Renaissance-Analytics', repo: 'genie', number: 1100, title: 'A bug', url: 'https://github.com/Renaissance-Analytics/genie/issues/1100', author: 'pat', createdAt: ago(20 * M) },
        { key: 'c-43', kind: 'pr', owner: 'Renaissance-Analytics', repo: 'genie-cloud', number: 43, title: 'bump source-map-js', url: 'https://github.com/Renaissance-Analytics/genie-cloud/pull/43', author: 'dependabot[bot]', createdAt: ago(72 * H) },
        { key: 'c-d1', kind: 'dependabot', owner: 'Renaissance-Analytics', repo: 'genie-cloud', number: 7, title: 'brace-expansion DoS', url: 'https://github.com/Renaissance-Analytics/genie-cloud/security/dependabot/7', severity: 'high', createdAt: ago(10 * H) },
        { key: 'c-d2', kind: 'dependabot', owner: 'Renaissance-Analytics', repo: 'genie-cloud', number: 8, title: 'vitest path traversal', url: 'https://github.com/Renaissance-Analytics/genie-cloud/security/dependabot/8', severity: 'medium', createdAt: ago(10 * H) },
        { key: 'c-d3', kind: 'dependabot', owner: 'Renaissance-Analytics', repo: 'genie-cloud', number: 9, title: 'js-yaml', url: 'https://github.com/Renaissance-Analytics/genie-cloud/security/dependabot/9', severity: 'low', createdAt: ago(10 * H) },
        { key: 'c-cs1', kind: 'code-scanning', owner: 'Renaissance-Analytics', repo: 'genie-cloud', number: 3, title: 'Log injection', url: 'https://github.com/Renaissance-Analytics/genie-cloud/security/code-scanning/3', severity: 'medium', createdAt: ago(2 * H) },
    ],
    feedbackItems: [],
};
const entry = parseIssueWatchEntry(raw)!;
const summary = (over: Partial<IssueWatchSummary> & { deliveredAt?: number } = {}): IssueWatchSummary => ({ state: 'live', linked: true, entry, ...over }) as IssueWatchSummary;
const view = (over: Partial<IssueWatchSummary> & { deliveredAt?: number } = {}) => (issueWatchPanelView as (...a: unknown[]) => any)(summary(over), [], NOW);

describe('who opened it and when are kept from Tynn’s entry', () => {
    it('author and createdAt survive the parse', () => {
        const pr = entry.items.find((i) => i.key === 'g-1051') as unknown as { author?: string; createdAt?: string };
        expect(pr.author).toBe('wishborn');
        expect(pr.createdAt).toBe(ago(5 * H));
    });
});

describe('grouped by repo', () => {
    it('one group per repo, its name once; a repo with security first (counted)', () => {
        const v = view();
        expect(v.repos.map((r: { repo: string }) => r.repo)).toEqual(['Renaissance-Analytics/genie-cloud', 'Renaissance-Analytics/genie']);
        const genie = v.repos[1];
        expect(genie.rows.map((r: { number: number; author: string; age: string }) => [r.number, r.author, r.age])).toEqual([[1051, 'wishborn', '5h'], [1100, 'pat', '20m']]);
    });

    it('a repo’s Dependabot alerts are ONE row with the worst severity, linking to its Dependabot page; other alerts stay rows', () => {
        const cloud = view().repos[0];
        expect(cloud.dependabot).toEqual({ count: 3, worst: 'high', url: 'https://github.com/Renaissance-Analytics/genie-cloud/security/dependabot' });
        expect(cloud.rows.map((r: { kind: string; number: number }) => [r.kind, r.number])).toEqual([['security', 3], ['pr', 43]]);
    });
});

describe('honest about its age', () => {
    it('live and fresh: says so, with when Tynn last sent it', () => {
        expect(view({ deliveredAt: NOW - 2 * M } as never).line).toEqual({ tone: 'ok', text: 'Live from Tynn · updated 2m ago' });
    });

    it('connected but the list is hours old: a WARNING with its age — never "Live"', () => {
        const line = view({ deliveredAt: NOW - 3 * H } as never).line;
        expect(line.tone).toBe('warn');
        expect(line.text).toMatch(/3h ago/);
        expect(line.text).not.toMatch(/^Live/);
    });

    it('CONTROL: nothing delivered yet keeps the plain state words', () => {
        expect(view().line).toEqual({ tone: 'ok', text: 'Live from Tynn' });
    });
});

describe('the panel', () => {
    const html = (onRefresh?: () => void) => renderToStaticMarkup(<IssueWatchPanel view={view({ deliveredAt: NOW - 2 * M } as never)} {...(onRefresh ? { onRefresh } : {})} />);

    it('a header per repo with its counts; rows never repeat the repo (counted)', () => {
        const h = html();
        expect((h.match(/data-issue-watch-repo="/g) ?? []).length).toBe(2);
        expect((h.match(/Renaissance-Analytics\/genie#/g) ?? []).length).toBe(0);
        expect(h).toContain('#1051');
        expect(h).toContain('wishborn');
        expect(h).toMatch(/3 Dependabot alerts/);
    });

    it('a Refresh asks Tynn now; CONTROL: none without a way to ask', () => {
        expect(html(() => {})).toContain('data-issue-watch-refresh');
        expect(html()).not.toContain('data-issue-watch-refresh');
    });
});

describe('the wiring', () => {
    const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
    it('main records WHEN each entry arrived, and the panel reads it', () => {
        expect(src('../src/main/main.ts')).toMatch(/issueWatchDelivered\.set\(entry\.projectId, Date\.now\(\)\)/);
    });

    it('the Refresh is a feature action that has Tynn read the workspace now', () => {
        expect(src('../src/main/feature-ipc.ts')).toMatch(/case 'issueWatch\.refresh':/);
    });
});
