import type { BoardOp, BoardRefusal, BoardLiveSignal, LiveState } from './tynn-board.js';

/**
 * THE TYNN TAB'S ISSUES (genie#1295 row I1, workspace-ux 0.7.0 surface `issues`) — tynn.ai's Issues page, natively.
 *
 * The project's one intake queue: ideas, reports and defects before they become work. Status tabs (Open first), a source
 * filter, a search; file, edit, delete, convert into a story, resolve or discard with a reason. Everything here is
 * declared against the workspace-UX contract (test/workspace-ux-contract.test.ts holds it to contracts/workspace-ux.json)
 * and talks to Tynn's issue-queue door (`/api/v1/projects/{id}/issues…`, pairing scope `genie:issue-queue`) as the person:
 * Tynn's own page gate, builder, actions and policies decide, and every refusal is its 404.
 */

/** The surface's own pairing scope (the contract's `scope`). `genie:issues` is filing only; this is the queue. */
export const ISSUES_SCOPE = 'genie:issue-queue';
export const ISSUES_DATA_API = { method: 'GET', path: '/issues' } as const;
export const ISSUES_QUERY = ['status', 'source', 'q'] as const;
export const ISSUES_FILTERS = {
    status: ['open', 'converted', 'resolved', 'discarded', 'all'],
    default: 'open',
    source: ['feedback', 'issue', 'wish', 'github'],
} as const;
export const ISSUES_LIMIT = 100;
export const ISSUES_ANSWER = ['project_id', 'cursor', 'issues', 'filters', 'statuses', 'features', 'convertible_versions', 'can_triage'] as const;
export const ISSUES_FIELDS = {
    issue: ['id', 'issue_number', 'title', 'description', 'status', 'type', 'priority', 'source', 'context_url', 'from', 'version_number', 'feature_ids', 'solutions', 'converted_story_id', 'converted_story_number', 'github', 'created_at'],
} as const;

/** tynn.ai's issue types, in its order, each with its icon, label and the colour on the card's edge (Issues.jsx). */
export const ISSUE_TYPE_LOOK: Readonly<Record<string, { readonly label: string; readonly icon: string; readonly border: string | null }>> = {
    enhancement: { label: 'Enhancement', icon: 'sparkles', border: 'var(--blue-500)' },
    fix: { label: 'Fix', icon: 'wrench', border: 'var(--rose-500)' },
    // tynn.ai names `broom`, which the kit's Lucide does not have (it draws nothing); `brush-cleaning` is its broom.
    chore: { label: 'Chore', icon: 'brush-cleaning', border: 'var(--zinc-400)' },
    docs: { label: 'Docs', icon: 'book', border: 'var(--amber-300)' },
    security: { label: 'Security', icon: 'shield', border: 'var(--amber-500)' },
    deprecation: { label: 'Deprecation', icon: 'archive', border: 'var(--orange-500)' },
};
export const ISSUE_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
export const PRIORITY_LABEL: Readonly<Record<string, string>> = { low: 'Low', normal: 'Normal', high: 'High', critical: 'Critical' };

export const ISSUES_FORM = {
    fields: ['title', 'type', 'priority', 'description', 'feature_ids'],
    required: ['title'],
    defaults: { type: 'enhancement', priority: 'normal' },
} as const;
export const ISSUES_TRIAGE = { guard: 'can_triage', while: 'open' } as const;
export const ISSUES_CONVERT_STATUSES = ['active', 'accepted'] as const;
export const ISSUES_CLOSE_VERDICTS = { resolve: 'resolved', discard: 'discarded' } as const;

export type IssueMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
/** Every action the tab offers, by the contract's id, with the method and path it calls (under the project). */
export const ISSUES_API: Readonly<Record<string, { readonly method: IssueMethod; readonly path: string }>> = {
    'issue.list': { method: 'GET', path: '/issues' },
    'issue.detail': { method: 'GET', path: '/issues/{issueId}' },
    'issue.create': { method: 'POST', path: '/issues' },
    'issue.update': { method: 'PATCH', path: '/issues/{issueId}' },
    'issue.delete': { method: 'DELETE', path: '/issues/{issueId}' },
    'issue.convert': { method: 'POST', path: '/issues/{issueId}/convert' },
    'issue.resolve': { method: 'POST', path: '/issues/{issueId}/close' },
    'issue.discard': { method: 'POST', path: '/issues/{issueId}/close' },
};
/** A contract action the tab does not offer yet, with why. None: the Issues page is whole. */
export const ISSUES_GAPS: Readonly<Record<string, string>> = {};

/** Every state the tab draws (TynnIssuesPanel), as the contract names them. */
export const ISSUES_STATES = ['loading', 'status-tabs', 'source-filter', 'search', 'empty', 'card', 'open-issue', 'not-found', 'create', 'triage', 'convert', 'close-reason', 'refused', 'live', 'reconnecting', 'not-linked', 'signed-out'] as const;

/** How the queue goes live, as the contract's `data.live` declares it (its prose left out): the queue's own channel. */
export const ISSUES_LIVE = {
    channel: 'private-project-issues.{projectId}',
    push: { method: 'GET', path: '/api/v1/broadcasting-config', scope: 'genie:discovery' },
    auth: { method: 'POST', path: '/issues/broadcasting-auth', body: ['socket_id', 'channel_name'] },
    events: ['issue.created', 'issue.updated', 'issue.deleted'],
    cursor: 'cursor',
    changes: {
        method: 'GET',
        path: '/issues/changes',
        query: ['since', 'ids[]', 'status', 'source', 'q'],
        answer: ['project_id', 'cursor', 'filters', 'ids', 'rows'],
    },
} as const;

// ── What the tab holds ──────────────────────────────────────────────────────────────────────────────────────────────

export interface IssueFilters { readonly status: string; readonly source: string | null; readonly q: string }
export interface IssueGithub { readonly repo: string; readonly number: number; readonly url: string | null; readonly state: string | null }
export interface IssueSolution { readonly title: string; readonly description: string | null }
export interface IssueRow {
    readonly id: string;
    /** `#7`. */
    readonly number: string;
    readonly title: string;
    readonly description: string | null;
    readonly status: string;
    readonly type: string | null;
    readonly priority: string | null;
    readonly source: string | null;
    readonly contextUrl: string | null;
    /** Who raised it, when anyone is recorded; never invented. */
    readonly from: string | null;
    readonly versionNumber: string | null;
    readonly featureIds: readonly string[];
    readonly solutions: readonly IssueSolution[];
    readonly convertedStoryNumber: number | null;
    readonly github: IssueGithub | null;
    readonly createdAt: string | null;
}
export interface IssueVersion { readonly id: string; readonly number: string; readonly title: string; readonly status: string }
export interface IssueQueueView {
    readonly issues: readonly IssueRow[];
    readonly filters: IssueFilters;
    readonly features: readonly { readonly id: string; readonly title: string }[];
    readonly versions: readonly IssueVersion[];
    readonly canTriage: boolean;
    readonly cursor: string | null;
}
export interface IssueChanges { readonly cursor: string; readonly ids: readonly string[]; readonly rows: readonly IssueRow[] }

export type TynnIssuesState =
    | { state: 'loading' }
    | { state: 'not-linked' }
    | { state: 'signed-out'; reason: string }
    | { state: 'error'; reason: string }
    | { state: 'ready'; view: IssueQueueView };

/** One action: the contract's id, the issue (null for a create), and its body. */
export interface IssueActionInput { readonly action: string; readonly issueId: string | null; readonly body?: Readonly<Record<string, unknown>> }
export type IssueOp = BoardOp;
export type IssueRefusal = BoardRefusal;
export type IssueLiveSignal = BoardLiveSignal;

/** What the tab needs from the host, for the WORKSPACE's own project (there is no project argument). */
export interface TynnIssuesHost {
    read(workspaceId: string, filters: Partial<IssueFilters>): Promise<{ ok: true; view: IssueQueueView } | IssueRefusal>;
    /** One action; answers the issue as Tynn now has it (null after a delete). */
    act(workspaceId: string, input: IssueActionInput): Promise<{ ok: true; issue: IssueRow | null } | IssueRefusal>;
    /** What changed under the filters since a cursor. Optional: a remote host has none, and its tab is not live. */
    changes?(workspaceId: string, filters: Partial<IssueFilters>, cursor: string, ids: readonly string[]): Promise<{ ok: true; changes: IssueChanges } | IssueRefusal>;
    /** Follow the workspace's queue (its live state and rings) until the answer is called. */
    watch?(workspaceId: string, listener: (signal: IssueLiveSignal) => void): () => void;
}
export type { LiveState };

// ── Reading Tynn's answers ─────────────────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The page's filters, normalised as Tynn normalises them: an unknown status or source is the default. */
export function normalizeIssueFilters(raw: unknown): IssueFilters {
    const f = isRow(raw) ? raw : {};
    const status = typeof f.status === 'string' && (ISSUES_FILTERS.status as readonly string[]).includes(f.status) ? f.status : ISSUES_FILTERS.default;
    const source = typeof f.source === 'string' && (ISSUES_FILTERS.source as readonly string[]).includes(f.source) ? f.source : null;
    const q = typeof f.q === 'string' ? f.q.trim() : '';
    return { status, source, q };
}

export function parseIssueRow(raw: unknown): IssueRow | null {
    if (!isRow(raw)) return null;
    const id = str(raw.id);
    const status = str(raw.status);
    if (id === null || status === null) return null;
    const n = str(raw.issue_number);
    const gh = isRow(raw.github) ? raw.github : null;
    const ghRepo = gh ? str(gh.repo) : null;
    const ghNumber = gh ? num(gh.number) : null;
    return {
        id,
        number: n === null ? '' : `#${n}`,
        title: str(raw.title) ?? '',
        description: str(raw.description),
        status,
        type: str(raw.type),
        priority: str(raw.priority),
        source: str(raw.source),
        contextUrl: str(raw.context_url),
        from: str(raw.from),
        versionNumber: str(raw.version_number),
        featureIds: Array.isArray(raw.feature_ids) ? raw.feature_ids.filter((x): x is string => typeof x === 'string') : [],
        solutions: Array.isArray(raw.solutions)
            ? raw.solutions.filter(isRow).map((s) => ({ title: str(s.title) ?? '', description: str(s.description) })).filter((s) => s.title !== '')
            : [],
        convertedStoryNumber: num(raw.converted_story_number),
        github: gh && ghRepo !== null && ghNumber !== null ? { repo: ghRepo, number: ghNumber, url: str(gh.url), state: str(gh.state) } : null,
        createdAt: str(raw.created_at),
    };
}

const rows = (raw: unknown): IssueRow[] => (Array.isArray(raw) ? raw.map(parseIssueRow).filter((r): r is IssueRow => r !== null) : []);

/** Tynn's queue (GET /issues) as the tab draws it; null when it is not a queue — never an empty one. */
export function parseIssueQueue(json: unknown): IssueQueueView | null {
    if (!isRow(json) || !Array.isArray(json.issues) || !isRow(json.filters)) return null;
    return {
        issues: rows(json.issues),
        filters: normalizeIssueFilters(json.filters),
        features: Array.isArray(json.features)
            ? json.features.filter(isRow).map((f) => ({ id: str(f.id) ?? '', title: str(f.title) ?? '' })).filter((f) => f.id !== '')
            : [],
        versions: Array.isArray(json.convertible_versions)
            ? json.convertible_versions.filter(isRow).map((v) => ({ id: str(v.id) ?? '', number: str(v.number) ?? '', title: str(v.title) ?? '', status: str(v.status) ?? '' })).filter((v) => v.id !== '')
            : [],
        canTriage: json.can_triage === true,
        cursor: str(json.cursor),
    };
}

/** What changed (GET /issues/changes); null when it is not that. */
export function parseIssueChanges(json: unknown): IssueChanges | null {
    if (!isRow(json) || !Array.isArray(json.ids) || !Array.isArray(json.rows)) return null;
    const cursor = str(json.cursor);
    if (cursor === null) return null;
    return { cursor, ids: json.ids.filter((x): x is string => typeof x === 'string'), rows: rows(json.rows) };
}

/** Triage (delete, resolve, discard, convert) — offered only on an open issue, to a person who may triage. */
export function triageOf(view: Pick<IssueQueueView, 'canTriage'>, issue: Pick<IssueRow, 'status'>): boolean {
    return view.canTriage && issue.status === ISSUES_TRIAGE.while;
}

/**
 * Apply what changed: the rows under the filters are exactly `ids`, in that order (Tynn's, newest first); a changed row
 * is the new one, every other row keeps its object, so only what changed redraws. The same view when nothing did.
 */
export function applyIssueChanges(view: IssueQueueView, changes: IssueChanges): IssueQueueView {
    const fresh = new Map(changes.rows.map((r) => [r.id, r]));
    const held = new Map(view.issues.map((r) => [r.id, r]));
    const next: IssueRow[] = [];
    for (const id of changes.ids) {
        const row = fresh.get(id) ?? held.get(id);
        if (row) next.push(row);
    }
    const same = next.length === view.issues.length && next.every((r, i) => r === view.issues[i]);
    if (same && changes.cursor === view.cursor) return view;
    return same ? { ...view, cursor: changes.cursor } : { ...view, issues: next, cursor: changes.cursor };
}

// ── Calling Tynn ──────────────────────────────────────────────────────────────────────────────────────────────────

const base = (projectId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}`;

function filterQuery(f: IssueFilters): URLSearchParams {
    const q = new URLSearchParams();
    if (f.status !== ISSUES_FILTERS.default) q.append('status', f.status);
    if (f.source !== null) q.append('source', f.source);
    if (f.q !== '') q.append('q', f.q);
    return q;
}

export function issuesQueryPath(projectId: string, filters: IssueFilters): string {
    const q = filterQuery(filters).toString();
    return `${base(projectId)}${ISSUES_DATA_API.path}${q === '' ? '' : `?${q}`}`;
}

export function issueChangesPath(projectId: string, filters: IssueFilters, cursor: string, ids: readonly string[]): string {
    const q = filterQuery(filters);
    q.append('since', cursor);
    for (const id of ids) q.append('ids[]', id);
    return `${base(projectId)}${ISSUES_LIVE.changes.path}?${q.toString()}`;
}

/** An action's call, or null when the tab does not offer it or it names no issue where it needs one. */
export function issueActionRequest(projectId: string, action: string, issueId: string | null): { method: IssueMethod; path: string } | null {
    const api = ISSUES_API[action];
    if (!api) return null;
    if (api.path.includes('{issueId}') && (issueId === null || issueId === '')) return null;
    return { method: api.method, path: base(projectId) + api.path.replace('{issueId}', encodeURIComponent(issueId ?? '')) };
}

const TYPES = Object.keys(ISSUE_TYPE_LOOK);

/** The web form's create: a title, and only the fields the form has, each one a value Tynn takes. */
export function issueCreateBody(raw: unknown): Record<string, unknown> | null {
    const b = isRow(raw) ? raw : {};
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    if (title === '') return null;
    return {
        title,
        ...(typeof b.description === 'string' && b.description.trim() !== '' ? { description: b.description } : {}),
        ...(typeof b.type === 'string' && TYPES.includes(b.type) ? { type: b.type } : {}),
        ...(typeof b.priority === 'string' && (ISSUE_PRIORITIES as readonly string[]).includes(b.priority) ? { priority: b.priority } : {}),
        ...(Array.isArray(b.feature_ids) ? { feature_ids: b.feature_ids.filter((x): x is string => typeof x === 'string') } : {}),
    };
}

/** An edit: only what changed against the issue as held; null when nothing did, or the title would be empty. */
export function issueEditBody(before: IssueRow, raw: unknown): Record<string, unknown> | null {
    const b = isRow(raw) ? raw : {};
    const out: Record<string, unknown> = {};
    if (typeof b.title === 'string') {
        const title = b.title.trim();
        if (title === '') return null;
        if (title !== before.title) out.title = title;
    }
    if (typeof b.description === 'string' && b.description !== (before.description ?? '')) out.description = b.description;
    if (typeof b.type === 'string' && TYPES.includes(b.type) && b.type !== before.type) out.type = b.type;
    if (typeof b.priority === 'string' && (ISSUE_PRIORITIES as readonly string[]).includes(b.priority) && b.priority !== before.priority) out.priority = b.priority;
    if (Array.isArray(b.feature_ids)) {
        const ids = b.feature_ids.filter((x): x is string => typeof x === 'string');
        if (ids.length !== before.featureIds.length || ids.some((id) => !before.featureIds.includes(id))) out.feature_ids = ids;
    }
    return Object.keys(out).length > 0 ? out : null;
}

export function convertBody(raw: unknown): { version_id: string } | null {
    const v = isRow(raw) ? str(raw.version_id) : null;
    return v === null ? null : { version_id: v };
}

/** Resolve or discard: the verdict the action names, and the reason — never without one. */
export function closeBody(action: string, raw: unknown): { verdict: 'resolve' | 'discard'; reason: string } | null {
    const verdict = action === 'issue.resolve' ? 'resolve' : action === 'issue.discard' ? 'discard' : null;
    const reason = isRow(raw) && typeof raw.reason === 'string' ? raw.reason.trim() : '';
    return verdict === null || reason === '' ? null : { verdict, reason };
}

export function issueChannel(projectId: string): string {
    return ISSUES_LIVE.channel.replace('{projectId}', projectId);
}

/** The issue a ring names (`{issue: {id}}`, every issue event's payload). */
export function issueRingIds(_event: string, data: unknown): string[] {
    const id = isRow(data) && isRow(data.issue) ? str(data.issue.id) : null;
    return id === null ? [] : [id];
}

/** Run one action and say so: `running`, then `done`, or `failed` with Tynn's reason (never silent, never a hang). */
export async function performIssueAction(
    host: Pick<TynnIssuesHost, 'act'>,
    workspaceId: string,
    input: IssueActionInput,
    report: (op: IssueOp) => void,
): Promise<{ ok: true; issue: IssueRow | null } | IssueRefusal> {
    report({ action: input.action, phase: 'running' });
    let r: { ok: true; issue: IssueRow | null } | IssueRefusal;
    try {
        r = await host.act(workspaceId, input);
    } catch (error) {
        r = { ok: false, state: 'error', reason: error instanceof Error ? error.message : String(error) };
    }
    report(r.ok ? { action: input.action, phase: 'done' } : { action: input.action, phase: 'failed', reason: r.reason });
    return r;
}
