/**
 * THE TYNN TAB'S BOARD (genie#1295) — tynn.ai's board, natively in Genie.
 *
 * The owner, 2026-10-27: a Tynn workspace tab with "full parity" with tynn.ai's workspace, "the only difference being no
 * user menus or project picker menus", built NATIVE on Tynn's API ("the mcp is for agents, the api is for apps"). The
 * board is the first slice: versions → a version's stories → a story's tasks, tynn.ai's columns, each card's one-click
 * next step with tynn.ai's guards, drag gated by tynn.ai's transitions (Shift drops anywhere, as on tynn.ai), delete.
 *
 * EVERYTHING BELOW THAT DESCRIBES BEHAVIOUR IS DECLARED AGAINST contracts/workspace-ux.json, the workspace-UX contract
 * tynn.ai declares against too. test/workspace-ux-contract.test.ts fails when these declarations and the contract
 * disagree, and tynn.ai's own check fails when its routes, state machines or web board disagree with it — so a change on
 * either side that the other has not heard about is a red build, not a quiet drift. An action Genie does not offer yet
 * is named in BOARD_GAPS with the reason.
 */

export type BoardLevel = 'versions' | 'stories' | 'tasks';
export type BoardKind = 'version' | 'story' | 'task';
export interface BoardScope { readonly version?: string; readonly story?: string }
export interface BoardIds { readonly versionId?: string; readonly storyId?: string; readonly taskId?: string }

// ── Declared against the contract ───────────────────────────────────────────────────────────────────────────────────

export const BOARD_DATA_API = { method: 'GET', path: '/board' } as const;

/** The board's levels and their columns, in tynn.ai's order. A status with no column (released, archived) is off the board. */
export const BOARD_LEVELS = {
    versions: { scope: 'none', columns: ['draft', 'accepted', 'active', 'review'] },
    stories: { scope: 'version', columns: ['backlog', 'blocked', 'in_progress', 'qa', 'done'] },
    tasks: { scope: 'story', columns: ['backlog', 'blocked', 'doing', 'qa', 'done'] },
} as const satisfies Record<BoardLevel, { scope: string; columns: readonly string[] }>;

/** What a card reads from Tynn's row (the rest of the row is ignored). */
export const BOARD_FIELDS = {
    version: ['id', 'number', 'title', 'status', 'story_count', 'stories_done', 'task_count', 'tasks_done'],
    story: ['id', 'story_number', 'title', 'status', 'order', 'task_count', 'tasks_done', 'claimed_by', 'can_start', 'can_move_to_qa', 'version_active'],
    task: ['id', 'task_number', 'title', 'status', 'order', 'story_id', 'claimed_by', 'can_start', 'version_active'],
} as const satisfies Record<BoardKind, readonly string[]>;

export const BOARD_DRAG = { versions: false, stories: true, tasks: true, override: 'shift' } as const;

/** Where a dragged card may land, as Tynn's state machines allow it (and tynn.ai's board gates its drops). */
export const BOARD_TRANSITIONS = {
    story: {
        backlog: ['in_progress', 'blocked'],
        in_progress: ['qa', 'blocked', 'backlog'],
        qa: ['done', 'in_progress', 'blocked', 'backlog'],
        blocked: ['backlog', 'in_progress', 'qa', 'archived'],
        done: ['archived', 'in_progress', 'backlog'],
        archived: [],
    },
    task: {
        backlog: ['doing', 'blocked'],
        doing: ['qa', 'blocked', 'backlog'],
        qa: ['done', 'doing', 'blocked', 'backlog'],
        blocked: ['backlog', 'doing', 'qa', 'archived'],
        done: ['archived', 'doing', 'backlog'],
        archived: [],
    },
} as const satisfies Record<'story' | 'task', Record<string, readonly string[]>>;

/** Each card's one-click next step by status, and the card field that must be true for it (tynn.ai's card buttons). */
export const BOARD_QUICK_ACTIONS: Readonly<Record<BoardKind, Readonly<Record<string, { readonly verb: string; readonly guard?: string }>>>> = {
    version: {
        draft: { verb: 'accept' },
        accepted: { verb: 'start' },
        active: { verb: 'review' },
        review: { verb: 'release' },
        vip: { verb: 'release' },
        rejected: { verb: 'restart' },
    },
    story: {
        backlog: { verb: 'start', guard: 'can_start' },
        in_progress: { verb: 'ready', guard: 'can_move_to_qa' },
        qa: { verb: 'done' },
        blocked: { verb: 'restart' },
    },
    task: {
        backlog: { verb: 'start', guard: 'can_start' },
        doing: { verb: 'ready', guard: 'version_active' },
        qa: { verb: 'done', guard: 'version_active' },
        blocked: { verb: 'restart' },
    },
};

/** The actions the Tynn tab offers, and the call behind each — under `/api/v1/projects/{projectId}`. */
export const BOARD_API: Readonly<Record<string, { readonly method: 'POST' | 'DELETE'; readonly path: string }>> = {
    'version.accept': { method: 'POST', path: '/versions/{versionId}/accept' },
    'version.start': { method: 'POST', path: '/versions/{versionId}/start' },
    'version.review': { method: 'POST', path: '/versions/{versionId}/review' },
    'version.release': { method: 'POST', path: '/versions/{versionId}/release' },
    'version.restart': { method: 'POST', path: '/versions/{versionId}/restart' },
    'version.delete': { method: 'DELETE', path: '/versions/{versionId}' },
    'story.start': { method: 'POST', path: '/stories/{storyId}/start' },
    'story.ready': { method: 'POST', path: '/stories/{storyId}/ready' },
    'story.done': { method: 'POST', path: '/stories/{storyId}/done' },
    'story.restart': { method: 'POST', path: '/stories/{storyId}/restart' },
    'story.block': { method: 'POST', path: '/stories/{storyId}/block' },
    'story.move': { method: 'POST', path: '/stories/{storyId}/move' },
    'story.delete': { method: 'DELETE', path: '/stories/{storyId}' },
    'task.start': { method: 'POST', path: '/tasks/{taskId}/start' },
    'task.ready': { method: 'POST', path: '/tasks/{taskId}/ready' },
    'task.done': { method: 'POST', path: '/tasks/{taskId}/done' },
    'task.restart': { method: 'POST', path: '/tasks/{taskId}/restart' },
    'task.block': { method: 'POST', path: '/tasks/{taskId}/block' },
    'task.move': { method: 'POST', path: '/tasks/{taskId}/move' },
    'task.delete': { method: 'DELETE', path: '/tasks/{taskId}' },
};

/** What tynn.ai's board offers that this tab does not yet — each needs Tynn's JSON door first (.ai/plans/genie-2-tynn-tab-parity.md). */
const NEEDS_TYNN_API = 'Tynn has no pairing-token API for it yet (genie-2-tynn-tab-parity.md, row B2)';
export const BOARD_GAPS: Readonly<Record<string, string>> = {
    'version.create': NEEDS_TYNN_API,
    'version.edit': NEEDS_TYNN_API,
    'story.create': NEEDS_TYNN_API,
    'story.edit': NEEDS_TYNN_API,
    'story.claim': NEEDS_TYNN_API,
    'story.unclaim': NEEDS_TYNN_API,
    'story.assign': NEEDS_TYNN_API,
    'task.create': NEEDS_TYNN_API,
    'task.edit': NEEDS_TYNN_API,
    'task.claim': NEEDS_TYNN_API,
    'task.unclaim': NEEDS_TYNN_API,
    'task.assign': NEEDS_TYNN_API,
    'board.claimants': NEEDS_TYNN_API,
};

/** Every state the tab draws (TynnBoardPanel), as the contract names them. */
export const BOARD_STATES = ['loading', 'empty-column', 'drill-down', 'illegal-drop', 'override-armed', 'transition-refused', 'not-linked', 'signed-out'] as const;

// ── The view ────────────────────────────────────────────────────────────────────────────────────────────────────────

const KIND_OF: Record<BoardLevel, BoardKind> = { versions: 'version', stories: 'story', tasks: 'task' };

/** Few words (the owner: reduce reading): a column is its status, as tynn.ai labels it. */
export const COLUMN_LABEL: Readonly<Record<string, string>> = {
    draft: 'Draft', accepted: 'Accepted', active: 'Active', review: 'Review',
    backlog: 'Backlog', blocked: 'Blocked', in_progress: 'In progress', doing: 'Doing', qa: 'QA', done: 'Done',
};

/** A step is an icon (named for a screen reader), as tynn.ai's card buttons are. */
const STEP: Readonly<Record<string, { icon: string; label: string }>> = {
    accept: { icon: 'check', label: 'Accept' },
    start: { icon: 'play', label: 'Start' },
    review: { icon: 'eye', label: 'Review' },
    release: { icon: 'rocket', label: 'Release' },
    restart: { icon: 'rotate-ccw', label: 'Restart' },
    ready: { icon: 'shield-check', label: 'Ready for QA' },
    done: { icon: 'circle-check', label: 'Done' },
    block: { icon: 'ban', label: 'Block' },
};

export interface BoardStep { readonly verb: string; readonly actionId: string; readonly disabled: boolean; readonly icon: string; readonly label: string }
export interface BoardCard {
    readonly id: string;
    readonly kind: BoardKind;
    /** `0.4` for a version, `#7` for a story or task. */
    readonly number: string | null;
    readonly title: string;
    readonly status: string;
    readonly order: number;
    /** `3/5` — done of total, under a version's or story's card. */
    readonly progress: string | null;
    readonly claimedBy: string | null;
    readonly quick: BoardStep | null;
    /** Where opening the card goes: a version's stories, a story's tasks; a task opens nothing. */
    readonly drill: BoardScope | null;
}
export interface BoardColumnView { readonly status: string; readonly label: string; readonly cards: readonly BoardCard[] }
export interface BoardView {
    readonly level: BoardLevel;
    readonly versionId: string | null;
    readonly storyId: string | null;
    /** One level up (the versions board is `{}`); null on the versions board itself. */
    readonly up: BoardScope | null;
    readonly crumbs: ReadonlyArray<{ readonly label: string; readonly scope: BoardScope }>;
    readonly columns: readonly BoardColumnView[];
    readonly draggable: boolean;
}

export type TynnBoardState =
    | { readonly state: 'loading' }
    | { readonly state: 'not-linked' }
    | { readonly state: 'signed-out'; readonly reason: string }
    | { readonly state: 'error'; readonly reason: string }
    | { readonly state: 'ready'; readonly view: BoardView; readonly refused?: string | null };

/** One action on the board: the contract's id, the item's ids, and — for a drag — the column, the place and Shift. */
export interface BoardActionInput { readonly action: string; readonly ids: BoardIds; readonly body?: { status: string; order: number; override?: boolean } }
export type BoardRefusal = { ok: false; state: 'not-linked' | 'signed-out' | 'transition-refused' | 'error'; reason: string };
/** What the tab needs from the host: the board at a scope, and one action — both for the WORKSPACE's own project. */
export interface TynnBoardHost {
    read(workspaceId: string, scope: BoardScope): Promise<{ ok: true; view: BoardView } | BoardRefusal>;
    act(workspaceId: string, input: BoardActionInput): Promise<{ ok: true } | BoardRefusal>;
}

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function quickStep(kind: BoardKind, status: string, row: Row): BoardStep | null {
    const step = BOARD_QUICK_ACTIONS[kind][status];
    if (!step) return null;
    const look = STEP[step.verb] ?? { icon: 'arrow-right', label: step.verb };
    return { verb: step.verb, actionId: `${kind}.${step.verb}`, disabled: step.guard !== undefined && row[step.guard] !== true, icon: look.icon, label: look.label };
}

function card(kind: BoardKind, row: Row): BoardCard | null {
    const id = str(row.id);
    const status = str(row.status);
    if (id === null || status === null) return null;
    const n = kind === 'version' ? str(row.number) : str(kind === 'story' ? row.story_number : row.task_number);
    const [done, total]: [number | null, number | null] = kind === 'version' ? [num(row.stories_done), num(row.story_count)] : kind === 'story' ? [num(row.tasks_done), num(row.task_count)] : [null, null];
    const claim = isRow(row.claimed_by) ? str(row.claimed_by.name) : null;
    return {
        id,
        kind,
        number: n === null ? null : kind === 'version' ? n : `#${n}`,
        title: str(row.title) ?? '',
        status,
        order: num(row.order) ?? 0,
        progress: total !== null && total > 0 ? `${done ?? 0}/${total}` : null,
        claimedBy: claim,
        quick: quickStep(kind, status, row),
        drill: kind === 'version' ? { version: id } : kind === 'story' ? { story: id } : null,
    };
}

/** Tynn's board answer (GET /board) as the tab draws it; null when it is not a board — never an empty one. */
export function parseBoard(json: unknown): BoardView | null {
    if (!isRow(json)) return null;
    const level = json.level;
    if (level !== 'versions' && level !== 'stories' && level !== 'tasks') return null;
    const rows = json[level];
    if (!Array.isArray(rows)) return null;
    const kind = KIND_OF[level];
    const cards = rows.filter(isRow).map((r) => card(kind, r)).filter((c): c is BoardCard => c !== null);
    const columns = BOARD_LEVELS[level].columns.map((status) => ({
        status,
        label: COLUMN_LABEL[status] ?? status,
        cards: cards.filter((c) => c.status === status).sort((a, b) => a.order - b.order),
    }));

    const activeVersion = isRow(json.active_version) ? json.active_version : null;
    const activeStory = isRow(json.active_story) ? json.active_story : null;
    const versionId = str(json.version_id) ?? (activeVersion ? str(activeVersion.id) : null);
    const storyId = str(json.story_id) ?? (activeStory ? str(activeStory.id) : null);
    const storyVersion = activeStory ? str(activeStory.version_id) : null;

    const crumbs: Array<{ label: string; scope: BoardScope }> = [];
    if (level !== 'versions' && activeVersion) {
        const id = str(activeVersion.id);
        if (id !== null) crumbs.push({ label: str(activeVersion.number) ?? str(activeVersion.title) ?? id, scope: { version: id } });
    }
    if (level === 'tasks' && activeStory && storyId !== null) {
        const n = str(activeStory.story_number);
        crumbs.push({ label: [n !== null ? `#${n}` : null, str(activeStory.title)].filter(Boolean).join(' '), scope: { story: storyId } });
    }

    const upVersion = versionId ?? storyVersion;
    const up: BoardScope | null = level === 'versions' ? null : level === 'stories' ? {} : upVersion !== null ? { version: upVersion } : {};
    return { level, versionId, storyId, up, crumbs, columns, draggable: BOARD_DRAG[level] };
}

/** May a card dragged from `from` land in `to`? Its own column (a reorder) always; Shift anywhere; versions never drag. */
export function canDrop(level: BoardLevel, from: string, to: string, override: boolean): boolean {
    if (!BOARD_DRAG[level]) return false;
    if (from === to || override) return true;
    const graph: Readonly<Record<string, readonly string[]>> = level === 'stories' ? BOARD_TRANSITIONS.story : BOARD_TRANSITIONS.task;
    return (graph[from] ?? []).includes(to);
}

const base = (projectId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}`;

/** GET the board for a scope — always under the workspace's own project. */
export function boardQueryPath(projectId: string, scope: BoardScope): string {
    const q = scope.story !== undefined ? `?story=${encodeURIComponent(scope.story)}` : scope.version !== undefined ? `?version=${encodeURIComponent(scope.version)}` : '';
    return `${base(projectId)}${BOARD_DATA_API.path}${q}`;
}

/** The call behind an offered action, its ids encoded; null for an action not offered or an id it needs and lacks. */
export function boardActionRequest(projectId: string, action: string, ids: BoardIds): { method: 'POST' | 'DELETE'; path: string } | null {
    const api = BOARD_API[action];
    if (!api) return null;
    let missing = false;
    const path = api.path.replace(/\{(versionId|storyId|taskId)\}/g, (_m, key: keyof BoardIds) => {
        const value = ids[key];
        if (typeof value !== 'string' || value === '') { missing = true; return ''; }
        return encodeURIComponent(value);
    });
    return missing ? null : { method: api.method, path: `${base(projectId)}${path}` };
}

/** The ids an action on a card needs, from the card itself. */
export function idsOf(c: Pick<BoardCard, 'id' | 'kind'>): BoardIds {
    return c.kind === 'version' ? { versionId: c.id } : c.kind === 'story' ? { storyId: c.id } : { taskId: c.id };
}
