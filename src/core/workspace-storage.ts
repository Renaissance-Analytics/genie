/**
 * A WORKSPACE'S DISK, BY CATEGORY (Tynn #697). The owner: "genie needs to track disk usage by workspace including trash
 * files like worktrees, ci artifacts and files shared in chat and provide a clean way to empty those into the .trash and
 * also an ability to purge that trash folder with user approval."
 *
 * The pure half: what the categories are, which folder names are CI/test artifacts, how `git worktree list --porcelain`
 * reads, and what an approval to empty the trash is (exactly the entries shown, and their total). The host half, which
 * walks the disk and moves things, is main/workspace-storage-host.ts.
 */

export type StorageCategory = 'repos' | 'worktrees' | 'ci-artifacts' | 'chat-files' | 'trash';
export const STORAGE_CATEGORIES: readonly StorageCategory[] = ['repos', 'worktrees', 'ci-artifacts', 'chat-files', 'trash'];
export const CATEGORY_LABEL: Readonly<Record<StorageCategory, string>> = {
    repos: 'Repositories', worktrees: 'Worktrees', 'ci-artifacts': 'CI and test artifacts', 'chat-files': 'Files shared in chat', trash: '.trash',
};

/**
 * CI and test output folders, by name: what Genie's own jobs and the common runners leave behind (`ci-out` and `smoke-out`
 * are the Azure queue's fetch folders; `coverage`, `.nyc_output`, `test-results` and `playwright-report` the runners').
 * A folder is an artifact by its NAME and nothing else: source, `dist`, `node_modules` never are.
 */
export const ARTIFACT_NAMES: readonly string[] = ['ci-out', 'smoke-out', 'coverage', '.nyc_output', 'test-results', 'playwright-report'];
export const isArtifactName = (name: string): boolean => ARTIFACT_NAMES.includes(name);
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
}

/** Where something in .trash came from, so it can be put back. */
export type TrashOrigin =
    | { readonly kind: 'path'; readonly category: StorageCategory; readonly rel: string }
    | { readonly kind: 'worktree'; readonly repoRel: string; readonly rel: string; readonly branch: string | null }
    | { readonly kind: 'chat-file'; readonly agentId: string; readonly attachmentId: string; readonly path: string }
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
        default: return o.name;
    }
}
