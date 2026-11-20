/**
 * A WORKSPACE'S DISK, BY CATEGORY (Tynn #697). The owner: "genie needs to track disk usage by workspace including trash
 * files like worktrees, ci artifacts and files shared in chat and provide a clean way to empty those into the .trash and
 * also an ability to purge that trash folder with user approval."
 *
 * The pure half: what the categories are, which folder names are CI/test artifacts, how `git worktree list --porcelain`
 * reads, and what an approval to empty the trash is (exactly the entries shown, and their total). The host half, which
 * walks the disk and moves things, is main/workspace-storage-host.ts.
 */

export type StorageCategory = 'repos' | 'worktrees' | 'ci-artifacts' | 'chat-files' | 'dirty' | 'trash';
export const STORAGE_CATEGORIES: readonly StorageCategory[] = ['repos', 'worktrees', 'ci-artifacts', 'chat-files', 'dirty', 'trash'];
export const CATEGORY_LABEL: Readonly<Record<StorageCategory, string>> = {
    repos: 'Repositories', worktrees: 'Worktrees', 'ci-artifacts': 'CI and test artifacts', 'chat-files': 'Files shared in chat', dirty: '.ai/_dirty', trash: '.trash',
};

/**
 * Where files dropped into a workspace land (Tynn #819; every envelope has one, #818). Each entry directly in it is a
 * `dirty` item, `dirty:<name>`: the person's own files, offered for .trash, never preselected by the one-click clean-up,
 * and never also counted as a CI artifact.
 */
export const DIRTY_REL = '.ai/_dirty';

/**
 * CI and test output folders, by name: what Genie's own jobs and the common runners leave behind (`ci-out` and `smoke-out`
 * are the Azure queue's fetch folders; `coverage`, `.nyc_output`, `test-results` and `playwright-report` the runners').
 * A folder is an artifact by its NAME and nothing else: source, `dist`, `node_modules` never are.
 */
export const ARTIFACT_NAMES: readonly string[] = ['ci-out', 'smoke-out', 'coverage', '.nyc_output', 'test-results', 'playwright-report', '.vite', '.turbo', '.parcel-cache', '.pytest_cache'];
export const isArtifactName = (name: string): boolean => ARTIFACT_NAMES.includes(name);
/**
 * The envelope's downloaded test results: each item the Azure queue fetched is a folder directly under
 * `.ai/sandbox/azure/queue` (hundreds of MB each; they filled the owner's drive). Artifacts by WHERE they are.
 */
const QUEUE_ITEM = /(^|\/)\.ai\/sandbox\/azure\/queue\/[^/]+$/;
export const isArtifactPath = (rel: string): boolean => isArtifactName(rel.split('/').at(-1) ?? '') || QUEUE_ITEM.test(rel);
/** Test results older than this are what the one-click clean-up offers. */
export const STALE_ARTIFACT_MS = 24 * 60 * 60 * 1000;
/** A worktree touched within this long may be an agent's, in use right now: the clean-up leaves it alone. */
export const QUIET_WORKTREE_MS = 60 * 60 * 1000;
/** Never looked inside for artifacts: dependencies, git's own folder, and the trash. */
export const ARTIFACT_WALK_SKIP: readonly string[] = ['node_modules', '.git', '.trash'];

export interface StorageItem {
    /** `<category>:<rel>`, or `chat-files:<agentId>/<attachmentId>`: what the window sends back, re-validated by the host. */
    readonly id: string;
    readonly category: StorageCategory;
    readonly label: string;
    /** Workspace-relative, `/`-separated (for chat files, `<agentId>/<file>`). */
    readonly rel: string;
    readonly bytes: number;
    readonly files: number;
    /** The walk stopped at its bound before the end: `bytes` is at least this. */
    readonly truncated: boolean;
    readonly reclaimable: boolean;
    /** Why it may not be moved to .trash, in words; `null` when it may, or when it is never offered (a repository). */
    readonly refusal: string | null;
    /** A worktree's state (the story's four, plus locked/unknown); absent for everything else. */
    readonly state?: WorktreeState | null;
    /** A worktree git lists for one of the workspace's repos but that sits outside the workspace (rel is then its absolute path). */
    readonly external?: boolean;
    /** The newest file's modification time in it, ms; null when it holds no file. */
    readonly newest?: number | null;
    /** A worktree's repository, workspace-relative (`.` for the workspace itself) (Tynn #946). */
    readonly repo?: string;
    /** A worktree's branch; `null` when detached (then `head` says where). */
    readonly branch?: string | null;
    readonly head?: string | null;
}

/** A folder something live is working in (a terminal, a process, an agent), and who, in words (Tynn #946). */
export interface InUseFolder {
    readonly path: string;
    readonly by: string;
}

const BUILD_CACHES = ['.vite', '.turbo', '.parcel-cache', '.pytest_cache'];
const TEST_RESULTS = ['test-results', 'playwright-report', '.nyc_output'];

/** What an item IS, in words, for its row (Tynn #946: a worktree in repos/ read as a repository). */
export function itemKind(item: StorageItem): string {
    switch (item.category) {
        case 'repos': return 'Repository';
        case 'worktrees': {
            const of = item.repo ? `Worktree of ${item.repo}` : 'Worktree';
            if (item.branch) return `${of}, on ${item.branch}`;
            return item.head ? `${of}, detached at ${item.head.slice(0, 7)}` : of;
        }
        case 'ci-artifacts': {
            const name = item.rel.split('/').at(-1) ?? '';
            if (name === 'coverage') return 'Coverage';
            if (TEST_RESULTS.includes(name)) return 'Test results';
            if (BUILD_CACHES.includes(name)) return 'Build cache';
            if (name === 'ci-out' || name === 'smoke-out') return 'CI output';
            return 'Test queue result';
        }
        case 'chat-files': return 'Shared in chat';
        case 'dirty': return 'Dropped in .ai/_dirty';
        default: return 'In .trash';
    }
}

/** The Clean up confirmation's groups, in this order (Tynn #946). */
export const CLEANUP_GROUPS: readonly string[] = ['Worktrees', 'Coverage', 'Test results', 'CI output', 'Build caches', 'Test queue results'];
export function cleanupGroup(item: StorageItem): string {
    if (item.category === 'worktrees') return 'Worktrees';
    const kind = itemKind(item);
    return kind === 'Build cache' ? 'Build caches' : kind === 'Test queue result' ? 'Test queue results' : kind;
}

/** Each item once, by id: the list a window draws never shows one thing twice. */
export function uniqueItems(items: readonly StorageItem[]): StorageItem[] {
    const seen = new Set<string>();
    return items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

/**
 * A worktree, as the person should read it: dirty (uncommitted changes), unpushed (commits no remote has), clean and merged
 * (its HEAD is already in the repo's default or release line, so nothing is lost), clean and unmerged (pushed to a branch
 * of its own, not yet in the line).
 */
export type WorktreeState = 'merged' | 'unmerged' | 'dirty' | 'unpushed' | 'locked' | 'unknown';
export const WORKTREE_STATE_LABEL: Readonly<Record<WorktreeState, string>> = {
    merged: 'Clean, merged', unmerged: 'Clean, not merged yet', dirty: 'Uncommitted changes', unpushed: 'Unpushed commits', locked: 'Locked', unknown: 'Unknown',
};

/**
 * The branches a worktree must be in to count as MERGED: the repo's default (main, master, develop, trunk), a release/*, and
 * a release line next/<name>. A story branch is next/<number>-<name>, so a name that starts with a digit is NOT a line: a
 * branch pushed on its own contains its own HEAD and must not read as merged.
 */
export function isLineBranch(name: string): boolean {
    if (['main', 'master', 'develop', 'trunk'].includes(name)) return true;
    if (/^releases?\/.+/.test(name)) return true;
    return /^next\/[^0-9/][^/]*$/.test(name);
}

/** From git for-each-ref --contains HEAD refs/remotes: whether any remote branch that has this commit is a line branch. */
export function mergedIntoLine(remoteRefs: readonly string[]): boolean {
    return remoteRefs.some((ref) => {
        const m = /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref.trim());
        return m !== null && m[1] !== 'HEAD' && isLineBranch(m[1]!);
    });
}

export function worktreeState(w: { locked: boolean; dirty: boolean; unpushed: number | null; merged: boolean }): WorktreeState {
    if (w.dirty) return 'dirty';
    if (w.unpushed === null) return 'unknown';
    if (w.unpushed > 0) return 'unpushed';
    if (w.locked) return 'locked';
    return w.merged ? 'merged' : 'unmerged';
}

/**
 * THE ONE-CLICK CLEAN-UP: which items to preselect. Only what is safe and what regenerates: a worktree that is clean AND
 * merged into the line and quiet for an hour (an agent may be working in it), and CI/test artifacts untouched for a day. Never an unmerged worktree, never a chat file,
 * never a file in .ai/_dirty (the person's, however old), never a repository, never anything that has a refusal.
 */
export function suggestedCleanup(items: readonly StorageItem[], now: number): string[] {
    return items.filter((i) => i.reclaimable && i.refusal === null && (
        (i.category === 'worktrees' && i.state === 'merged' && (typeof i.newest !== 'number' || now - i.newest > QUIET_WORKTREE_MS))
        || (i.category === 'ci-artifacts' && typeof i.newest === 'number' && now - i.newest > STALE_ARTIFACT_MS)
    )).map((i) => i.id);
}

/** Where something in .trash came from, so it can be put back. */
export type TrashOrigin =
    | { readonly kind: 'path'; readonly category: StorageCategory; readonly rel: string }
    /** `rel` is workspace-relative, or absolute for a worktree outside the workspace (`external`); `head` is its commit, to find it again. */
    /**
     * `pruned` (Tynn #947): the folder was moved and git told to forget it, so no pointer is left into .trash; Restore
     * registers it again. Without it, an entry from before: moved and locked by git, still registered.
     */
    | { readonly kind: 'worktree'; readonly repoRel: string; readonly rel: string; readonly branch: string | null; readonly head?: string | null; readonly external?: boolean; readonly pruned?: boolean }
    | { readonly kind: 'chat-file'; readonly agentId: string; readonly attachmentId: string; readonly path: string }
    /** Items cleared off the workspace's ArtBoard (genie#847): their index records and files; restore puts them back on the board. */
    | { readonly kind: 'artboard'; readonly ids: readonly string[]; readonly label: string }
    /** Put in .trash by someone other than Genie: listed and emptied with the rest, never restored. */
    | { readonly kind: 'unknown'; readonly name: string };

export interface TrashEntry {
    /** The entry's name in .trash. */
    readonly id: string;
    readonly origin: TrashOrigin;
    readonly movedAt: number | null;
    readonly bytes: number;
}

export interface StorageReport {
    readonly measuredAt: number;
    readonly totals: Readonly<Record<StorageCategory, number>>;
    readonly reclaimableBytes: number;
    readonly items: readonly StorageItem[];
    readonly trash: readonly TrashEntry[];
    /** Some walk stopped at its bound: the totals are at least these. */
    readonly truncated: boolean;
}

/** One workspace's Storage tab, as main holds it. */
export interface StorageView {
    readonly measuring: boolean;
    readonly report: StorageReport | null;
    /** Why the last measure failed, in words. */
    readonly error: string | null;
    /** What the last Move, Restore or Empty did, in words. */
    readonly outcome: string | null;
    /** The Move or Empty the host is doing now (Tynn #947): how far it is; absent or null when nothing runs. */
    readonly progress?: StorageProgress | null;
    /** Each item the last Move or Empty did not move or delete, with the reason in words (Tynn #947). */
    readonly failures?: readonly StorageFailure[];
}

export interface StorageProgress {
    readonly action: 'move' | 'empty';
    readonly done: number;
    readonly total: number;
    /** Bytes moved or deleted so far. */
    readonly bytes: number;
    /** The item being worked on now, by its label. */
    readonly current: string | null;
}

export interface StorageFailure {
    readonly label: string;
    readonly reason: string;
}

/** The person's approval to empty the trash: exactly these entries, this many bytes. */
export interface TrashApproval {
    readonly ids: readonly string[];
    readonly bytes: number;
}

export function approvalFor(trash: readonly TrashEntry[]): TrashApproval {
    return { ids: trash.map((t) => t.id).sort(), bytes: trash.reduce((n, t) => n + t.bytes, 0) };
}

/** Whether an approval names exactly what the trash holds now: the same entries and the same total. */
export function approvalMatches(trash: readonly TrashEntry[], approval: TrashApproval | null | undefined): boolean {
    if (!approval || !Array.isArray(approval.ids) || typeof approval.bytes !== 'number') return false;
    const now = approvalFor(trash);
    const ids = [...approval.ids].sort();
    return now.bytes === approval.bytes && now.ids.length === ids.length && now.ids.every((id, i) => id === ids[i]);
}

export interface WorktreeInfo {
    readonly path: string;
    readonly head: string | null;
    readonly branch: string | null;
    readonly bare: boolean;
    readonly locked: boolean;
    readonly prunable: boolean;
}

/** `git worktree list --porcelain`: blocks separated by a blank line; the main checkout first. */
export function parseWorktreeList(porcelain: string): WorktreeInfo[] {
    const out: WorktreeInfo[] = [];
    for (const block of porcelain.split(/\r?\n\r?\n/)) {
        const lines = block.split(/\r?\n/).filter((l) => l !== '');
        const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
        if (!path) continue;
        const head = lines.find((l) => l.startsWith('HEAD '))?.slice('HEAD '.length) ?? null;
        const ref = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length) ?? null;
        out.push({
            path,
            head,
            branch: ref ? ref.replace(/^refs\/heads\//, '') : null,
            bare: lines.includes('bare'),
            locked: lines.some((l) => l === 'locked' || l.startsWith('locked ')),
            prunable: lines.some((l) => l === 'prunable' || l.startsWith('prunable ')),
        });
    }
    return out;
}

/** Why a worktree may not go to .trash, in words; `null` = it may. */
export function worktreeRefusal(w: { locked: boolean; dirty: boolean; unpushed: number | null }): string | null {
    if (w.locked) return 'It is locked: git keeps it on purpose.';
    if (w.dirty) return 'It has uncommitted changes.';
    if (w.unpushed === null) return 'Genie could not tell whether its commits are pushed.';
    if (w.unpushed > 0) return `It has ${w.unpushed} commit${w.unpushed === 1 ? '' : 's'} no remote has.`;
    return null;
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes / 1024;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
    return `${v.toFixed(1)} ${units[u]}`;
}

/** Where a trash entry came from, in words. */
export function originLabel(o: TrashOrigin): string {
    switch (o.kind) {
        case 'path': return o.rel;
        case 'worktree': return o.branch ? `${o.rel} (worktree, ${o.branch})` : `${o.rel} (worktree)`;
        case 'chat-file': return `chat: ${o.agentId}, ${o.attachmentId}`;
        case 'artboard': return `ArtBoard: ${o.label}`;
        default: return o.name;
    }
}
