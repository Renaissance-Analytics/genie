import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { detailsBody, homeActionRequest, parseHome, parseTynnPage, tynnPagePath, TYNN_FIRST_SECTION, TYNN_PAGES, TYNN_SECTIONS } from '../src/core/tynn-pages.js';
import { TynnHomePanel } from '../src/renderer/components/TynnHomePanel.js';
import { TynnTab } from '../src/renderer/components/TynnTab.js';

/**
 * THE TYNN TAB'S HOME (genie#1295 row H1, workspace-ux 0.9.0 surface `home`): tynn.ai's project Home, natively. The tab
 * opens on it, as tynn.ai's project does. Dashboard: the range and version pickers, the verdict (will the version land?)
 * with its burndown, the rate of work, the versions side by side, throughput, what is waiting and the latest activity.
 * Details: identity, vision and AI guidance (edited in place), knowledge, repositories, members, agents, the workflow
 * settings (edited in place), pending approvals and related counts. Every save says running, then done, or Tynn's reason
 * with Retry. Read through the host's page door (genie-host `engine.tynnPage`), like WIP and Releases.
 *
 * The answers below follow tynn.ai's ProjectHome builder (app/Services/Workspace/ProjectHome.php at 7cd8ef3f): the JSON
 * door answers recentActivity as a bare list, the web page wraps it in `data`.
 */
const DASHBOARD = {
    project_id: 'p1', section: 'dashboard', details: null,
    dashboard: {
        range: 30,
        metrics: { velocity: 1.5, tasks_done: 45, corrections: 2, stories_done: 6, agent_contribution: 60, velocity_avg: 1.4, velocity_trend: 'up', velocity_change_percent: 12.3 },
        taskBreakdown: { done: 10, doing: 2 },
        storyBreakdown: { done: 3, in_progress: 1 },
        sparkline: [0, 1, 2],
        charts: { velocity: { labels: ['2026-11-01', '2026-11-02'], series: [{ label: 'Daily', data: [1, 2] }, { label: '7-day avg', data: [1, 1.5] }] }, agentActivity: { labels: ['2026-11-01'], series: [{ label: 'Agent created', data: [0] }, { label: 'Corrections', data: [0] }] } },
        availableVersions: [{ id: 'v1', number: '0.4.0', title: 'Line', status: 'active' }, { id: 'v0', number: '0.3.0', title: 'Old', status: 'released' }],
        version: {
            id: 'v1', number: '0.4.0', title: 'Line', status: 'active', is_activated: true, completion_percent: 50, completed_tasks: 5, total_tasks: 10, completed_stories: 1, total_stories: 3, cycle_time_days: 2.5,
            burndown: { labels: ['2026-11-01'], series: [{ label: 'Remaining', data: [5] }, { label: 'Ideal', data: [4] }, { label: 'Total scope', data: [10] }, { label: 'Delivered', data: [5] }] },
            creep: { at_activation: 8, added_after: 2, percent: 25, status: 'warning' },
            eta: null, window: { starts_at: '2026-10-01', ends_at: '2026-11-15' },
            forecast: { tone: 'on_track', label: 'On track', eta_date: '2026-11-10', target_date: '2026-11-15', days_delta: 5, remaining_tasks: 5, velocity: 1.4 },
        },
        versionComparison: [{ id: 'v1', number: '0.4.0', title: 'Line', status: 'active', stories_total: 3, stories_done: 1, tasks_total: 10, tasks_done: 5, scope_added: 2, cycle_time_days: 2.5, starts_at: null, ends_at: null }],
        attention: [{ id: 's1', slug: 'stuck', title: 'Stuck <thing>', status: 'blocked', open_tasks: 2, updated_at: null }],
        recentActivity: [{ id: 'a1', actor: 'Wish', actor_type: 'user', initials: 'W', action: 'created story', subject_label: 'Ship it', when: '2 minutes ago' }],
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
        workflow: { versioning_pattern: 'semantic', versioning_patterns: [{ key: 'semantic', label: 'Semantic' }, { key: 'calendar', label: 'Calendar' }], auto_version_number: true, max_active_versions: 1, feature_locking: false, claim_tasks: 'optional', claimant_policy: 'any', hitl_policy: null },
        approvals: [{ id: 'q1', action: 'release', surface: 'version', subject_label: '0.4.0', agent_id: 'g1', created_at: '1 hour ago' }],
        related: { versions: { total: 4, counts: { active: 1 } }, counts: { stories: 9, stories_done: 3, tasks: 20, tasks_done: 10, features: 2, issues: 5 }, activity: [] },
    },
};
const noop = () => {};
const selectedTab = (html: string, attr: string, value: string) =>
    new RegExp(`${attr}="${value}"[^>]*aria-selected="true"|aria-selected="true"[^>]*${attr}="${value}"`).test(html);

describe('reading the Home', () => {
    it('reads the dashboard: range, versions, verdict, rate of work, comparison, attention, activity', () => {
        const home = parseHome(DASHBOARD)!;
        expect(home.section).toBe('dashboard');
        expect(home.details).toBeNull();
        const d = home.dashboard!;
        expect(d.range).toBe(30);
        expect(d.versions.map((v) => v.id)).toEqual(['v1', 'v0']);
        expect(d.version).toMatchObject({ id: 'v1', completedTasks: 5, totalTasks: 10, cycleTimeDays: 2.5, creep: { atActivation: 8, addedAfter: 2 }, window: { endsAt: '2026-11-15' } });
        expect(d.version!.forecast).toEqual({ tone: 'on_track', label: 'On track', etaDate: '2026-11-10', targetDate: '2026-11-15', daysDelta: 5, remaining: 5 });
        expect(d.attention[0]).toEqual({ id: 's1', slug: 'stuck', title: 'Stuck <thing>', status: 'blocked', openTasks: 2 });
        expect(d.activity[0]).toMatchObject({ actor: 'Wish', agent: false, action: 'created story', subject: 'Ship it', when: '2 minutes ago' });
        // The web page's own shape for the activity list (wrapped in `data`) reads the same.
        expect(parseHome({ ...DASHBOARD, dashboard: { ...DASHBOARD.dashboard, recentActivity: { data: DASHBOARD.dashboard.recentActivity } } })!.dashboard!.activity).toEqual(d.activity);
    });

    it('reads the details, and anything that is not the Home as nothing', () => {
        const home = parseHome(DETAILS)!;
        expect(home.section).toBe('details');
        expect(home.dashboard).toBeNull();
        expect(home.details).toMatchObject({ canEdit: true, vision: 'Ship <the> board', aiGuidance: 'Be kind', related: { versions: 4, counts: { issues: 5 } } });
        expect(home.details!.workflow).toMatchObject({ versioningPattern: 'semantic', claimTasks: 'optional', claimantPolicy: 'any', maxActiveVersions: 1, autoVersionNumber: true, featureLocking: false });
        expect(parseHome({ releases: [] })).toBeNull();
        expect(parseHome({ ...DETAILS, details: null })).toBeNull();
        expect(parseTynnPage('home', DASHBOARD)).toMatchObject({ page: 'home', view: { section: 'dashboard' } });
    });

    it('is read at the Home door with only the section, range and version the contract allows', () => {
        expect(TYNN_PAGES).toContain('home');
        expect(tynnPagePath('p1', 'home', {})).toBe('/api/v1/projects/p1/home');
        expect(tynnPagePath('p1', 'home', { section: 'details' })).toBe('/api/v1/projects/p1/home?section=details');
        expect(tynnPagePath('p1', 'home', { section: 'dashboard', range: '7', version: 'v0' })).toBe('/api/v1/projects/p1/home?section=dashboard&range=7&version=v0');
        expect(tynnPagePath('p1', 'home', { section: 'admin', range: '13', version: '', project_id: 'other' })).toBe('/api/v1/projects/p1/home');
    });

    it('saves the Details at its own door, sending only the fields the web form takes', () => {
        expect(homeActionRequest('p1', 'details.update')).toEqual({ method: 'PATCH', path: '/api/v1/projects/p1/details' });
        expect(homeActionRequest('p1', 'details.delete')).toBeNull();
        expect(detailsBody({ vision: 'v', claim_tasks: 'off', name: 'x', owner_id: 'someone', status: 'archived' })).toEqual({ vision: 'v', claim_tasks: 'off', name: 'x' });
        expect(detailsBody({ owner_id: 'someone' })).toBeNull();
        expect(detailsBody(null)).toBeNull();
    });

    it('is the tab\'s first page, with tynn.ai\'s house', () => {
        expect(TYNN_SECTIONS[0]).toMatchObject({ id: 'home', icon: 'home', label: 'Home' });
        expect(TYNN_FIRST_SECTION).toBe('home');
    });
});

describe('the Home page', () => {
    const render = (over: Partial<Parameters<typeof TynnHomePanel>[0]> = {}) =>
        renderToStaticMarkup(<TynnHomePanel state={{ state: 'ready', view: parseHome(DASHBOARD)! }} onQuery={noop} onSave={noop} {...over} />);

    it('dashboard: the section and range are tabs (never buttons), the verdict and the rate of work', () => {
        const html = render();
        expect(selectedTab(html, 'data-home-section', 'dashboard')).toBe(true);
        expect(selectedTab(html, 'data-home-range', '30')).toBe(true);
        expect(selectedTab(html, 'data-home-range', '7')).toBe(false);
        expect(html).not.toMatch(/aria-pressed/);
        expect(html).toContain('Will v0.4.0 land?');
        expect(html).toContain('On track');
        expect(html).toContain('5 tasks left');
        expect(html).toMatch(/data-home-rate/);
        expect(html).toMatch(/data-home-version/);
    });

    it('dashboard: what is waiting (as text), the comparison and the latest activity', () => {
        const html = render();
        expect(html).toContain('Stuck &lt;thing&gt;');
        expect(html).not.toContain('<thing>');
        expect(html).toContain('2 open tasks');
        expect(html).toMatch(/data-home-comparison/);
        expect(html).toContain('created story');
    });

    it('details: identity, vision as text, knowledge, repositories, members, agents, workflow, approvals and counts', () => {
        const html = render({ state: { state: 'ready', view: parseHome(DETAILS)! } });
        expect(selectedTab(html, 'data-home-section', 'details')).toBe(true);
        expect(html).toContain('Ship &lt;the&gt; board');
        expect(html).toContain('Be kind');
        expect(html).toContain('No bandaids');
        expect(html).toContain('Laravel');
        expect(html).toContain('x/y');
        expect(html).toContain('tynn-slave');
        expect(html).toContain('0.4.0');
        expect(html).toMatch(/data-home-edit="vision"/);
        expect(html).toMatch(/data-home-edit="ai_guidance"/);
        expect(html).toMatch(/data-home-workflow="claim_tasks"/);
    });

    it('details: nothing is editable for someone who may not manage the project (control: a manager above)', () => {
        const view = parseHome({ ...DETAILS, details: { ...DETAILS.details, can_edit: false } })!;
        const html = render({ state: { state: 'ready', view } });
        expect(html).not.toMatch(/data-home-edit=/);
        expect(html).toContain('Ship &lt;the&gt; board');
    });

    it('a save says running, then Tynn\'s reason with Retry', () => {
        const view = parseHome(DETAILS)!;
        expect(render({ state: { state: 'ready', view, op: { action: 'details.update', phase: 'running' } } })).toMatch(/data-tynn-op="running"[\s\S]*Saving/);
        expect(render({ state: { state: 'ready', view, op: { action: 'details.update', phase: 'done' } } })).toMatch(/data-tynn-op="done"[\s\S]*Saved/);
        const failed = render({ state: { state: 'ready', view, op: { action: 'details.update', phase: 'failed', reason: 'The slug format is invalid.' } }, onRetry: noop });
        expect(failed).toContain('The slug format is invalid.');
        expect(failed).toMatch(/data-tynn-retry/);
    });

    it('nothing to show says why, and live shows as an icon', () => {
        expect(render({ state: { state: 'loading' } })).toMatch(/data-tynn-page-state="loading"/);
        expect(render({ state: { state: 'not-linked' } })).toContain('This workspace has no Tynn project.');
        expect(render({ state: { state: 'signed-out', reason: 'Sign in to Tynn again.' } })).toContain('Sign in to Tynn again.');
        expect(render({ live: 'live' })).toMatch(/data-tynn-live="live"/);
        expect(render({ live: 'reconnecting' })).toMatch(/data-tynn-live="reconnecting"/);
    });
});

describe('the tab opens on Home where the window can read pages', () => {
    const refused = async () => ({ ok: false as const, state: 'error' as const, reason: 'x' });
    it('opens on Home with a page door; without one it opens on the board, and Home is not offered', () => {
        const withPages = { read: refused, act: async () => ({ ok: true as const }), page: refused, pageAct: refused };
        const html = renderToStaticMarkup(<TynnTab workspaceId="w1" host={withPages as never} />);
        expect(html).toMatch(/data-tynn-section="home"/);
        expect(html).toMatch(/data-tynn-page-state="loading"/);
        const boardOnly = { read: refused, act: async () => ({ ok: true as const }) };
        const board = renderToStaticMarkup(<TynnTab workspaceId="w1" host={boardOnly as never} />);
        expect(board).not.toMatch(/data-tynn-section="home"/);
        expect(board).not.toMatch(/data-tynn-page-state/);
    });
});
