import { describe, expect, it } from 'vitest';
import { IW_EVENT_KINDS, issueWatchNotice, parseIssueWatchActivity, type IwEvent } from '../src/core/issue-watch.js';
import { IssueWatchClient, type IssueWatchClientPorts } from '../src/main/issue-watch-client.js';

/**
 * WHAT HAPPENED ON GITHUB, NOT ONLY WHAT IS OPEN (Tynn #806; the owner: webhooks "Now, with the first release").
 *
 * Tynn's GitHub App webhook turns a comment, a review, a push to a PR, or a CI run finishing into `issuewatch.activity`
 * on the person's channel (facts only — never a body). Genie makes each one an event an agent can choose — new kinds,
 * off until chosen (the owner's defaults are new issues, PRs and security) — told with who did it and, for a review or
 * a CI run, how it went. They are news, not state: each is told once, with no baseline.
 */
const act = (events: unknown[]) => ({ workspaceId: 'p1', projectId: 'p1', events });
const comment = { kind: 'comment', repo: 'acme/app', number: 41, pr: true, title: 'Fix login', author: 'octo', state: null, url: 'https://github.com/acme/app/pull/41#c1' };

describe('reading an activity', () => {
    it('each kind it reports: a comment, a review (its state), a push, a CI run that failed or passed', () => {
        const a = parseIssueWatchActivity(act([
            comment,
            { ...comment, kind: 'review', state: 'changes_requested', author: 'rev', url: 'r' },
            { ...comment, kind: 'push', author: 'dev', url: 'p' },
            { ...comment, kind: 'ci', state: 'failure', title: 'fix-login', author: null, url: 'c1' },
            { ...comment, kind: 'ci', state: 'success', title: 'fix-login', author: null, url: 'c2' },
        ]))!;
        expect(a.projectId).toBe('p1');
        expect(a.events.map((e) => e.kind)).toEqual(['comment', 'review', 'push', 'ci.failed', 'ci.passed']);
        expect(a.events[0]!.item).toMatchObject({ repo: 'acme/app', number: 41, title: 'Fix login', url: 'https://github.com/acme/app/pull/41#c1' });
        expect(a.events[0]!.by).toBe('octo');
        expect(a.events[1]!.state).toBe('changes_requested');
    });

    it('not reported: a CI run neither failed nor passed (neutral, skipped), a kind it does not know, a broken entry (COUNTED)', () => {
        const a = parseIssueWatchActivity(act([
            { ...comment, kind: 'ci', state: 'neutral' },
            { ...comment, kind: 'ci', state: 'cancelled' },
            { ...comment, kind: 'mystery' },
            { kind: 'comment' },
            comment,
        ]))!;
        expect(a.events.map((e) => e.kind)).toEqual(['ci.failed', 'comment']);
        expect(parseIssueWatchActivity(null)).toBeNull();
        expect(parseIssueWatchActivity({ events: [] })).toBeNull();
    });
});

describe('the kinds an agent can choose', () => {
    it('five more rows, OFF until chosen — the defaults stay new issues, PRs, security and feedback', () => {
        const kinds = IW_EVENT_KINDS.map((k) => k.kind);
        for (const k of ['comment', 'review', 'push', 'ci.failed', 'ci.passed'] as const) {
            expect(kinds).toContain(k);
            expect(IW_EVENT_KINDS.find((x) => x.kind === k)!.default).toBe(false);
        }
        expect(IW_EVENT_KINDS.filter((k) => k.default).map((k) => k.kind)).toEqual(['issue.new', 'pr.new', 'security.new', 'feedback.new']);
    });
});

describe('what the agent is told', () => {
    it('who did it and how it went, the title quoted as data', () => {
        const a = parseIssueWatchActivity(act([
            { ...comment, kind: 'review', state: 'changes_requested', author: 'rev', url: 'https://github.com/acme/app/pull/41#r1' },
            { ...comment, kind: 'ci', state: 'failure', title: 'fix-login', author: null, url: 'https://github.com/acme/app/commit/abc/checks' },
        ]))!;
        const text = issueWatchNotice(a.events, { workspace: 'tynn', mode: 'automated' });
        expect(text).toMatch(/Review \[changes requested\]: acme\/app#41 “Fix login” by rev https:\/\/github\.com\/acme\/app\/pull\/41#r1/);
        expect(text).toMatch(/CI failed: acme\/app#41 “fix-login” https:\/\/github\.com\/acme\/app\/commit\/abc\/checks/);
    });
});

describe('the client hears them', () => {
    it('an activity on its channel goes straight to its project — news, no baseline; another channel’s does not (COUNTED)', async () => {
        const heard: Array<{ projectId: string; events: IwEvent[] }> = [];
        const sent: string[] = [];
        let emit: (frame: unknown) => void = () => {};
        const ports: IssueWatchClientPorts = {
            // The signed-in session (person 1) on Genie 1's routes.
            tynn: () => ({ userId: '1', request: async (path) => ({ ok: true, status: 200, json: async () => (path === '/api/v1/broadcasting-config' ? { key: 'k', cluster: 'us2' } : path === '/api/v1/user/broadcasting-auth' ? { auth: 'k:s' } : { workspaces: [] }) }) }),
            socket: () => {
                const l: Record<string, Array<(e: { data?: unknown }) => void>> = {};
                emit = (frame) => { for (const f of l.message ?? []) f({ data: JSON.stringify(frame) }); };
                return { send: (d: string) => { sent.push(d); }, close: () => {}, addEventListener: (t: string, f: (e: { data?: unknown }) => void) => { (l[t] ??= []).push(f); } };
            },
            schedule: () => () => {},
            onEvents: (projectId, events) => { heard.push({ projectId, events }); },
        };
        const client = new IssueWatchClient(ports);
        client.start();
        await new Promise((r) => setTimeout(r, 0));
        emit({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '1.2' }) });
        await new Promise((r) => setTimeout(r, 0));
        emit({ event: 'pusher_internal:subscription_succeeded', channel: 'private-App.Models.User.1', data: '{}' });
        await new Promise((r) => setTimeout(r, 0));

        emit({ event: 'issuewatch.activity', channel: 'private-App.Models.User.9', data: JSON.stringify(act([comment])) });
        emit({ event: 'issuewatch.activity', channel: 'private-App.Models.User.1', data: JSON.stringify(act([comment])) });
        expect(heard).toHaveLength(1);
        expect(heard[0]).toMatchObject({ projectId: 'p1' });
        expect(heard[0]!.events.map((e) => e.kind)).toEqual(['comment']);
    });
});
