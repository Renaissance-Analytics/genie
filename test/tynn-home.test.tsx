import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { detailsBody, parseHome, tynnPageActionRequest, tynnPagePath, TYNN_FIRST_SECTION, TYNN_SECTIONS } from '../src/core/tynn-pages.js';
import { TynnHomePanel } from '../src/renderer/components/TynnHomePanel.js';

/**
 * THE TYNN TAB'S HOME (genie#1295 row H1): tynn.ai's project Home, natively — the tab now opens on it, as tynn.ai's
 * project does. Dashboard: the range and version pickers, the verdict (will the version land?) with its burndown, the
 * rate of work, the versions side by side, throughput, what is waiting and the latest activity. Details: identity,
 * vision and AI guidance (edited in place), knowledge, repositories, members, agents, the workflow settings (edited in
 * place), pending approvals and related counts. Every save says running, then done, or Tynn's reason with Retry.
 */
const DASHBOARD = {
    project_id: 'p1', section: 'dashboard', details: null,
    dashboard: {
        range: 30,
        metrics: { velocity: 1.5, tasks_done: 45, corrections: 2, stories_done: 6, agent_contribution: 60, velocity_avg: 1.4, velocity_trend: 'up', velocity_change_percent: 12.3 },
        taskBreakdown: { done: 10, doing: 2 },
        storyBreakdown: { done: 3, in_progress: 1 },
        sparkline: [0, 1, 2],
        charts: { velocity: { labels: ['a', 'b'], series: [{ label: 'Daily', data: [1, 2] }, { label: '7-day avg', data: [1, 1.5] }] }, agentActivity: { labels: ['a'], series: [{ label: 'Agent created', data: [0] }, { label: 'Corrections', data: [0] }] } },
        availableVersions: [{ id: 'v1', number: '0.4.0', title: 'Line', status: 'active' }, { id: 'v0', number: '0.3.0', title: 'Old', status: 'released' }],
        version: {
            id: 'v1', number: '0.4.0', title: 'Line', status: 'active', is_activated: true, completion_percent: 50, completed_tasks: 5, total_tasks: 10, completed_stories: 1, total_stories: 3, cycle_time_days: 2.5,
            burndown: { labels: ['d1'], series: [{ label: 'Remaining', data: [5] }] },
            creep: { at_activation: 8, added_after: 2, percent: 25, status: 'warning' },
            eta: null, window: { starts_at: '2026-10-01', ends_at: '2026-11-15' },
            forecast: { tone: 'on_track', label: 'On track', eta_date: '2026-11-10', target_date: '2026-11-15', days_delta: 5, remaining_tasks: 5 },
        },
        versionComparison: [{ id: 'v1', number: '0.4.0', title: 'Line', status: 'active', stories_total: 3, stories_done: 1, tasks_total: 10, tasks_done: 5, scope_added: 2, cycle_time_days: 2.5, starts_at: null, ends_at: null }],
        attention: [{ id: 's1', slug: 'stuck', title: 'Stuck <thing>', status: 'blocked', open_tasks: 2, updated_at: null }],
        recentActivity: [{ id: 'a1', actor: 'Wish', actor_type: 'user', action: 'created story', subject_label: 'Ship it', when: '2 minutes ago' }],
    },
};
const DETAILS = {
    project_id: 'p1', section: 'details', dashboard: null,
    details: {
        can_edit: true,
        identity: { name: 'Tynn', slug: 'tynn', status: 'active', owner_name: 'Wish Born', owner_type: 'User', visibility: 'private', mcp_slug: 'tynn', mcp_url: 'https://tynn.ai/mcp/tynn', created_at: 'Jan 1, 2026', updated_at: '1 day ago', ops: null },
        vision: 'Ship <the> board',
        ai_guidance: 'Be kind',
        knowledge: { personas: [{ name: 'Genie user', role: 'dev' }], strategic_themes: [], constraints: ['No bandaids'], risk_register: [], technologies: [{ name: 'Laravel' }], scripts: [], integration_catalog: [], servers: [], design_tokens: [] },
        repositories: [{ id: 'r1', url: 'https://github.com/x/y', short: 'x/y', is_primary: true, default_branch: 'main' }],
        members: [{ id: 'u1', name: 'Wish Born', email: 'w@x', initials: 'WB', role: 'owner' }],
        agents: [{ id: 'g1', name: 'tynn-slave', status: 'active', persona_role: 'builder', active_token_count: 1 }],
        workflow: { versioning_pattern: 'semantic', versioning_patterns: [{ key: 'semantic', label: 'Semantic' }], auto_version_number: true, max_active_versions: 1, feature_locking: false, claim_tasks: 'optional', claimant_policy: 'any', hitl_policy: null },
        approvals: [{ id: 'q1', action: 'release', surface: 'version', subject_label: '0.4.0', agent_id: 'g1', created_at: '1 hour ago' }],
        related: { versions: { total: 4, counts: { active: 1 } }, counts: { stories: 9, stories_done: 3, tasks: 20, tasks_done: 10, features: 2, issues: 5 }, activity: [] },
    },
};
const noop = () => {};

describe('reading the Home', () => {
    it('reads the dashboard: range, versions, verdict, rate of work, comparison, attention, activity', () => {
        const home = parseHome(DASHBOARD)!;
        expect(home.section).toBe('dashboard');
        expect(home.dashboard?.range).toBe(30);
        expect(home.dashboard?.version?.forecast.label).toBe('On track');
        expect(home.dashboard?.attention[0]).toMatchObject({ slug: 'stuck', status: 'blocked', openTasks: 2 });
        expect(home.details).toBeNull();
    });

    it('reads the details, and anything else as nothing', () => {
        const home = parseHome(DETAILS)!;
        expect(home.details?.vision).toBe('Ship <the> board');
        expect(home.details?.canEdit).toBe(true);
        expect(home.details?.workflow.claimTasks).toBe('optional');
        expect(parseHome({ releases: [] })).toBeNull();
    });

    it('is read at the Home door with the section, range and version asked for; the Details write has its own door', () => {
        expect(tynnPagePath('p1', 'home', {})).toBe('/api/v1/projects/p1/home');
        expect(tynnPagePath('p1', 'home', { section: 'details' })).toBe('/api/v1/projects/p1/home?section=details');
        expect(tynnPagePath('p1', 'home', { section: 'dashboard', range: '7', version: 'v0' })).toBe('/api/v1/projects/p1/home?section=dashboard&range=7&version=v0');
        expect(tynnPagePath('p1', 'home', { range: '5' })).toBe('/api/v1/projects/p1/home');
        expect(tynnPageActionRequest('p1', 'details.update')).toEqual({ method: 'PATCH', path: '/api/v1/projects/p1/details' });
    });

    it('sends only the Details fields the web form takes', () => {
        expect(detailsBody({ vision: 'v', claim_tasks: 'off', name: 'x', danger: 1 })).toEqual({ vision: 'v', claim_tasks: 'off', name: 'x' });
        expect(detailsBody({ danger: 1 })).toBeNull();
    });

    it('is the tab\'s first page, with tynn.ai\'s house', () => {
        expect(TYNN_SECTIONS[0]).toMatchObject({ id: 'home', icon: 'home', label: 'Home' });
        expect(TYNN_FIRST_SECTION).toBe('home');
    });
});

describe('the Home page', () => {
    const render = (over: Partial<Parameters<typeof TynnHomePanel>[0]> = {}) =>
        renderToStaticMarkup(<TynnHomePanel state={{ state: 'ready', view: parseHome(DASHBOARD)! }} onQuery={noop} onSave={noop} {...over} />);

    it('dashboard: the section switch, the range pills, the verdict and the rate of work', () => {
        const html = render();
        expect(html).toMatch(/data-home-section="dashboard"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-home-section="dashboard"/);
        expect(html).toMatch(/data-home-range="30"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-home-range="30"/);
        expect(html).toContain('Will v0.4.0 land?');
        expect(html).toContain('On track');
        expect(html).toContain('Lands');
        expect(html).toContain('5 tasks left');
        expect(html).toContain('Velocity');
    });

    it('dashboard: what is waiting (as text), the comparison and the latest activity', () => {
        const html = render();
        expect(html).toContain('Stuck &lt;thing&gt;');
        expect(html).toContain('2 open tasks');
        expect(html).toMatch(/data-home-comparison/);
        expect(html).toContain('created story');
    });

    it('details: identity, vision as text, knowledge, members, agents, workflow, approvals and counts; edits for a manager', () => {
        const html = render({ state: { state: 'ready', view: parseHome(DETAILS)! } });
        expect(html).toContain('Ship &lt;the&gt; board');
        expect(html).toContain('Be kind');
        expect(html).toContain('No bandaids');
        expect(html).toContain('Laravel');
        expect(html).toContain('x/y');
        expect(html).toContain('tynn-slave');
        expect(html).toContain('release');
        expect(html).toMatch(/data-home-edit="vision"/);
        expect(html).toMatch(/data-home-workflow="claim_tasks"/);
    });

    it('details: no edit for someone who may not manage the project', () => {
        const view = parseHome({ ...DETAILS, details: { ...DETAILS.details, can_edit: false } })!;
        const html = render({ state: { state: 'ready', view } });
        expect(html).not.toMatch(/data-home-edit="vision"/);
    });

    it('a save says running, then Tynn\'s reason with Retry', () => {
        const view = parseHome(DETAILS)!;
        expect(render({ state: { state: 'ready', view, op: { action: 'details.update', phase: 'running' } } })).toMatch(/data-tynn-op="running"/);
        const failed = render({ state: { state: 'ready', view, op: { action: 'details.update', phase: 'failed', reason: 'The slug format is invalid.' } }, onRetry: noop });
        expect(failed).toContain('The slug format is invalid.');
        expect(failed).toMatch(/data-tynn-retry/);
    });

    it('nothing to show says why', () => {
        expect(render({ state: { state: 'loading' } })).toMatch(/data-tynn-page-state="loading"/);
        expect(render({ state: { state: 'signed-out', reason: 'Sign in to Tynn again.' } })).toContain('Sign in to Tynn again.');
    });
});
