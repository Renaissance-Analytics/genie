/**
 * THE TYNN TAB'S FEATURES (genie#1295 row F1, Tynn story #325, workspace-ux 0.10.0 surface `features`) — tynn.ai's
 * Features page (Pages/v2/Project/Features.jsx): features, domains (a feature's parent), repositories and models.
 *
 * Read whole at GET /features (the page's own builder, ProjectFeaturesPage), on its own pairing scope. A person who may
 * manage the project (`can_manage`) adds, edits and deletes features, domains and repositories, with the web forms'
 * fields and limits; models are read only for everyone. Live on the page's OWN channel, `private-project-features.{id}`,
 * signed at the page's own door, as the Issues queue is: a feature or domain event is a doorbell, and the page is read
 * again. test/workspace-ux-contract.test.ts holds every constant here to the contract.
 */

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isRow) : []);

/** The surface's own pairing scope (the contract's `scope`). */
export const FEATURES_SCOPE = 'genie:features';
export const FEATURES_DATA_API = { method: 'GET', path: '/features' } as const;
/** The page's tabs, in tynn.ai's order (its Diagram tab is a placeholder there and not in the contract). */
export const FEATURES_TABS = ['features', 'domains', 'models', 'repos'] as const;
export type FeaturesTab = (typeof FEATURES_TABS)[number];
export const FEATURES_ANSWER = ['project_id', 'features', 'domains', 'repositories', 'models', 'envelope_status', 'can_manage'] as const;
export const FEATURES_FIELDS = {
    feature: ['id', 'title', 'slug', 'description', 'docs_url', 'domain_id', 'domain', 'task_count', 'task_done'],
    domain: ['id', 'name', 'slug', 'description', 'feature_count'],
    repository: ['id', 'url', 'default_branch', 'scm_provider', 'repo_mode', 'ci_provider', 'ci_config_path', 'codeowners_path', 'kind', 'is_product', 'label', 'github_url', 'versioning_pattern', 'versioning_pattern_label', 'release_cycle', 'git_linkage'],
    model: ['id', 'name', 'table', 'description', 'field_count'],
} as const;
/** The web forms (FeaturesController::featureRules / domainRules, ProjectRepositories::rules): fields, required, limits. */
export const FEATURES_FORMS = {
    feature: { fields: ['title', 'description', 'domain_id', 'docs_url'], required: ['title', 'description'], max: { title: 24 } },
    domain: { fields: ['name', 'description'], required: ['name'], max: { name: 24 } },
    repository: { fields: ['url', 'default_branch', 'scm_provider', 'repo_mode', 'ci_provider', 'ci_config_path', 'codeowners_path', 'kind', 'versioning_pattern'], required: ['url'], max: {} },
} as const satisfies Readonly<Record<string, { fields: readonly string[]; required: readonly string[]; max: Readonly<Record<string, number>> }>>;
export type FeaturesForm = keyof typeof FEATURES_FORMS;
/** Who may add, edit and delete: the answer's own `can_manage` (Tynn still decides; a refusal is its 404). */
export const FEATURES_MANAGE_GUARD = 'can_manage';
export const FEATURES_ENVELOPE = { field: 'envelope_status', values: ['present', 'none'] } as const;
export const FEATURES_LIVE = {
    channel: 'private-project-features.{projectId}',
    push: { method: 'GET', path: '/api/v1/broadcasting-config', scope: 'genie:discovery' },
    auth: { method: 'POST', path: '/features/broadcasting-auth', body: ['socket_id', 'channel_name'] },
    events: ['feature.created', 'feature.updated', 'feature.deleted', 'domain.created', 'domain.updated', 'domain.deleted'],
    refresh: 'read',
} as const;
export const FEATURES_STATES = ['loading', 'tabs', 'empty', 'feature-row', 'domain-row', 'repository-row', 'model-row', 'form', 'manage', 'envelope-offer', 'refused', 'live', 'reconnecting', 'not-linked', 'signed-out'] as const;
/** Every action the page offers, by the contract's id, at its door (relative to the project's API base). */
export const FEATURES_API: Readonly<Record<string, { readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; readonly path: string }>> = {
    'features.read': { method: 'GET', path: '/features' },
    'feature.create': { method: 'POST', path: '/features' },
    'feature.update': { method: 'PATCH', path: '/features/{featureId}' },
    'feature.delete': { method: 'DELETE', path: '/features/{featureId}' },
    'domain.create': { method: 'POST', path: '/domains' },
    'domain.update': { method: 'PATCH', path: '/domains/{domainId}' },
    'domain.delete': { method: 'DELETE', path: '/domains/{domainId}' },
    'repository.create': { method: 'POST', path: '/repositories' },
    'repository.update': { method: 'PATCH', path: '/repositories/{repositoryId}' },
    'repository.delete': { method: 'DELETE', path: '/repositories/{repositoryId}' },
};

/** The choices tynn.ai's repository form offers (Features.jsx RepoModal). */
export const REPOSITORY_KINDS = [
    { value: 'code', label: 'Code (product)' },
    { value: 'knowledge', label: 'Knowledge (product)' },
    { value: 'envelope', label: 'Envelope / container' },
] as const;
export const REPOSITORY_PATTERNS = [
    { value: '', label: 'Inherit from project' },
    { value: 'semantic', label: 'Semantic (1.2.3)' },
    { value: 'calendar', label: 'Calendar (2026.06)' },
    { value: 'continuous', label: 'Continuous (build.N)' },
    { value: 'milestone', label: 'Milestone (v3)' },
    { value: 'feature', label: 'Feature (Epic.Feature.Step)' },
    { value: 'hybrid', label: 'Hybrid (semantic + calendar)' },
] as const;
export const REPOSITORY_PROVIDERS = [
    { value: 'github', label: 'GitHub' },
    { value: 'gitlab', label: 'GitLab' },
    { value: 'bitbucket', label: 'Bitbucket' },
    { value: 'other', label: 'Other' },
] as const;

export interface FeatureRow { readonly id: string; readonly title: string; readonly slug: string | null; readonly description: string | null; readonly docsUrl: string | null; readonly domainId: string | null; readonly domain: string | null; readonly tasks: number; readonly done: number }
export interface DomainRow { readonly id: string; readonly name: string; readonly slug: string | null; readonly description: string | null; readonly features: number }
export interface RepositoryRow {
    readonly id: string; readonly url: string; readonly label: string; readonly githubUrl: string | null;
    readonly branch: string | null; readonly provider: string | null; readonly repoMode: string | null;
    readonly ciProvider: string | null; readonly ciConfigPath: string | null; readonly codeownersPath: string | null;
    readonly kind: string; readonly isProduct: boolean;
    readonly pattern: string | null; readonly patternLabel: string | null; readonly releaseCycle: string | null; readonly gitLinkage: string | null;
}
export interface ModelRow { readonly id: string; readonly name: string; readonly table: string | null; readonly description: string | null; readonly fields: number }
export interface FeaturesView {
    readonly features: readonly FeatureRow[];
    readonly domains: readonly DomainRow[];
    readonly repositories: readonly RepositoryRow[];
    readonly models: readonly ModelRow[];
    /** `none`: the Repositories tab offers to register the workspace's `.agi` container. */
    readonly envelope: 'present' | 'none';
    readonly canManage: boolean;
}

/** Tynn's Features answer (GET /features) as the tab draws it, in Tynn's order; null when it is not the Features page. */
export function parseFeatures(json: unknown): FeaturesView | null {
    if (!isRow(json) || !Array.isArray(json.features) || !Array.isArray(json.domains) || typeof json.can_manage !== 'boolean') return null;
    return {
        features: rows(json.features).flatMap((f): FeatureRow[] => {
            const id = str(f.id);
            return id === null ? [] : [{ id, title: str(f.title) ?? '', slug: str(f.slug), description: str(f.description), docsUrl: str(f.docs_url), domainId: str(f.domain_id), domain: str(f.domain), tasks: num(f.task_count), done: num(f.task_done) }];
        }),
        domains: rows(json.domains).flatMap((d): DomainRow[] => {
            const id = str(d.id);
            return id === null ? [] : [{ id, name: str(d.name) ?? '', slug: str(d.slug), description: str(d.description), features: num(d.feature_count) }];
        }),
        repositories: rows(json.repositories).flatMap((r): RepositoryRow[] => {
            const id = str(r.id);
            const url = str(r.url);
            if (id === null || url === null) return [];
            return [{
                id, url, label: str(r.label) ?? url, githubUrl: str(r.github_url),
                branch: str(r.default_branch), provider: str(r.scm_provider), repoMode: str(r.repo_mode),
                ciProvider: str(r.ci_provider), ciConfigPath: str(r.ci_config_path), codeownersPath: str(r.codeowners_path),
                kind: str(r.kind) ?? 'code', isProduct: r.is_product === true,
                pattern: str(r.versioning_pattern), patternLabel: str(r.versioning_pattern_label), releaseCycle: str(r.release_cycle), gitLinkage: str(r.git_linkage),
            }];
        }),
        models: rows(json.models).flatMap((m): ModelRow[] => {
            const id = str(m.id);
            return id === null ? [] : [{ id, name: str(m.name) ?? '', table: str(m.table), description: str(m.description), fields: num(m.field_count) }];
        }),
        envelope: json.envelope_status === 'present' ? 'present' : 'none',
        canManage: json.can_manage === true,
    };
}

/** The page's live channel for a project. */
export function featuresChannel(projectId: string): string {
    return FEATURES_LIVE.channel.replace('{projectId}', projectId);
}

/** The feature or domain a ring names (`{feature: {id}}` / `{domain: {id}}`, the events' payloads). */
export function featureRingIds(_event: string, data: unknown): string[] {
    if (!isRow(data)) return [];
    const row = isRow(data.feature) ? data.feature : isRow(data.domain) ? data.domain : null;
    const id = row ? str(row.id) : null;
    return id === null ? [] : [id];
}

/** A write's request: the contract's door, its row named in the path. Null for the read, an unknown action, or a row write without its row. */
export function featuresActionRequest(projectId: string, action: string, id: string | null | undefined): { method: 'POST' | 'PATCH' | 'DELETE'; path: string } | null {
    const api = Object.hasOwn(FEATURES_API, action) ? FEATURES_API[action] : undefined;
    if (!api || api.method === 'GET') return null;
    const placeholder = /\{[A-Za-z]+\}/;
    if (placeholder.test(api.path) && (typeof id !== 'string' || id === '')) return null;
    const path = api.path.replace(placeholder, encodeURIComponent(id ?? ''));
    return { method: api.method, path: `/api/v1/projects/${encodeURIComponent(projectId)}${path}` };
}

/** Which form a write uses; null for a delete (no body) or anything that is not a page write. */
export function featuresFormOf(action: string): FeaturesForm | null {
    if (action === 'feature.create' || action === 'feature.update') return 'feature';
    if (action === 'domain.create' || action === 'domain.update') return 'domain';
    if (action === 'repository.create' || action === 'repository.update') return 'repository';
    return null;
}

const NOUN: Readonly<Record<FeaturesForm, string>> = { feature: 'feature', domain: 'domain', repository: 'repository' };
const NEEDS: Readonly<Record<string, string>> = {
    'feature.title': 'A feature needs a title.',
    'feature.description': 'A feature needs a description.',
    'domain.name': 'A domain needs a name.',
    'repository.url': 'A repository needs its URL.',
};

/**
 * A write's body: only the web form's fields, trimmed; an emptied optional field is sent as null (cleared). What the form
 * would refuse (a required field empty, a limit passed) is refused here in words, and nothing is sent. Tynn checks it all
 * again, and its 422 is said in its own words.
 */
export function featuresBody(action: string, raw: unknown): { ok: true; body: Record<string, unknown> | undefined } | { ok: false; reason: string } {
    const form = featuresFormOf(action);
    if (form === null) return { ok: true, body: undefined };
    const spec = FEATURES_FORMS[form];
    const given = isRow(raw) ? raw : {};
    const body: Record<string, unknown> = {};
    for (const field of spec.fields) {
        if (!Object.hasOwn(given, field)) continue;
        const v = given[field];
        if (typeof v === 'string') body[field] = v.trim() === '' ? null : v.trim();
        else if (v === null) body[field] = null;
    }
    for (const field of spec.required) {
        if (typeof body[field] !== 'string') return { ok: false, reason: NEEDS[`${form}.${field}`] ?? `A ${NOUN[form]} needs its ${field.replace(/_/g, ' ')}.` };
    }
    for (const [field, max] of Object.entries(spec.max as Readonly<Record<string, number>>)) {
        const v = body[field];
        if (typeof v === 'string' && [...v].length > max) return { ok: false, reason: `A ${NOUN[form]}'s ${field.replace(/_/g, ' ')} is at most ${max} characters.` };
    }
    return { ok: true, body };
}
