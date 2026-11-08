import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { featureRingIds, featuresActionRequest, featuresBody, featuresChannel, parseFeatures } from '../src/core/tynn-features.js';
import { parseTynnPage, tynnPagePath, TYNN_PAGES, TYNN_SECTIONS } from '../src/core/tynn-pages.js';
import { TynnFeaturesForm, TynnFeaturesPanel } from '../src/renderer/components/TynnFeaturesPanel.js';
import { TynnTab } from '../src/renderer/components/TynnTab.js';

/**
 * THE TYNN TAB'S FEATURES (genie#1295 row F1, Tynn story #325, workspace-ux 0.10.0 surface `features`): tynn.ai's
 * Features page, natively. Four tabs (Features, Domains, Models, Repositories), each with its count; a feature shows its
 * title, domain and tasks done of total; a domain its description and how many features it holds; a repository its
 * label, url, branch, kind and (a product) its release cycle; a model its table and field count, read only. A person who
 * may manage the project (`can_manage`) adds, edits and deletes features, domains and repositories with the web form's
 * fields and limits; nobody edits models. A workspace with no `.agi` container is offered one on the Repositories tab.
 *
 * The answers follow tynn.ai's ProjectFeaturesPage builder (app/Services/Features/ProjectFeaturesPage.php at 9772e4e9).
 */
const FEATURES = {
    project_id: 'p1',
    features: [
        { id: 'f1', title: 'Board <live>', slug: 'board-live', description: 'Cards move live', docs_url: 'https://docs.example/board', domain_id: 'd1', domain: 'Work', task_count: 4, task_done: 3 },
        { id: 'f2', title: 'Mail', slug: 'mail', description: null, docs_url: null, domain_id: null, domain: null, task_count: 0, task_done: 0 },
    ],
    domains: [{ id: 'd1', name: 'Work', slug: 'work', description: 'Planning and doing', feature_count: 1 }],
    repositories: [
        { id: 'r1', url: 'git@github.com:x/tynn.git', default_branch: 'main', scm_provider: 'github', repo_mode: null, ci_provider: null, ci_config_path: null, codeowners_path: null, kind: 'code', is_product: true, label: 'x/tynn', github_url: 'https://github.com/x/tynn', versioning_pattern: 'semantic', versioning_pattern_label: 'Semantic', release_cycle: 'per_release', git_linkage: 'tag' },
    ],
    models: [{ id: 'm1', name: 'Story', table: 'stories', description: 'A unit of work', field_count: 12 }],
    envelope_status: 'none',
    can_manage: true,
};
const noop = () => {};

describe('reading Features', () => {
    it('reads features, domains, repositories, models, the envelope and who may manage', () => {
        const v = parseFeatures(FEATURES)!;
        expect(v.features.map((f) => f.id)).toEqual(['f1', 'f2']);
        expect(v.features[0]).toMatchObject({ title: 'Board <live>', domainId: 'd1', domain: 'Work', docsUrl: 'https://docs.example/board', tasks: 4, done: 3 });
        expect(v.features[1]).toMatchObject({ description: null, domainId: null, domain: null, tasks: 0, done: 0 });
        expect(v.domains[0]).toMatchObject({ id: 'd1', name: 'Work', description: 'Planning and doing', features: 1 });
        expect(v.repositories[0]).toMatchObject({ id: 'r1', url: 'git@github.com:x/tynn.git', label: 'x/tynn', kind: 'code', isProduct: true, branch: 'main', releaseCycle: 'per_release', pattern: 'semantic' });
        expect(v.models[0]).toEqual({ id: 'm1', name: 'Story', table: 'stories', description: 'A unit of work', fields: 12 });
        expect(v.envelope).toBe('none');
        expect(v.canManage).toBe(true);
        expect(parseFeatures({ ...FEATURES, can_manage: false })!.canManage).toBe(false);
        expect(parseFeatures({ ...FEATURES, envelope_status: 'present' })!.envelope).toBe('present');
        expect(parseFeatures({ releases: [] })).toBeNull();
        expect(parseTynnPage('features', FEATURES)).toMatchObject({ page: 'features', view: { canManage: true } });
    });

    it('is read whole at the Features door: the page takes no query', () => {
        expect(TYNN_PAGES).toContain('features');
        expect(tynnPagePath('p1', 'features', { tab: 'domains', project_id: 'other' })).toBe('/api/v1/projects/p1/features');
    });

    it('is a page of the tab after Releases, with tynn.ai\'s layout-grid', () => {
        const ids = TYNN_SECTIONS.map((s) => s.id);
        expect(ids.indexOf('features')).toBe(ids.indexOf('releases') + 1);
        expect(TYNN_SECTIONS.find((s) => s.id === 'features')).toMatchObject({ icon: 'layout-grid', label: 'Features' });
    });

    it('follows the page\'s own channel; a ring names the feature or domain', () => {
        expect(featuresChannel('p1')).toBe('private-project-features.p1');
        expect(featureRingIds('feature.updated', { feature: { id: 'f1' } })).toEqual(['f1']);
        expect(featureRingIds('domain.deleted', { domain: { id: 'd1' } })).toEqual(['d1']);
        expect(featureRingIds('feature.updated', null)).toEqual([]);
    });
});

describe('writing Features, Domains and Repositories', () => {
    it('each write goes to its own door; a row\'s write names the row, and nothing else is offered', () => {
        expect(featuresActionRequest('p1', 'feature.create', null)).toEqual({ method: 'POST', path: '/api/v1/projects/p1/features' });
        expect(featuresActionRequest('p1', 'feature.update', 'f/1')).toEqual({ method: 'PATCH', path: '/api/v1/projects/p1/features/f%2F1' });
        expect(featuresActionRequest('p1', 'feature.delete', 'f1')).toEqual({ method: 'DELETE', path: '/api/v1/projects/p1/features/f1' });
        expect(featuresActionRequest('p1', 'domain.create', null)).toEqual({ method: 'POST', path: '/api/v1/projects/p1/domains' });
        expect(featuresActionRequest('p1', 'domain.update', 'd1')).toEqual({ method: 'PATCH', path: '/api/v1/projects/p1/domains/d1' });
        expect(featuresActionRequest('p1', 'domain.delete', 'd1')).toEqual({ method: 'DELETE', path: '/api/v1/projects/p1/domains/d1' });
        expect(featuresActionRequest('p1', 'repository.create', null)).toEqual({ method: 'POST', path: '/api/v1/projects/p1/repositories' });
        expect(featuresActionRequest('p1', 'repository.update', 'r1')).toEqual({ method: 'PATCH', path: '/api/v1/projects/p1/repositories/r1' });
        expect(featuresActionRequest('p1', 'repository.delete', 'r1')).toEqual({ method: 'DELETE', path: '/api/v1/projects/p1/repositories/r1' });
        // A row's write without its row, the read, a model write and an unknown action are not requests.
        expect(featuresActionRequest('p1', 'feature.update', null)).toBeNull();
        expect(featuresActionRequest('p1', 'features.read', null)).toBeNull();
        expect(featuresActionRequest('p1', 'model.update', 'm1')).toBeNull();
        expect(featuresActionRequest('p1', 'constructor', null)).toBeNull();
    });

    it('sends only the web form\'s fields, refusing in words what the form would refuse', () => {
        expect(featuresBody('feature.create', { title: ' Board ', description: 'Cards', domain_id: '', docs_url: '', slug: 'x', project_id: 'other' }))
            .toEqual({ ok: true, body: { title: 'Board', description: 'Cards', domain_id: null, docs_url: null } });
        expect(featuresBody('feature.create', { title: '', description: 'Cards' })).toEqual({ ok: false, reason: 'A feature needs a title.' });
        expect(featuresBody('feature.update', { title: 'Board', description: ' ' })).toEqual({ ok: false, reason: 'A feature needs a description.' });
        expect(featuresBody('feature.create', { title: 'x'.repeat(25), description: 'd' })).toEqual({ ok: false, reason: 'A feature\'s title is at most 24 characters.' });
        expect(featuresBody('domain.create', { name: 'Work', description: '', feature_count: 9 })).toEqual({ ok: true, body: { name: 'Work', description: null } });
        expect(featuresBody('domain.update', { name: '' })).toEqual({ ok: false, reason: 'A domain needs a name.' });
        expect(featuresBody('domain.create', { name: 'y'.repeat(25) })).toEqual({ ok: false, reason: 'A domain\'s name is at most 24 characters.' });
        expect(featuresBody('repository.create', { url: ' https://github.com/x/y ', default_branch: 'main', kind: 'code', versioning_pattern: '', label: 'nope' }))
            .toEqual({ ok: true, body: { url: 'https://github.com/x/y', default_branch: 'main', kind: 'code', versioning_pattern: null } });
        expect(featuresBody('repository.update', { url: '' })).toEqual({ ok: false, reason: 'A repository needs its URL.' });
        expect(featuresBody('feature.delete', { anything: 1 })).toEqual({ ok: true, body: undefined });
    });
});

describe('the Features page', () => {
    const view = parseFeatures(FEATURES)!;
    const render = (over: Partial<Parameters<typeof TynnFeaturesPanel>[0]> = {}) =>
        renderToStaticMarkup(<TynnFeaturesPanel state={{ state: 'ready', view }} onAct={noop} {...over} />);
    const selectedTab = (html: string, tab: string) => new RegExp(`data-features-tab="${tab}"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-features-tab="${tab}"`).test(html);

    it('shows the four tabs as tabs, with their counts, Features first', () => {
        const html = render();
        expect(selectedTab(html, 'features')).toBe(true);
        for (const [tab, n] of [['features', 2], ['domains', 1], ['models', 1], ['repos', 1]] as const) expect(html).toMatch(new RegExp(`data-features-tab="${tab}"[\\s\\S]*?data-features-count="${n}"`));
        expect(html).not.toMatch(/aria-pressed/);
    });

    it('a feature row: title (as text), domain, tasks done of total; Add and Edit for a manager', () => {
        const html = render();
        expect(html).toContain('Board &lt;live&gt;');
        expect(html).not.toContain('<live>');
        expect(html).toContain('Work');
        expect(html).toMatch(/data-feature="f1"[\s\S]*3[\s\S]*4/);
        expect(html).toMatch(/data-features-add="feature"/);
        expect(html).toMatch(/data-features-edit="f1"/);
    });

    it('each other tab: domains, models (read only, even for a manager) and repositories', () => {
        const domains = render({ initialTab: 'domains' });
        expect(selectedTab(domains, 'domains')).toBe(true);
        expect(domains).toMatch(/data-domain="d1"[\s\S]*Planning and doing/);
        expect(domains).toMatch(/data-features-add="domain"/);
        const models = render({ initialTab: 'models' });
        expect(models).toMatch(/data-model="m1"[\s\S]*stories[\s\S]*12/);
        expect(models).not.toMatch(/data-features-add=|data-features-edit=/);
        const repos = render({ initialTab: 'repos' });
        expect(repos).toMatch(/data-repository="r1"[\s\S]*x\/tynn[\s\S]*main/);
        expect(repos).toContain('per release');
        expect(repos).toMatch(/data-features-add="repository"/);
    });

    it('offers the .agi container only where there is none and the person may manage (controls: present, and a viewer)', () => {
        expect(render({ initialTab: 'repos' })).toMatch(/data-features-envelope-offer/);
        expect(render({ initialTab: 'repos', state: { state: 'ready', view: parseFeatures({ ...FEATURES, envelope_status: 'present' })! } })).not.toMatch(/data-features-envelope-offer/);
        expect(render({ initialTab: 'repos', state: { state: 'ready', view: parseFeatures({ ...FEATURES, can_manage: false })! } })).not.toMatch(/data-features-envelope-offer/);
    });

    it('a viewer reads every tab and is offered no add, edit or delete', () => {
        const viewer = parseFeatures({ ...FEATURES, can_manage: false })!;
        for (const tab of ['features', 'domains', 'models', 'repos'] as const) {
            const html = render({ initialTab: tab, state: { state: 'ready', view: viewer } });
            expect(html).not.toMatch(/data-features-add=|data-features-edit=/);
        }
        expect(render({ state: { state: 'ready', view: viewer } })).toContain('Board &lt;live&gt;');
    });

    it('an empty tab says so, and offers to add one to a manager only', () => {
        const empty = parseFeatures({ ...FEATURES, features: [], domains: [], repositories: [], models: [] })!;
        const html = render({ state: { state: 'ready', view: empty } });
        expect(html).toMatch(/data-features-empty="features"[\s\S]*No features defined yet/);
        expect(html).toMatch(/data-features-add="feature"/);
        expect(render({ initialTab: 'models', state: { state: 'ready', view: empty } })).toMatch(/data-features-empty="models"/);
    });

    it('a write says running, then done, or Tynn\'s reason with Retry; nothing to show says why; live is an icon', () => {
        expect(render({ state: { state: 'ready', view, op: { action: 'feature.create', phase: 'running' } } })).toMatch(/data-tynn-op="running"/);
        const failed = render({ state: { state: 'ready', view, op: { action: 'feature.create', phase: 'failed', reason: 'The title has already been taken.' } }, onRetry: noop });
        expect(failed).toContain('The title has already been taken.');
        expect(failed).toMatch(/data-tynn-retry/);
        expect(render({ state: { state: 'loading' } })).toMatch(/data-tynn-page-state="loading"/);
        expect(render({ state: { state: 'not-linked' } })).toContain('This workspace has no Tynn project.');
        expect(render({ state: { state: 'signed-out', reason: 'Sign in to Tynn again.' } })).toContain('Sign in to Tynn again.');
        expect(render({ live: 'live' })).toMatch(/data-tynn-live="live"/);
        expect(render({ live: 'reconnecting' })).toMatch(/data-tynn-live="reconnecting"/);
    });
});

describe('the forms are the web forms, with their limits', () => {
    const view = parseFeatures(FEATURES)!;
    const form = (props: Parameters<typeof TynnFeaturesForm>[0]) => renderToStaticMarkup(<TynnFeaturesForm {...props} />);

    it('a feature: title (24 at most), description, domain (or none) and docs link; an edit can delete', () => {
        const add = form({ kind: 'feature', row: null, view, onSubmit: noop, onCancel: noop });
        expect(add).toMatch(/data-features-field="title"[\s\S]*maxlength="24"|maxlength="24"[\s\S]*data-features-field="title"/i);
        for (const f of ['description', 'domain_id', 'docs_url']) expect(add).toMatch(new RegExp(`data-features-field="${f}"`));
        expect(add).toContain('Create feature');
        expect(add).not.toMatch(/data-features-delete/);
        const edit = form({ kind: 'feature', row: view.features[0]!, view, onSubmit: noop, onCancel: noop, onDelete: noop });
        expect(edit).toMatch(/data-features-delete/);
        expect(edit).toContain('Board &lt;live&gt;');
    });

    it('a domain: name (24 at most) and description', () => {
        const add = form({ kind: 'domain', row: null, view, onSubmit: noop, onCancel: noop });
        expect(add).toMatch(/data-features-field="name"[\s\S]*maxlength="24"|maxlength="24"[\s\S]*data-features-field="name"/i);
        expect(add).toMatch(/data-features-field="description"/);
        expect(add).toContain('Create domain');
    });

    it('a repository: the web form\'s fields; the container offer opens it as the container, with no URL guessed', () => {
        const add = form({ kind: 'repository', row: null, view, onSubmit: noop, onCancel: noop });
        for (const f of ['url', 'kind', 'versioning_pattern', 'default_branch', 'scm_provider', 'ci_provider', 'ci_config_path', 'codeowners_path']) expect(add).toMatch(new RegExp(`data-features-field="${f}"`));
        expect(add).toContain('Add repository');
        const container = form({ kind: 'repository', row: null, view, container: true, onSubmit: noop, onCancel: noop });
        expect(container).not.toMatch(/data-features-field="versioning_pattern"/);
        expect(container).toMatch(/data-features-field="url"[^>]*value=""|value=""[^>]*data-features-field="url"/);
    });
});

describe('the tab offers Features where the window can read pages', () => {
    const refused = async () => ({ ok: false as const, state: 'error' as const, reason: 'x' });
    it('opens Features from the nav with a page door; without one it is not offered', () => {
        const withPages = { read: refused, act: async () => ({ ok: true as const }), page: refused, pageAct: refused };
        const html = renderToStaticMarkup(<TynnTab workspaceId="w1" host={withPages as never} initialSection="features" />);
        expect(html).toMatch(/data-tynn-section="features"/);
        expect(html).toMatch(/data-tynn-page-state="loading"/);
        const boardOnly = { read: refused, act: async () => ({ ok: true as const }) };
        expect(renderToStaticMarkup(<TynnTab workspaceId="w1" host={boardOnly as never} />)).not.toMatch(/data-tynn-section="features"/);
    });
});
