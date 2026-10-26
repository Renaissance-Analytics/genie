import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * A FILE ADDED TO A WORKSPACE STARTS A FLOW (genie#1204 item 5) — Genie 1's `files:added` trigger
 * (main/flows/file-source.ts), with the decisions kept pure here: what an addition is, which paths are never watched,
 * which trigger an addition matches, where a move lands, and which flows are refused.
 *
 * The owner's reference case: "a file added anywhere in a workspace, and if it is over 5 MB it gets moved into an
 * untracked folder so the repo does not get heavy" — a `genie/file_added` trigger with `minSizeBytes`, then a
 * `genie/file_move` step to `.untracked`.
 *
 * ## What "added" means
 *
 * `fs.watch` reports `rename` when a path appears, vanishes or is renamed, and `change` when content is written. An
 * addition is `rename` AND the path now existing as a file — one stat, no baseline of the tree. An editor that saves
 * by writing a temp file and renaming it over the original reads as an addition; the bytes at that path ARE new.
 *
 * ## A file name never reaches a shell
 *
 * A name can be `$(curl …).png` or `a; rm -rf ~`. A `genie/terminal_run` step that templates a value, in a flow a file
 * starts, is refused (`shellTemplatesInFileFlow`): the move is `genie/file_move`, which takes no shell.
 */

export const FILE_ADDED_KIND = 'genie/file_added';
export const FILE_MOVE_KIND = 'genie/file_move';

/** What a `genie/file_added` trigger hands the steps after it (`{{in.path}}`, `{{in.sizeBytes}}`, …). */
export interface FileAddedProps {
    readonly workspaceId: string;
    /** Absolute, platform-native. */
    readonly path: string;
    /** Forward-slashed, relative to the workspace root. */
    readonly relPath: string;
    readonly name: string;
    /** Lower-case, without the dot; empty when there is none. */
    readonly extension: string;
    readonly sizeBytes: number;
}

export interface FileWatchObservation {
    readonly workspaceId: string;
    readonly workspacePath: string;
    /** Forward-slashed, workspace-relative. */
    readonly relPath: string;
    readonly eventType: 'rename' | 'change';
    /** The path as it is NOW; `null` when it does not exist. */
    readonly stat: { readonly isFile: boolean; readonly size: number } | null;
}

/** The addition this observation is, or `null` — a content change, a delete or a directory is not one. */
export function fileAddedEvent(input: FileWatchObservation): FileAddedProps | null {
    if (input.eventType !== 'rename') return null;
    if (!input.stat || !input.stat.isFile) return null;
    const name = input.relPath.split('/').pop() ?? input.relPath;
    const dot = name.lastIndexOf('.');
    // A leading dot is not an extension: `.gitignore` has none.
    const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    return { workspaceId: input.workspaceId, path: join(input.workspacePath, input.relPath), relPath: input.relPath, name, extension, sizeBytes: input.stat.size };
}

/** Folders whose churn is never a person adding a file: version control and installed dependencies, at any depth. */
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', 'vendor']);

export function ignoredPath(relPath: string): boolean {
    return relPath.split(/[\\/]/).some((segment) => IGNORED_SEGMENTS.has(segment));
}

/** A `genie/file_added` node's config, as the document holds it. */
export interface FileTriggerConfig {
    readonly workspace: string;
    /** Relative to the workspace; empty = anywhere in it. */
    readonly folder?: string | undefined;
    /** Comma-separated; case and a leading dot ignored; empty = any. */
    readonly extensions?: string | undefined;
    /** Inclusive. */
    readonly minSizeBytes?: number | undefined;
}

/** Forward-slashed, no leading `./` or `/`, no trailing `/`. */
function normalFolder(folder: string): string {
    return folder.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

export function matchesFileTrigger(config: FileTriggerConfig, event: FileAddedProps): boolean {
    if (config.workspace !== event.workspaceId) return false;
    const folder = normalFolder(config.folder ?? '');
    if (folder !== '' && !event.relPath.startsWith(`${folder}/`)) return false;
    const extensions = (config.extensions ?? '').split(',').map((e) => e.trim().replace(/^\./, '').toLowerCase()).filter((e) => e !== '');
    if (extensions.length > 0 && !extensions.includes(event.extension)) return false;
    if (typeof config.minSizeBytes === 'number' && Number.isFinite(config.minSizeBytes) && event.sizeBytes < config.minSizeBytes) return false;
    return true;
}

/** `child` is `root` or inside it. */
function inside(root: string, child: string): boolean {
    const rel = relative(root, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export type FileMovePlan = { ok: true; dest: string | null } | { ok: false; reason: string };

/**
 * Where `from` lands when moved into `toFolder` (relative to the workspace `root`): both inside the workspace, the
 * name kept, never overwriting (`name (2).ext`, `name (3).ext`, …). A file already in that folder is left where it is
 * (`dest: null`) — the move's own arrival is an addition too, and must not move it again.
 */
export function planFileMove(root: string, from: string, toFolder: string, exists: (path: string) => boolean): FileMovePlan {
    const source = resolve(root, from);
    if (!inside(root, source) || source === resolve(root)) return { ok: false, reason: `${from} is outside the workspace ${root}; nothing was moved` };
    const folder = resolve(root, toFolder);
    if (!inside(root, folder)) return { ok: false, reason: `the folder ${toFolder} is outside the workspace ${root}; nothing was moved` };
    if (dirname(source) === folder) return { ok: true, dest: null };
    const ext = extname(source);
    const stem = basename(source, ext);
    let dest = join(folder, `${stem}${ext}`);
    for (let n = 2; exists(dest); n++) dest = join(folder, `${stem} (${n})${ext}`);
    return { ok: true, dest };
}

/** The `genie/terminal_run` steps that template a value, in a flow a file starts — each one is refused. */
export function shellTemplatesInFileFlow(graph: { readonly nodes: readonly { readonly id: string; readonly kind: string; readonly config?: Record<string, unknown> | undefined }[] }): string[] {
    if (!graph.nodes.some((n) => n.kind === FILE_ADDED_KIND)) return [];
    return graph.nodes
        .filter((n) => n.kind === 'genie/terminal_run')
        .filter((n) => ['command', 'cwd'].some((key) => typeof n.config?.[key] === 'string' && /\{\{[^}]*\}\}/.test(n.config[key] as string)))
        .map((n) => n.id);
}
