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
/** Where the tab is: a version's stories, a story's tasks, and (as tynn.ai's `?focus=`) the card whose detail is open. */
export interface BoardScope { readonly version?: string; readonly story?: string; readonly focus?: string }
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
    story: ['id', 'story_number', 'title', 'status', 'order', 'task_count', 'tasks_done', 'claimed_by', 'claimed_by_me', 'can_start', 'can_move_to_qa', 'version_active'],
    task: ['id', 'task_number', 'title', 'status', 'order', 'story_id', 'claimed_by', 'claimed_by_me', 'can_start', 'version_active'],
} as const satisfies Record<BoardKind, readonly string[]>;

/**
 * Claims, as tynn.ai's board does them (row B3): the board answer's `claims` {mode, policy, can_assign}; a backlog card's
 * Start by claim mode (off or already mine: start; optional: choose Claim + Start or Start; required: claim, then start);
 * only the claimant releases (`claimed_by_me`); only a person who may manage the project assigns (`can_assign`).
 */
export const BOARD_CLAIMS = {
    field: 'claims',
    keys: ['mode', 'policy', 'can_assign'],
    modes: ['off', 'optional', 'required'],
    policies: ['any', 'human', 'agent'],
    start: { off: 'start', optional: 'choose', required: 'claim-then-start', mine: 'start' },
    release: 'claimed_by_me',
    assign: 'can_assign',
} as const;
export type ClaimMode = (typeof BOARD_CLAIMS.modes)[number];
export type StartPlan = (typeof BOARD_CLAIMS.start)[keyof typeof BOARD_CLAIMS.start];

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
export type BoardMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export const BOARD_API: Readonly<Record<string, { readonly method: BoardMethod; readonly path: string }>> = {
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
    'story.create': { method: 'POST', path: '/stories' },
    'story.edit': { method: 'PATCH', path: '/stories/{storyId}' },
    'story.detail': { method: 'GET', path: '/stories/{storyId}' },
    'story.claim': { method: 'POST', path: '/stories/{storyId}/claim' },
    'story.unclaim': { method: 'POST', path: '/stories/{storyId}/release' },
    'story.assign': { method: 'POST', path: '/stories/{storyId}/assign' },
    'task.start': { method: 'POST', path: '/tasks/{taskId}/start' },
    'task.ready': { method: 'POST', path: '/tasks/{taskId}/ready' },
    'task.done': { method: 'POST', path: '/tasks/{taskId}/done' },
    'task.restart': { method: 'POST', path: '/tasks/{taskId}/restart' },
    'task.block': { method: 'POST', path: '/tasks/{taskId}/block' },
    'task.move': { method: 'POST', path: '/tasks/{taskId}/move' },
    'task.delete': { method: 'DELETE', path: '/tasks/{taskId}' },
    'task.create': { method: 'POST', path: '/tasks' },
    'task.edit': { method: 'PATCH', path: '/tasks/{taskId}' },
    'task.detail': { method: 'GET', path: '/tasks/{taskId}' },
    'task.claim': { method: 'POST', path: '/tasks/{taskId}/claim' },
    'task.unclaim': { method: 'POST', path: '/tasks/{taskId}/release' },
    'task.assign': { method: 'POST', path: '/tasks/{taskId}/assign' },
    'board.claimants': { method: 'GET', path: '/claimants' },
};

/** What tynn.ai's board offers that this tab does not yet — each needs Tynn's JSON door first (.ai/plans/genie-2-tynn-tab-parity.md). */
const NEEDS_VERSION_API = 'Tynn has no pairing-token API for creating or editing versions yet (genie-2-tynn-tab-parity.md, row B2: versions)';
export const BOARD_GAPS: Readonly<Record<string, string>> = {
    'version.create': NEEDS_VERSION_API,
    'version.edit': NEEDS_VERSION_API,
};

/** Every state the tab draws (TynnBoardPanel), as the contract names them. */
export const BOARD_STATES = ['loading', 'empty-column', 'drill-down', 'illegal-drop', 'override-armed', 'transition-refused', 'detail', 'create-in-backlog', 'claim-start', 'claimed', 'assign', 'live', 'reconnecting', 'not-linked', 'signed-out'] as const;

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
    /** Who holds the card, as its badge draws them; `mine` when it is this person (who may release it). */
    readonly claim: BoardClaim | null;
    readonly quick: BoardStep | null;
    /** Where opening the card goes: a version's stories, a story's tasks; a task opens nothing. */
    readonly drill: BoardScope | null;
}
export interface BoardClaim { readonly type: 'user' | 'agent'; readonly id: string; readonly name: string; readonly initials: string; readonly mine: boolean }
/** The project's claim settings for this person; null from a Tynn that does not send them (Start is then plain). */
export interface BoardClaims { readonly mode: ClaimMode; readonly policy: string; readonly canAssign: boolean }
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
    readonly claims: BoardClaims | null;
    /** Every card at the level, in Tynn's order, including those no column shows (a released version). */
    readonly cards: readonly BoardCard[];
    /** Where the live board's first "what changed since" starts (row B4); null from a Tynn that does not send one. */
    readonly cursor: string | null;
}

export type TynnBoardState =
    | { readonly state: 'loading' }
    | { readonly state: 'not-linked' }
    | { readonly state: 'signed-out'; readonly reason: string }
    | { readonly state: 'error'; readonly reason: string }
    | {
        readonly state: 'ready';
        readonly view: BoardView;
        readonly refused?: string | null;
        /** The open card's detail (the scope's focus), or null with why when Tynn would not show it. */
        readonly detail?: BoardDetail | null;
        readonly detailRefused?: string | null;
        /** The create or edit in flight, or how the last one ended. */
        readonly op?: BoardOp | null;
    };

/** One action on the board: the contract's id, the item's ids, and — for a drag — the column, the place and Shift. */
/**
 * One action on the board: the contract's id, the item's ids, and its body: for a drag the column, the place and Shift;
 * for a create the title and description (the parent is in `ids`); for an edit the fields that change.
 */
export interface BoardActionInput { readonly action: string; readonly ids: BoardIds; readonly body?: Readonly<Record<string, unknown>> }
export type BoardRefusal = { ok: false; state: 'not-linked' | 'signed-out' | 'transition-refused' | 'error'; reason: string };
/** What the tab needs from the host: the board at a scope, and one action — both for the WORKSPACE's own project. */
export interface TynnBoardHost {
    read(workspaceId: string, scope: BoardScope): Promise<{ ok: true; view: BoardView; detail?: BoardDetail | null; detailRefused?: string | null } | BoardRefusal>;
    /** One action; `board.claimants` answers the project's eligible claimants. */
    act(workspaceId: string, input: BoardActionInput): Promise<{ ok: true; claimants?: readonly Claimant[] } | BoardRefusal>;
    /** Row B4: what changed at a scope since a cursor (and the open card's detail, when that card changed). */
    changes?(workspaceId: string, scope: BoardScope, cursor: string, ids: readonly string[]): Promise<{ ok: true; changes: BoardChanges; detail?: BoardDetail | null } | BoardRefusal>;
    /** Row B4: follow the workspace's board — its live state and its rings — until the answer is called. */
    watch?(workspaceId: string, listener: (signal: BoardLiveSignal) => void): () => void;
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
    const claimRow = isRow(row.claimed_by) ? row.claimed_by : null;
    const claim = claimRow ? str(claimRow.name) : null;
    const claimType = claimRow?.type === 'agent' ? 'agent' : claimRow?.type === 'user' ? 'user' : null;
    const claimId = claimRow ? str(claimRow.id) : null;
    return {
        id,
        kind,
        number: n === null ? null : kind === 'version' ? n : `#${n}`,
        title: str(row.title) ?? '',
        status,
        order: num(row.order) ?? 0,
        progress: total !== null && total > 0 ? `${done ?? 0}/${total}` : null,
        claimedBy: claim,
        claim: claim !== null && claimType !== null && claimId !== null
            ? { type: claimType, id: claimId, name: claim, initials: initialsOf(claim), mine: row.claimed_by_me === true }
            : null,
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
    const columns = columnsOf(level, cards);

    const activeVersion = isRow(json.active_version) ? json.active_version : null;
    const activeStory = isRow(json.active_story) ? json.active_story : null;
    const versionId = str(json.version_id) ?? (activeVersion ? str(activeVersion.id) : null);
    const storyId = str(json.story_id) ?? (activeStory ? str(activeStory.id) : null);
    const storyVersion = activeStory ? str(activeStory.version_id) : null;

    const upVersion = versionId ?? storyVersion;
    const up: BoardScope | null = level === 'versions' ? null : level === 'stories' ? {} : upVersion !== null ? { version: upVersion } : {};
    return {
        level, versionId, storyId, up, crumbs: crumbsOf(level, activeVersion, activeStory, storyId), columns,
        draggable: BOARD_DRAG[level], claims: parseClaims(json[BOARD_CLAIMS.field]), cards, cursor: str(json.cursor),
    };
}

function columnsOf(level: BoardLevel, cards: readonly BoardCard[]): BoardColumnView[] {
    return BOARD_LEVELS[level].columns.map((status) => ({
        status,
        label: COLUMN_LABEL[status] ?? status,
        cards: cards.filter((c) => c.status === status).sort((a, b) => a.order - b.order),
    }));
}

function crumbsOf(level: BoardLevel, activeVersion: Row | null, activeStory: Row | null, storyId: string | null): Array<{ label: string; scope: BoardScope }> {
    const crumbs: Array<{ label: string; scope: BoardScope }> = [];
    if (level !== 'versions' && activeVersion) {
        const id = str(activeVersion.id);
        if (id !== null) crumbs.push({ label: str(activeVersion.number) ?? str(activeVersion.title) ?? id, scope: { version: id } });
    }
    if (level === 'tasks' && activeStory && storyId !== null) {
        const n = str(activeStory.story_number);
        crumbs.push({ label: [n !== null ? `#${n}` : null, str(activeStory.title)].filter(Boolean).join(' '), scope: { story: storyId } });
    }
    return crumbs;
}

function parseClaims(raw: unknown): BoardClaims | null {
    if (!isRow(raw)) return null;
    const mode = (BOARD_CLAIMS.modes as readonly unknown[]).includes(raw.mode) ? (raw.mode as ClaimMode) : null;
    if (mode === null) return null;
    return { mode, policy: str(raw.policy) ?? 'any', canAssign: raw.can_assign === true };
}

/** A person's initials for a claim badge: the first and last word's first letters ("Ada Lovelace" → AL). */
export function initialsOf(name: string): string {
    const words = name.trim().split(/\s+/).filter((w) => w !== '');
    if (words.length === 0) return '?';
    const first = words[0]!.charAt(0);
    const last = words.length > 1 ? words[words.length - 1]!.charAt(0) : '';
    return (first + last).toUpperCase();
}

/** How a backlog card's Start runs under the project's claim mode, as tynn.ai's Claim.jsx decides it. */
export function startPlan(card: Pick<BoardCard, 'claim'>, claims: BoardClaims | null): StartPlan {
    if (claims === null || card.claim?.mine === true) return BOARD_CLAIMS.start.mine;
    return BOARD_CLAIMS.start[claims.mode];
}

/** One of the project's eligible claimants (GET /claimants): a member or an agent. */
export interface Claimant { readonly type: 'user' | 'agent'; readonly id: string; readonly name: string }
export function parseClaimants(json: unknown): Claimant[] {
    const rows = isRow(json) && Array.isArray(json.claimants) ? json.claimants : [];
    return rows.filter(isRow).flatMap((r) => {
        const id = str(r.id);
        const name = str(r.name);
        return (r.type === 'user' || r.type === 'agent') && id !== null && name !== null ? [{ type: r.type, id, name }] : [];
    });
}

/** What an assign sends: the claimant's type and id, as Tynn names them; null without a person or an agent. */
export function assignBody(raw: unknown): { assignee_type: 'user' | 'agent'; assignee_id: string } | null {
    if (!isRow(raw)) return null;
    const id = str(raw.id);
    return (raw.type === 'user' || raw.type === 'agent') && id !== null ? { assignee_type: raw.type, assignee_id: id } : null;
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
export function boardActionRequest(projectId: string, action: string, ids: BoardIds): { method: BoardMethod; path: string } | null {
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

// ── Row B2: create, edit and the detail flyout (workspace-ux 0.2.0) ──────────────────────────────────────────────────

/** The kind a "New …" in the start column makes at a level; null where Tynn has no API for it yet (versions). */
export function newItemKind(level: BoardLevel): 'story' | 'task' | null {
    return level === 'stories' ? 'story' : level === 'tasks' ? 'task' : null;
}

/** A card's detail as the flyout draws it: Tynn's FocusPayloadService answer, trimmed to what is shown and edited. */
export interface BoardDetail {
    readonly kind: 'story' | 'task';
    readonly id: string;
    readonly number: string | null;
    readonly title: string;
    readonly description: string;
    readonly status: string;
    /** A story's acceptance criteria. */
    readonly acceptanceCriteria: readonly string[];
    /** A story's tasks. */
    readonly tasks: ReadonlyArray<{ readonly id: string; readonly number: string | null; readonly title: string; readonly status: string }>;
    readonly features: readonly string[];
    /** A task's verification steps and code area. */
    readonly verificationSteps: readonly string[];
    readonly codeArea: string | null;
    /** A story's version, a task's story. */
    readonly parent: { readonly id: string; readonly label: string } | null;
    /** A story's tags, persona, outcome metric, risk, effort points and definition of done (tynn.ai's flyout). */
    readonly tags: readonly string[];
    readonly persona: string | null;
    readonly outcomeMetric: string | null;
    readonly riskLevel: RiskLevel | null;
    readonly effortPoints: number | null;
    readonly dodReference: string | null;
    /** A task's environment; null when Tynn's detail did not carry it, so it is neither shown as empty nor sent back. */
    readonly envRequirements: readonly string[] | null;
    readonly blockingOn: readonly string[];
    readonly produces: readonly string[];
}

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
const riskOf = (v: unknown): RiskLevel | null => (typeof v === 'string' && (RISK_LEVELS as readonly string[]).includes(v) ? (v as RiskLevel) : null);
const effortOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const hash = (n: string | null) => (n === null ? null : `#${n}`);

/** Tynn's detail answer (GET /stories/{id}, /tasks/{id}) as the flyout draws it; null when it is not a story or task. */
export function parseDetail(json: unknown): BoardDetail | null {
    if (!isRow(json)) return null;
    const kind = json.kind;
    if (kind !== 'story' && kind !== 'task') return null;
    const id = str(json.id);
    const status = str(json.status);
    if (id === null || status === null) return null;
    const parentRow = kind === 'story' ? json.version : json.story;
    let parent: BoardDetail['parent'] = null;
    if (isRow(parentRow) && str(parentRow.id) !== null) {
        const n = str(parentRow.number);
        const label = kind === 'story' ? (n ?? str(parentRow.title) ?? '') : [hash(n), str(parentRow.title)].filter(Boolean).join(' ');
        parent = { id: str(parentRow.id)!, label };
    }
    return {
        kind,
        id,
        number: hash(str(json.number)),
        title: str(json.title) ?? '',
        description: typeof json.description === 'string' ? json.description : '',
        status,
        acceptanceCriteria: strings(json.acceptance_criteria),
        tasks: Array.isArray(json.tasks)
            ? json.tasks.filter(isRow).flatMap((t) => {
                const tid = str(t.id);
                return tid === null ? [] : [{ id: tid, number: hash(str(t.number)), title: str(t.title) ?? '', status: str(t.status) ?? '' }];
            })
            : [],
        features: Array.isArray(json.features) ? json.features.flatMap((f) => (isRow(f) ? [str(f.title)] : [str(f)])).filter((f): f is string => f !== null) : [],
        verificationSteps: strings(json.verification_steps),
        codeArea: str(json.code_area),
        parent,
        tags: strings(json.tags),
        persona: str(json.persona),
        outcomeMetric: str(json.outcome_metric),
        riskLevel: riskOf(json.risk_level),
        effortPoints: effortOf(json.effort_points),
        dodReference: str(json.dod_reference),
        envRequirements: Array.isArray(json.env_requirements) ? strings(json.env_requirements) : null,
        blockingOn: strings(json.blocking_on),
        produces: strings(json.produces),
    };
}

/** The detail call for a focus (`story:<id>` or `task:<id>`, as tynn.ai's `?focus=`); null for anything else. */
export function boardDetailRequest(projectId: string, focus: string | undefined): { method: BoardMethod; path: string } | null {
    const m = typeof focus === 'string' ? /^(story|task):(.+)$/.exec(focus) : null;
    const id = m?.[2];
    if (!m || id === undefined) return null;
    return m[1] === 'story' ? boardActionRequest(projectId, 'story.detail', { storyId: id }) : boardActionRequest(projectId, 'task.detail', { taskId: id });
}

const lines = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x !== '') : null);

/**
 * What a create sends: the parent (from the card's scope), a title and a description, both required by Tynn. Never a
 * status: a new item starts in backlog (tynn.ai#365). Null when something required is missing.
 */
export function createBody(kind: 'story' | 'task', ids: BoardIds, raw: unknown): Record<string, string> | null {
    const b = isRow(raw) ? raw : {};
    const parent = kind === 'story' ? ids.versionId : ids.storyId;
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    const description = typeof b.description === 'string' ? b.description.trim() : '';
    if (typeof parent !== 'string' || parent === '' || title === '' || description === '') return null;
    return { [kind === 'story' ? 'version_id' : 'story_id']: parent, title, description };
}

/** A free-text field: trimmed; empty clears it (null); anything else is not sent (undefined). */
const text = (v: unknown): string | null | undefined => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v === null ? null : undefined);

/**
 * What an edit sends: only the fields tynn.ai's flyout edits. A story: title, description, acceptance criteria, tags,
 * persona, outcome metric, risk, effort points, definition of done. A task: title, description, verification steps, code
 * area, environment, blocking-on, produces. Never a status: that moves through the workflow. A risk or an effort Tynn
 * would refuse is not sent; an empty one clears. Null when there is nothing to change or the title would be empty.
 */
export function editBody(kind: 'story' | 'task', raw: unknown): Record<string, unknown> | null {
    const b = isRow(raw) ? raw : {};
    const out: Record<string, unknown> = {};
    if (b.title !== undefined) {
        if (typeof b.title !== 'string' || b.title.trim() === '') return null;
        out.title = b.title.trim();
    }
    if (typeof b.description === 'string') out.description = b.description;
    const listFields = kind === 'story' ? ['acceptance_criteria', 'tags'] : ['verification_steps', 'env_requirements', 'blocking_on', 'produces'];
    for (const key of listFields) {
        const list = lines(b[key]);
        if (list !== null) out[key] = list;
    }
    if (kind === 'story') {
        for (const key of ['persona', 'outcome_metric', 'dod_reference']) {
            const value = text(b[key]);
            if (value !== undefined) out[key] = value;
        }
        if (b.risk_level === '' || b.risk_level === null) out.risk_level = null;
        else if (riskOf(b.risk_level) !== null) out.risk_level = b.risk_level;
        if (b.effort_points === '' || b.effort_points === null) out.effort_points = null;
        else if (effortOf(b.effort_points) !== null) out.effort_points = b.effort_points;
    } else {
        if (typeof b.code_area === 'string') out.code_area = b.code_area.trim();
        else if (b.code_area === null) out.code_area = null;
    }
    return Object.keys(out).length > 0 ? out : null;
}

/** What the detail holds for each field an edit can send, as Tynn names it; `undefined` = not known here, never sent. */
function heldValues(d: BoardDetail): Record<string, unknown> {
    const common = { title: d.title, description: d.description };
    return d.kind === 'story'
        ? { ...common, acceptance_criteria: d.acceptanceCriteria, tags: d.tags, persona: d.persona, outcome_metric: d.outcomeMetric, risk_level: d.riskLevel, effort_points: d.effortPoints, dod_reference: d.dodReference }
        : { ...common, verification_steps: d.verificationSteps, code_area: d.codeArea ?? '', env_requirements: d.envRequirements ?? undefined, blocking_on: d.blockingOn, produces: d.produces };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The edit the person made: the form's fields (cleaned as editBody cleans them) that differ from what the detail holds.
 * A field the detail could not show (an environment an older Tynn did not send) is never sent, so a save cannot wipe
 * what Tynn keeps. `{}` when nothing changed.
 */
export function changedEdit(detail: BoardDetail, form: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const cleaned = editBody(detail.kind, form) ?? {};
    const held = heldValues(detail);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(cleaned)) {
        if (held[key] === undefined) continue;
        if (!same(held[key], key === 'code_area' && value === null ? '' : value)) out[key] = value;
    }
    return out;
}

/** A create or an edit, in flight or ended: what the tab says while it runs, and after. */
export interface BoardOp { readonly action: string; readonly phase: 'running' | 'done' | 'failed'; readonly reason?: string }

/** Run one action and say so: `running` first, then `done` or `failed` with the reason (never silent, never a hang). */
export async function performBoardAction(
    host: Pick<TynnBoardHost, 'act'>,
    workspaceId: string,
    input: BoardActionInput,
    report: (op: BoardOp) => void,
): Promise<{ ok: true } | BoardRefusal> {
    report({ action: input.action, phase: 'running' });
    let r: { ok: true } | BoardRefusal;
    try {
        r = await host.act(workspaceId, input);
    } catch (error) {
        r = { ok: false, state: 'error', reason: error instanceof Error ? error.message : String(error) };
    }
    report(r.ok ? { action: input.action, phase: 'done' } : { action: input.action, phase: 'failed', reason: r.reason });
    return r;
}

/**
 * tynn.ai's "Claim + Start": claim, and start only once the claim has landed (a required-mode project will not start an
 * unclaimed card). One progress line for both (`<kind>.claim-start`): running, then done, or the step's own reason.
 */
export async function performClaimThenStart(
    host: Pick<TynnBoardHost, 'act'>,
    workspaceId: string,
    kind: 'story' | 'task',
    ids: BoardIds,
    report: (op: BoardOp) => void,
): Promise<{ ok: true } | BoardRefusal> {
    const action = `${kind}.claim-start`;
    report({ action, phase: 'running' });
    const run = async (step: string): Promise<{ ok: true } | BoardRefusal> => {
        try {
            const r = await host.act(workspaceId, { action: `${kind}.${step}`, ids });
            return r.ok ? { ok: true } : r;
        } catch (error) {
            return { ok: false, state: 'error', reason: error instanceof Error ? error.message : String(error) };
        }
    };
    let r = await run('claim');
    if (r.ok) r = await run('start');
    report(r.ok ? { action, phase: 'done' } : { action, phase: 'failed', reason: r.reason });
    return r;
}

// ── Row B4: the live board (workspace-ux 0.5.0) ──────────────────────────────────────────────────────────────────────

/**
 * How the board goes live, as the contract's `data.live` declares it (its prose left out). The events are the web
 * board's own; the channel is the board's own (0.5.0, the owner's "split per audience"): Tynn admits to it exactly
 * whoever may open the board, and rings the board's events there too. Genie never listens to a second stream, and never
 * to the project's general channel (its issues, its comments).
 */
export const BOARD_LIVE = {
    channel: 'private-project-board.{projectId}',
    push: { method: 'GET', path: '/api/v1/broadcasting-config', scope: 'genie:discovery' },
    auth: { method: 'POST', path: '/broadcasting-auth', body: ['socket_id', 'channel_name'] },
    events: ['version.created', 'version.updated', 'version.deleted', 'story.created', 'story.updated', 'story.deleted', 'task.created', 'task.updated', 'task.deleted'],
    cursor: 'cursor',
    changes: {
        method: 'GET',
        path: '/board/changes',
        query: ['since', 'ids[]', 'version', 'story', 'level', 'features[]', 'product'],
        answer: ['project_id', 'level', 'version_id', 'story_id', 'cursor', 'ids', 'rows', 'active_version', 'active_story', 'claims'],
    },
} as const;

/** The live icon: following Tynn, getting there, the link dropped, or not live at all (no icon). */
export type LiveState = 'connecting' | 'live' | 'reconnecting' | 'off';
/** A ring: the ids an event named (the item and its parent), or a catch-up after (re)subscribing. */
export interface BoardRing { readonly ids: readonly string[]; readonly catchUp: boolean }
export type BoardLiveSignal = { readonly state: LiveState } | { readonly ring: BoardRing };

/** What changed at a level since a cursor (GET /board/changes). */
export interface BoardChanges {
    readonly level: BoardLevel;
    readonly versionId: string | null;
    readonly storyId: string | null;
    /** The next ask's cursor. */
    readonly cursor: string;
    /** Every row now at the level; a card not among them is gone. */
    readonly ids: readonly string[];
    readonly cards: readonly BoardCard[];
    readonly activeVersion: Readonly<Record<string, unknown>> | null;
    readonly activeStory: Readonly<Record<string, unknown>> | null;
    readonly claims: BoardClaims | null;
}

export function liveChannel(projectId: string): string {
    return BOARD_LIVE.channel.replace('{projectId}', projectId);
}

/** The pause before the next dial after `attempt` failed ones: 1 s, doubling, at most 30 s. */
export function liveReconnectDelay(attempt: number): number {
    return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
}

/** The ids a board event names: the item, and the parent it belongs to (a task's story, a story's version). */
export function ringIds(event: string, data: unknown): string[] {
    const kind = event.split('.')[0] ?? '';
    const row = isRow(data) && isRow(data[kind]) ? (data[kind] as Row) : null;
    if (row === null) return [];
    const parent = kind === 'task' ? row.story_id : kind === 'story' ? row.project_version_id : null;
    return [str(row.id), str(parent)].filter((id): id is string => id !== null);
}

/** GET what changed since a cursor, in the board's scope; `ids[]` asks for rows by id whatever their age. */
export function boardChangesPath(projectId: string, scope: BoardScope, cursor: string, ids: readonly string[]): string {
    const q = new URLSearchParams();
    if (scope.story !== undefined) q.append('story', scope.story);
    else if (scope.version !== undefined) q.append('version', scope.version);
    q.append('since', cursor);
    for (const id of ids) q.append('ids[]', id);
    return `${base(projectId)}${BOARD_LIVE.changes.path}?${q.toString()}`;
}

/** Tynn's changes answer; null when it is not one. */
export function parseBoardChanges(json: unknown): BoardChanges | null {
    if (!isRow(json)) return null;
    const level = json.level;
    if (level !== 'versions' && level !== 'stories' && level !== 'tasks') return null;
    const cursor = str(json.cursor);
    if (cursor === null || !Array.isArray(json.ids) || !Array.isArray(json.rows)) return null;
    const kind = KIND_OF[level];
    return {
        level,
        versionId: str(json.version_id),
        storyId: str(json.story_id),
        cursor,
        ids: json.ids.map(str).filter((id): id is string => id !== null),
        cards: json.rows.filter(isRow).map((r) => card(kind, r)).filter((c): c is BoardCard => c !== null),
        activeVersion: isRow(json.active_version) ? json.active_version : null,
        activeStory: isRow(json.active_story) ? json.active_story : null,
        claims: parseClaims(json[BOARD_CLAIMS.field]),
    };
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Apply what changed to the board, touching only what changed: a card whose row did not change keeps its object, a
 * column whose cards did not change keeps its object, and when nothing changed the very same view comes back — so the
 * tab redraws only what changed (the owner's rule for live views: never rebuild the whole view per update). `missing`
 * is the ids the answer says are at the level that the view holds no card for: ask for them; never invent them.
 * An answer for another level or scope (the person moved on while it was out) changes nothing.
 */
export function applyBoardChanges(view: BoardView, changes: BoardChanges): { view: BoardView; missing: string[] } {
    const sameScope = changes.level === view.level
        && (view.level !== 'tasks' || changes.storyId === view.storyId)
        && (view.level !== 'stories' || changes.versionId === view.versionId);
    if (!sameScope) return { view, missing: [] };

    const held = new Map(view.cards.map((c) => [c.id, c]));
    const fresh = new Map(changes.cards.map((c) => [c.id, c]));
    const missing: string[] = [];
    const cards: BoardCard[] = [];
    for (const id of changes.ids) {
        const old = held.get(id);
        const now = fresh.get(id);
        const next = now !== undefined && (old === undefined || !sameJson(now, old)) ? now : old;
        if (next === undefined) missing.push(id);
        else cards.push(next);
    }

    const columns = columnsOf(view.level, cards).map((col, i) => {
        const old = view.columns[i];
        return old !== undefined && old.cards.length === col.cards.length && old.cards.every((c, j) => c === col.cards[j]) ? old : col;
    });
    const nextCrumbs = changes.activeVersion !== null || changes.activeStory !== null
        ? crumbsOf(view.level, changes.activeVersion, changes.activeStory, view.storyId)
        : view.crumbs;
    const crumbs = sameJson(nextCrumbs, view.crumbs) ? view.crumbs : nextCrumbs;
    const claims = changes.claims !== null && !sameJson(changes.claims, view.claims) ? changes.claims : view.claims;
    const unchanged = cards.length === view.cards.length && cards.every((c, i) => c === view.cards[i])
        && columns.every((c, i) => c === view.columns[i]) && crumbs === view.crumbs && claims === view.claims;
    return unchanged ? { view, missing } : { view: { ...view, cards, columns, crumbs, claims }, missing };
}

/** How long a burst of rings is gathered into one ask. */
export const LIVE_QUIET_MS = 300;

export interface BoardFollowerPorts {
    /** The cursor the board is up to: from its read, then each applied answer. Null: this board cannot follow. */
    cursor(): string | null;
    fetch(cursor: string, ids: readonly string[]): Promise<{ ok: true; changes: BoardChanges } | { ok: false; state: string; reason: string }>;
    /** Apply an answer (and take its cursor); answers the ids it named that the board holds no card for. */
    apply(changes: BoardChanges): readonly string[];
    refused(refusal: { state: string; reason: string }): void;
    schedule(fn: () => void, ms: number): () => void;
}

/**
 * RINGS IN, WHAT CHANGED OUT: one ask per burst of rings (LIVE_QUIET_MS), carrying every id they named; at once for a
 * catch-up; one ask at a time, so a ring while one is out is asked after it, from the cursor it returned; and one more
 * ask for rows an answer named but did not carry. It never re-reads the board.
 */
export class BoardFollower {
    readonly #ports: BoardFollowerPorts;
    readonly #pending = new Set<string>();
    #cancel: (() => void) | null = null;
    #armedMs: number | null = null;
    #busy = false;
    #again = false;
    #urgent = false;
    #stopped = false;

    constructor(ports: BoardFollowerPorts) {
        this.#ports = ports;
    }

    ring(ids: readonly string[], catchUp: boolean): void {
        if (this.#stopped) return;
        for (const id of ids) this.#pending.add(id);
        if (catchUp) this.#urgent = true;
        if (this.#busy) { this.#again = true; return; }
        this.#arm();
    }

    stop(): void {
        this.#stopped = true;
        this.#cancel?.();
        this.#cancel = null;
    }

    #arm(): void {
        const ms = this.#urgent ? 0 : LIVE_QUIET_MS;
        if (this.#cancel !== null && this.#armedMs !== null && this.#armedMs <= ms) return;
        this.#cancel?.();
        this.#armedMs = ms;
        this.#cancel = this.#ports.schedule(() => { this.#cancel = null; this.#armedMs = null; void this.#pull(); }, ms);
    }

    async #pull(): Promise<void> {
        if (this.#stopped) return;
        const cursor = this.#ports.cursor();
        const ids = [...this.#pending];
        this.#pending.clear();
        this.#urgent = false;
        if (cursor === null) return;
        this.#busy = true;
        let answer: Awaited<ReturnType<BoardFollowerPorts['fetch']>>;
        try {
            answer = await this.#ports.fetch(cursor, ids);
        } catch (error) {
            answer = { ok: false, state: 'error', reason: error instanceof Error ? error.message : String(error) };
        }
        this.#busy = false;
        if (this.#stopped) return;
        if (answer.ok) {
            const asked = new Set(ids);
            for (const id of this.#ports.apply(answer.changes)) {
                if (!asked.has(id)) { this.#pending.add(id); this.#again = true; }
            }
        } else {
            this.#ports.refused({ state: answer.state, reason: answer.reason });
        }
        if (this.#again) { this.#again = false; this.#arm(); }
    }
}
