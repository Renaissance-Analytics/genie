import { BOARD_CLAIMS, BOARD_LIVE, initialsOf, LIVE_QUIET_MS, parseClaims, type BoardClaim, type BoardClaims, type BoardOp, type BoardRefusal, type TynnBoardHost } from './tynn-board.js';
import { issuesQueryPath, normalizeIssueFilters, parseIssueQueue, type IssueQueueView } from './tynn-issues.js';

/**
 * THE TYNN TAB IS tynn.ai's WORKSPACE (genie#1295). The owner, 2026-10-31: "all I see is the board view for the tynn
 * features in Genie" — full parity with tynn.ai's workspace, minus the user and project menus.
 *
 * This file declares the tab's pages beyond the board, each against its surface in the workspace-UX contract
 * (contracts/workspace-ux.json; test/workspace-ux-contract.test.ts holds every constant here to it), and how each one is
 * read, drawn and kept live. The board keeps its own file (core/tynn-board.ts).
 */

// ── The tab's pages, in tynn.ai's order with tynn.ai's icons (projectTabs.js) ────────────────────────────────────────

export type TynnSectionId = 'home' | 'issues' | 'plans' | 'wip' | 'board' | 'vip' | 'releases' | 'features' | 'activity' | 'manage';
export interface TynnSection { readonly id: TynnSectionId; readonly icon: string; readonly label: string }

/**
 * The pages the tab has, in tynn.ai's nav order (Home, Issues, Plans, WIP, Board, VIP, Releases, Features, Activity,
 * Settings) and with its icons. A page is listed once it is built; the rest of tynn.ai's nav joins as its row lands.
 */
export const TYNN_SECTIONS: readonly TynnSection[] = [
    { id: 'issues', icon: 'sparkles', label: 'Issues' },
    { id: 'wip', icon: 'play', label: 'WIP' },
    { id: 'board', icon: 'columns-3', label: 'Board' },
    { id: 'releases', icon: 'rocket', label: 'Releases' },
];

/** The page the tab opens on. */
export const TYNN_FIRST_SECTION: TynnSectionId = 'board';

/** A page of the tab that is read as one answer (the board has its own door and scope query). */
export type TynnPage = 'wip' | 'issues' | 'releases';
export const TYNN_PAGES: readonly TynnPage[] = ['wip', 'issues', 'releases'];

// ── WIP (workspace-ux 0.6.0, surface `wip`) ──────────────────────────────────────────────────────────────────────────

export const WIP_DATA_API = { method: 'GET', path: '/wip' } as const;
export const WIP_QUERY = ['view', 'story', 'product'] as const;
export const WIP_LENSES = {
    active: ['in_progress', 'backlog'],
    attention: ['blocked', 'qa'],
    done: ['done'],
} as const;
export type WipLens = keyof typeof WIP_LENSES;
export const WIP_ANSWER = ['project_id', 'view', 'active_version', 'available_versions', 'stories', 'selected_story', 'tasks', 'story_counts', 'claims'] as const;
export const WIP_COUNTS = ['active', 'attention', 'done', 'backlog'] as const;
export const WIP_FIELDS = {
    story: ['id', 'slug', 'story_number', 'title', 'status', 'description', 'task_count', 'tasks_done'],
    task: ['id', 'task_number', 'title', 'status', 'claimed_by', 'claimed_by_me', 'can_start', 'version_active', 'features'],
} as const;
/** What is in motion first, as the web page lists a story's tasks. */
export const WIP_TASK_ORDER = ['doing', 'qa', 'blocked', 'backlog', 'done'] as const;
export const WIP_QUICK_ACTIONS: { readonly task: Readonly<Record<string, { readonly verb: string; readonly guard?: string }>> } = {
    task: {
        backlog: { verb: 'start', guard: 'can_start' },
        doing: { verb: 'ready', guard: 'version_active' },
        qa: { verb: 'done', guard: 'version_active' },
        blocked: { verb: 'restart' },
    },
};
/** WIP's buttons are the board door's task verbs, and a claim for the claim-aware Start: it adds no write of its own. */
export const WIP_ACTIONS = ['task.start', 'task.ready', 'task.done', 'task.restart', 'task.claim'] as const;
/** WIP follows the board's channel and events; on a ring it reads WIP again (the web page reloads its props). */
export const WIP_LIVE = {
    channel: BOARD_LIVE.channel,
    events: BOARD_LIVE.events,
    refresh: 'read',
} as const;
export const WIP_STATES = ['loading', 'no-active-version', 'lens', 'empty-lens', 'story-selected', 'no-tasks', 'done-summary', 'claim-start', 'claimed', 'transition-refused', 'live', 'reconnecting', 'not-linked', 'signed-out'] as const;

/** Each task step as the web page words it, with its icon and why it is held back. */
const WIP_STEP: Readonly<Record<string, { icon: string; label: string; why?: string }>> = {
    start: { icon: 'play', label: 'Start', why: 'Story must be in progress first' },
    ready: { icon: 'shield-check', label: 'Ready for QA', why: 'Version must be active' },
    done: { icon: 'circle-check', label: 'Done', why: 'Version must be active' },
    restart: { icon: 'refresh-cw', label: 'Restart' },
};

export interface WipStep { readonly verb: string; readonly actionId: string; readonly disabled: boolean; readonly icon: string; readonly label: string; readonly why: string | null }
export interface WipStory {
    readonly id: string;
    readonly slug: string;
    readonly number: string | null;
    readonly title: string;
    readonly status: string;
    readonly description: string | null;
    readonly taskCount: number;
    readonly tasksDone: number;
    /** `done/total`, or null for a story with no tasks. */
    readonly progress: string | null;
}
export interface WipTask {
    readonly id: string;
    readonly number: string | null;
    readonly title: string;
    readonly status: string;
    readonly claim: BoardClaim | null;
    readonly features: readonly string[];
    readonly step: WipStep | null;
}
export interface WipView {
    readonly lens: WipLens;
    readonly version: { readonly id: string; readonly number: string | null; readonly title: string } | null;
    readonly counts: Readonly<Record<(typeof WIP_COUNTS)[number], number>>;
    /** The banner's: stories done of all the version's stories. */
    readonly progress: { readonly done: number; readonly total: number; readonly percent: number };
    readonly stories: readonly WipStory[];
    readonly selected: WipStory | null;
    readonly tasks: readonly WipTask[];
    readonly doneTasks: number;
    /** The board's claim settings for the person: a backlog task's Start follows the claim mode (null from an older Tynn). */
    readonly claims: BoardClaims | null;
}

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isRow) : []);

function wipStory(row: Row): WipStory | null {
    const id = str(row.id);
    const status = str(row.status);
    if (id === null || status === null) return null;
    const n = str(row.story_number);
    const total = num(row.task_count);
    const done = num(row.tasks_done);
    return {
        id,
        slug: str(row.slug) ?? id,
        number: n === null ? null : `#${n}`,
        title: str(row.title) ?? '',
        status,
        description: str(row.description),
        taskCount: total,
        tasksDone: done,
        progress: total > 0 ? `${done}/${total}` : null,
    };
}

function wipStep(status: string, row: Row): WipStep | null {
    const step = WIP_QUICK_ACTIONS.task[status];
    if (!step) return null;
    const look = WIP_STEP[step.verb] ?? { icon: 'arrow-right', label: step.verb };
    const disabled = step.guard !== undefined && row[step.guard] !== true;
    return { verb: step.verb, actionId: `task.${step.verb}`, disabled, icon: look.icon, label: look.label, why: disabled ? (look.why ?? null) : null };
}

function wipTask(row: Row): WipTask | null {
    const id = str(row.id);
    const status = str(row.status);
    if (id === null || status === null) return null;
    const claimRow = isRow(row.claimed_by) ? row.claimed_by : null;
    const claimName = claimRow ? str(claimRow.name) : null;
    const claimType = claimRow?.type === 'agent' ? 'agent' : claimRow?.type === 'user' ? 'user' : null;
    const claimId = claimRow ? str(claimRow.id) : null;
    const n = str(row.task_number);
    return {
        id,
        number: n === null ? null : `#${n}`,
        title: str(row.title) ?? '',
        status,
        claim: claimName !== null && claimType !== null && claimId !== null
            ? { type: claimType, id: claimId, name: claimName, initials: initialsOf(claimName), mine: row.claimed_by_me === true }
            : null,
        features: rows(row.features).map((f) => str(f.title)).filter((t): t is string => t !== null),
        step: wipStep(status, row),
    };
}

const rank = (status: string): number => {
    const i = (WIP_TASK_ORDER as readonly string[]).indexOf(status);
    return i === -1 ? WIP_TASK_ORDER.length : i;
};

/** Tynn's WIP answer (GET /wip) as the tab draws it; null when it is not WIP — never an empty one. */
export function parseWip(json: unknown): WipView | null {
    if (!isRow(json) || typeof json.view !== 'string' || !Object.hasOwn(WIP_LENSES, json.view) || !Array.isArray(json.stories) || !Array.isArray(json.tasks)) return null;
    const v = isRow(json.active_version) ? json.active_version : null;
    const versionId = v ? str(v.id) : null;
    const c = isRow(json.story_counts) ? json.story_counts : {};
    const counts = { active: num(c.active), attention: num(c.attention), done: num(c.done), backlog: num(c.backlog) };
    const total = counts.active + counts.attention + counts.done + counts.backlog;
    const tasks = rows(json.tasks).map(wipTask).filter((t): t is WipTask => t !== null);
    // Stable: equal ranks keep Tynn's order.
    const ordered = tasks.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t.status) - rank(b.t.status) || a.i - b.i).map(({ t }) => t);
    return {
        lens: json.view as WipLens,
        version: v && versionId !== null ? { id: versionId, number: str(v.number), title: str(v.title) ?? '' } : null,
        counts,
        progress: { done: counts.done, total, percent: total > 0 ? Math.round((counts.done / total) * 100) : 0 },
        stories: rows(json.stories).map(wipStory).filter((s): s is WipStory => s !== null),
        selected: isRow(json.selected_story) ? wipStory(json.selected_story) : null,
        tasks: ordered,
        doneTasks: ordered.filter((t) => t.status === 'done').length,
        claims: parseClaims(json[BOARD_CLAIMS.field]),
    };
}

// ── Releases (workspace-ux 0.8.0, surface `releases`, parity row R1) ─────────────────────────────────────────────────

/** Read only: one GET, the project's released versions newest first (Tynn's order; Genie sorts nothing). */
export const RELEASES_DATA_API = { method: 'GET', path: '/releases' } as const;
export const RELEASES_QUERY = ['product'] as const;
export const RELEASES_ANSWER = ['project_id', 'releases'] as const;
export const RELEASES_FIELDS = {
    release: ['id', 'number', 'title', 'description', 'why', 'released_at', 'pr_id', 'repository_id', 'story_count', 'story_done_count', 'top_stories'],
    story: ['id', 'story_number', 'title', 'status'],
} as const;
/** How many stories a card lists by number; the rest are "+ n more". */
export const RELEASES_TOP_STORIES = 5;
export const RELEASES_TOTALS = ['releases', 'stories'] as const;
/** Live on the board's own channel and rings: each burst is one read of Releases (as tynn.ai reloads its props). */
export const RELEASES_LIVE = { channel: BOARD_LIVE.channel, events: BOARD_LIVE.events, refresh: 'read' } as const;
export const RELEASES_STATES = ['loading', 'totals', 'release-card', 'more-stories', 'empty', 'live', 'reconnecting', 'not-linked', 'signed-out'] as const;

export interface ReleaseStory { readonly id: string; readonly number: string | null; readonly title: string }
export interface Release {
    readonly id: string;
    readonly number: string | null;
    readonly title: string;
    readonly description: string | null;
    /** YYYY-MM-DD, as tynn.ai's card shows it. */
    readonly date: string | null;
    readonly pr: string | null;
    readonly storyCount: number;
    readonly storyDone: number;
    readonly top: readonly ReleaseStory[];
    /** How many more stories than the card lists. */
    readonly more: number;
}
export interface ReleasesView { readonly releases: readonly Release[]; readonly totalStories: number }

/** Tynn's Releases answer (GET /releases) as the tab draws it; null when it is not Releases. */
export function parseReleases(json: unknown): ReleasesView | null {
    if (!isRow(json) || !Array.isArray(json.releases)) return null;
    const releases = rows(json.releases).flatMap((r): Release[] => {
        const id = str(r.id);
        if (id === null) return [];
        const top = rows(r.top_stories).slice(0, RELEASES_TOP_STORIES).flatMap((t): ReleaseStory[] => {
            const sid = str(t.id);
            const n = str(t.story_number);
            return sid === null ? [] : [{ id: sid, number: n === null ? null : `#${n}`, title: str(t.title) ?? '' }];
        });
        const storyCount = num(r.story_count);
        const at = str(r.released_at);
        return [{
            id,
            number: str(r.number),
            title: str(r.title) ?? '',
            description: str(r.description),
            date: at === null ? null : at.slice(0, 10),
            pr: str(r.pr_id),
            storyCount,
            storyDone: num(r.story_done_count),
            top,
            more: Math.max(0, storyCount - top.length),
        }];
    });
    return { releases, totalStories: releases.reduce((n, r) => n + r.storyCount, 0) };
}

// ── Reading a page ──────────────────────────────────────────────────────────────────────────────────────────────────

export type TynnPageQuery = Readonly<Record<string, string | undefined>>;
export type TynnPageView = { readonly page: 'wip'; readonly view: WipView } | { readonly page: 'issues'; readonly view: IssueQueueView } | { readonly page: 'releases'; readonly view: ReleasesView };

/** GET a page of the workspace's project: only the query the page's contract declares, and only real values. */
export function tynnPagePath(projectId: string, page: TynnPage, query: TynnPageQuery): string {
    if (page === 'issues') return issuesQueryPath(projectId, normalizeIssueFilters(query));
    const q = new URLSearchParams();
    if (page === 'releases') {
        if (query.product !== undefined && query.product !== '') q.append('product', query.product);
        const s = q.toString();
        return `/api/v1/projects/${encodeURIComponent(projectId)}${RELEASES_DATA_API.path}${s === '' ? '' : `?${s}`}`;
    }
    if (page === 'wip') {
        const view = query.view;
        if (view !== undefined && Object.hasOwn(WIP_LENSES, view)) q.append('view', view);
        if (query.story !== undefined && query.story !== '') q.append('story', query.story);
        if (query.product !== undefined && query.product !== '') q.append('product', query.product);
    }
    const s = q.toString();
    return `/api/v1/projects/${encodeURIComponent(projectId)}${WIP_DATA_API.path}${s === '' ? '' : `?${s}`}`;
}

/** Tynn's answer for a page, as the tab draws it; null when it is not that page. */
export function parseTynnPage(page: TynnPage, json: unknown): TynnPageView | null {
    if (page === 'issues') {
        const view = parseIssueQueue(json);
        return view ? { page, view } : null;
    }
    if (page === 'wip') {
        const view = parseWip(json);
        return view ? { page, view } : null;
    }
    if (page === 'releases') {
        const view = parseReleases(json);
        return view ? { page, view } : null;
    }
    return null;
}

/** What the tab needs from the host: the board, and the workspace's other pages — all of its own project. */
export interface TynnTabHost extends TynnBoardHost {
    page?(workspaceId: string, page: TynnPage, query: TynnPageQuery): Promise<({ ok: true } & TynnPageView) | BoardRefusal>;
}

export type TynnPageState<V> =
    | { readonly state: 'loading' }
    | { readonly state: 'not-linked' }
    | { readonly state: 'signed-out'; readonly reason: string }
    | { readonly state: 'error'; readonly reason: string }
    | { readonly state: 'ready'; readonly view: V; readonly op?: BoardOp | null };

// ── Live: read again, once per burst, one read at a time ────────────────────────────────────────────────────────────

export interface PageFollowerPorts {
    read(): Promise<void>;
    schedule(fn: () => void, ms: number): () => void;
}

/**
 * A page that refreshes on a ring (`refresh: read`): every ring is a doorbell. A burst of rings is one read after a
 * quiet moment; a ring while a read runs is one more read after it — never two at once, never one per event.
 */
export class PageFollower {
    readonly #ports: PageFollowerPorts;
    #cancel: (() => void) | null = null;
    #reading = false;
    #again = false;
    #stopped = false;

    constructor(ports: PageFollowerPorts) {
        this.#ports = ports;
    }

    ring(): void {
        if (this.#stopped) return;
        this.#cancel?.();
        this.#cancel = this.#ports.schedule(() => { this.#cancel = null; void this.#run(); }, LIVE_QUIET_MS);
    }

    stop(): void {
        this.#stopped = true;
        this.#cancel?.();
        this.#cancel = null;
    }

    async #run(): Promise<void> {
        if (this.#stopped) return;
        if (this.#reading) { this.#again = true; return; }
        this.#reading = true;
        try { await this.#ports.read(); } catch { /* the page's own read says what went wrong */ }
        this.#reading = false;
        if (this.#again && !this.#stopped) { this.#again = false; this.ring(); }
    }
}
