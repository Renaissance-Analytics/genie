import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { issueWatchPanelView, parseIssueWatchEntry, type IwEvent } from '../src/core/issue-watch.js';
import { parseRoute } from '../src/core/route.js';
import { tabStrip } from '../src/core/workspace-tabs.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';
import { IssueWatchPanel } from '../src/renderer/components/IssueWatchPanel.js';
import { WorkspaceTabs } from '../src/renderer/components/WorkspaceTabs.js';

/**
 * THE PERSON'S OWN VIEW OF ISSUEWATCH (Tynn #806; Genie 1's IssueWatch flyout — "open issues, PRs and security alerts in
 * one feed, without leaving Genie"). Agents hear GitHub through their settings; the person sees it on a GitHub tab of
 * each workspace linked to a Tynn project: what is open, by family — security first — each linked to GitHub, and what
 * happened lately. When there is nothing to show it says WHY (not linked, not signed in, not connected), never an
 * empty "nothing open". Pushed with the rest of the features — nothing polls.
 */
const item = (kind: string, n: number, extra: Record<string, unknown> = {}) => ({ kind, key: `acme/app:${kind}:${n}`, number: n, title: `t${n}`, url: `https://github.com/acme/app/${n}`, updatedAt: 't', owner: 'acme', repo: 'app', ...extra });
const ENTRY = parseIssueWatchEntry({ projectId: 'p1', items: [item('issue', 1), item('pr', 2), item('dependabot', 3, { severity: 'high' }), item('issue', 4)], feedbackItems: [] })!;
const ev = (kind: IwEvent['kind'], n: number, by: string | null = null): IwEvent => ({ kind, item: { key: `k${n}`, kind: 'pr', number: n, repo: 'acme/app', title: `t${n}`, url: `https://github.com/acme/app/pull/${n}`, updatedAt: null, severity: null }, by });

describe('what the panel shows', () => {
    it('live: the counts, then the open items by family — SECURITY FIRST — each with its ref and link (COUNTED)', () => {
        const v = issueWatchPanelView({ state: 'live', linked: true, entry: ENTRY }, []);
        expect(v.line).toEqual({ tone: 'ok', text: 'Live from Tynn' });
        expect(v.counts).toEqual({ issues: 2, prs: 1, security: 1, feedback: 0 });
        expect(v.groups.map((g) => [g.label, g.items.length])).toEqual([['Security alerts', 1], ['Pull requests', 1], ['Issues', 2]]);
        expect(v.groups[0]!.items[0]).toEqual({ ref: 'acme/app#3', title: 't3', url: 'https://github.com/acme/app/3', severity: 'high' });
    });

    it('nothing to show says why — not linked, not signed in, not connected — never an empty "nothing open"', () => {
        expect(issueWatchPanelView({ state: 'live', linked: false }, []).line).toMatchObject({ tone: 'muted', text: expect.stringMatching(/not linked to a Tynn project/) });
        expect(issueWatchPanelView({ state: 'signed-out', linked: true }, []).line).toMatchObject({ tone: 'warn', text: expect.stringMatching(/not signed in to Tynn/) });
        expect(issueWatchPanelView({ state: 'reconnecting', linked: true }, []).line).toMatchObject({ tone: 'warn', text: expect.stringMatching(/not connected/) });
        // CONTROL: live with an entry that has nothing open says THAT, plainly.
        const empty = issueWatchPanelView({ state: 'live', linked: true, entry: parseIssueWatchEntry({ projectId: 'p1', items: [], feedbackItems: [] })! }, []);
        expect(empty.groups).toEqual([]);
        expect(empty.empty).toBe('Nothing open on the watched repos.');
    });

    it('what happened lately: newest first, said the way an agent is told, capped', () => {
        const recent = Array.from({ length: 40 }, (_, i) => ev('pr.new', i));
        const v = issueWatchPanelView({ state: 'live', linked: true, entry: ENTRY }, [ev('comment', 7, 'octo'), ...recent]);
        expect(v.recent).toHaveLength(20);
        expect(v.recent[0]).toEqual({ text: 'New comment: acme/app#7 “t7” by octo', url: 'https://github.com/acme/app/pull/7' });
    });
});

describe('where it lives', () => {
    it('the workspace’s GitHub view is a route of its own', () => {
        expect(parseRoute('genie://workspace/tynn?view=github')).toMatchObject({ surface: 'workspace', view: 'github' });
    });

    it('a GitHub tab after the designed tabs, only for a workspace linked to a Tynn project (CONTROL: not linked, none)', () => {
        expect(tabStrip({ tabs: [] }, [], { github: true }).map((t) => t.kind)).toEqual(['agents', 'github', 'add', 'settings']);
        expect(tabStrip({ tabs: [] }, [], { github: false }).map((t) => t.kind)).toEqual(['agents', 'add', 'settings']);
        const html = renderToStaticMarkup(<WorkspaceTabs designed={{ tabs: [] }} openAgents={[]} current={{ kind: 'view', view: 'github' }} canDesign hasSettings github onView={() => {}} onAdd={() => {}} onOpenAgent={() => {}} onCloseAgent={() => {}} />);
        expect(html).toMatch(/data-workspace-tab="github"[^>]*data-current="true"[^>]*>GitHub</);
    });

    it('the panel: the state line, the counts, every open item linked out to GitHub (COUNTED), the recent activity', () => {
        const v = issueWatchPanelView({ state: 'live', linked: true, entry: ENTRY }, [ev('ci.failed', 9)]);
        const html = renderToStaticMarkup(<IssueWatchPanel view={v} />);
        expect(html).toContain('data-issue-watch-panel=""');
        expect(html).toContain('Live from Tynn');
        expect(html).toMatch(/data-issue-watch-count="security"[^>]*>[^<]*1/);
        const links = html.match(/<a [^>]*data-issue-watch-item=""[^>]*>/g) ?? [];
        expect(links).toHaveLength(4);
        for (const a of links) expect(a).toMatch(/target="_blank"[^>]*rel="noreferrer"|rel="noreferrer"[^>]*target="_blank"/);
        expect(html).toContain('CI failed: acme/app#9');
    });

    it('the features carry it, pushed: none until main reports (EMPTY), and main gives each workspace its view', () => {
        expect(EMPTY_FEATURES.issueWatch).toBeNull();
        const main = readFileSync('src/main/main.ts', 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
        expect(main).toMatch(/issueWatch: \(\) => issueWatchPanels\(\)/);
        expect(main).toMatch(/onEntry: \(entry\) => \{ issueWatchLatest\.set\(entry\.projectId, entry\); pushFeatures\(\); \}/);
    });
});
