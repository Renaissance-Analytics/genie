import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { issueWatchPanelView, type IssueWatchSummary } from '../src/core/issue-watch.js';
import { IssueWatchClient, type IssueWatchClientPorts } from '../src/main/issue-watch-client.js';
import { IssueWatchPanel } from '../src/renderer/components/IssueWatchPanel.js';

/**
 * CHOOSE WHICH REPOS FEED A WORKSPACE'S ISSUEWATCH (the owner, 2026-10-21: "Genie 1 had the ability for me to choose what
 * repos are included in the IssueWatch stream, I don't see that option here"). Tynn holds the switch per repo — watch it;
 * for a fork, include its upstream's issues and PRs — and applies it to the feed (Genie 1's checkboxes only ever changed
 * Genie 1's own database once Tynn fed the stream). Genie reads and sets Tynn's switch (tynn.ai#307) and shows it in the
 * GitHub panel as Fancy checkboxes; a change goes to Tynn, which pushes the feed. A Tynn that does not offer it yet (or
 * refuses — every refusal is a 404) is said plainly; no switch is offered that would do nothing.
 */
const repoChoice = () => import('../src/core/issue-watch.js') as Promise<Record<string, any>>;

const TYNN_REPOS = {
    workspaceId: 'p1', entitled: true, tracking: { tracked: true },
    repositories: [
        { slug: 'acme/app', owner: 'acme', repo: 'app', enabled: true, include_upstream: true, is_fork: false, upstream_slug: null, github_connected: true, last_polled_at: null },
        { slug: 'acme/sdk', owner: 'acme', repo: 'sdk', enabled: false, include_upstream: false, is_fork: true, upstream_slug: 'vendor/sdk', github_connected: true, last_polled_at: null },
        { slug: 42, owner: 'x' },
    ],
};

function client(answer: { status: number; json?: unknown }) {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const ports = {
        tynn: () => ({ userId: '42', request: async (path: string, init: { method: string; body?: unknown }) => { requests.push({ method: init.method, path, body: init.body ?? null }); return { ok: answer.status < 300, status: answer.status, json: async () => answer.json }; } }),
        socket: () => { throw new Error('no socket here'); },
        schedule: () => () => {},
        onEvents: () => {},
    } as unknown as IssueWatchClientPorts;
    return { c: new IssueWatchClient(ports) as unknown as Record<string, (...a: unknown[]) => Promise<any>>, requests };
}

describe('reading Tynn’s switches', () => {
    it('each repo with its two switches and its fork facts; a row it cannot read is dropped (counted)', async () => {
        const { parseWatchedRepos } = await repoChoice();
        expect(parseWatchedRepos(TYNN_REPOS)).toEqual({
            entitled: true,
            repos: [
                { slug: 'acme/app', owner: 'acme', repo: 'app', enabled: true, includeUpstream: true, isFork: false, upstreamSlug: null },
                { slug: 'acme/sdk', owner: 'acme', repo: 'sdk', enabled: false, includeUpstream: false, isFork: true, upstreamSlug: 'vendor/sdk' },
            ],
        });
        expect(parseWatchedRepos('nonsense')).toBeNull();
    });

    it('the client asks Tynn for one project’s repos', async () => {
        const { c, requests } = client({ status: 200, json: TYNN_REPOS });
        const r = await c.watchedRepos!('p1');
        expect(requests).toEqual([{ method: 'GET', path: '/api/v1/user/issue-watch/p1/repositories', body: null }]);
        expect(r.ok).toBe(true);
        expect(r.repos.repos.map((x: { slug: string }) => x.slug)).toEqual(['acme/app', 'acme/sdk']);
    });

    it('a Tynn that does not offer it (or refuses: always a 404) is said in words — never an empty list', async () => {
        const r = await client({ status: 404 }).c.watchedRepos!('p1');
        expect(r).toEqual({ ok: false, reason: expect.stringMatching(/Tynn/) });
    });
});

describe('setting a switch', () => {
    it('one repo’s switch goes to Tynn as its own field — the upstream one never restates `enabled`', async () => {
        const { c, requests } = client({ status: 200, json: { ok: true, repository: { slug: 'acme/sdk', enabled: true, include_upstream: false } } });
        await c.setWatchedRepo!('p1', 'acme', 'sdk', { enabled: true });
        await c.setWatchedRepo!('p1', 'acme', 'sdk', { includeUpstream: true });
        expect(requests).toEqual([
            { method: 'POST', path: '/api/v1/user/issue-watch/p1/repositories/acme/sdk', body: { enabled: true } },
            { method: 'POST', path: '/api/v1/user/issue-watch/p1/repositories/acme/sdk', body: { include_upstream: true } },
        ]);
    });

    it('a name that is not owner/repo is refused before anything is sent', async () => {
        const { c, requests } = client({ status: 200, json: {} });
        const r = await c.setWatchedRepo!('p1', 'acme', '../../me', { enabled: false });
        expect(r.ok).toBe(false);
        expect(requests).toEqual([]);
    });
});

describe('the GitHub panel', () => {
    const summary: IssueWatchSummary = { state: 'live', linked: true };
    const render = (watched: unknown, onSetRepo?: () => void) => {
        const view = (issueWatchPanelView as (...a: unknown[]) => any)(summary, [], Date.now(), watched);
        return renderToStaticMarkup(<IssueWatchPanel view={view} {...(onSetRepo ? { onSetRepo } : {})} />);
    };
    const ok = async () => ({ state: 'ok', ...(await repoChoice()).parseWatchedRepos(TYNN_REPOS) });

    it('“Watched repos”: a checkbox per repo, ticked as Tynn has it; a fork also offers its upstream (counted)', async () => {
        const html = render(await ok(), () => {});
        expect(html).toContain('Watched repos');
        expect((html.match(/data-watched-repo="/g) ?? []).length).toBe(2);
        expect(html).toMatch(/data-watched-repo="acme\/app"[^>]*data-enabled="true"/);
        expect(html).toMatch(/data-watched-repo="acme\/sdk"[^>]*data-enabled="false"/);
        expect((html.match(/data-watched-upstream="/g) ?? []).length).toBe(1);
        expect(html).toContain('vendor/sdk');
    });

    it('a Tynn that does not offer it: its reason, and no checkbox that would do nothing', () => {
        const html = render({ state: 'unavailable', reason: 'Tynn did not answer the repo list (HTTP 404)' }, () => {});
        expect(html).toContain('Tynn did not answer the repo list');
        expect(html).not.toContain('data-watched-repo=');
    });

    it('CONTROL: nothing read yet, and no way to set it → no section at all', () => {
        expect(render(null)).not.toContain('Watched repos');
    });
});

describe('the wiring', () => {
    const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
    it('main reads a project’s repos when its first entry arrives, after a change and after a Refresh — no timer', () => {
        const main = src('../src/main/main.ts');
        expect(main).toMatch(/issueWatchLoadRepos\(/);
        expect(main).not.toMatch(/setInterval\([^)]*issueWatchLoadRepos/);
    });

    it('a checkbox is a feature action that sets Tynn’s switch', () => {
        expect(src('../src/main/feature-ipc.ts')).toMatch(/case 'issueWatch\.setRepo':/);
    });
});
