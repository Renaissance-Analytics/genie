import type { FileOpAction } from './file-ops.js';

/**
 * RIGHT-CLICK A FILE (Tynn #841; the owner, 2026-10-20: "I should be able to right click and choose open in external
 * editor"). What a tree row and an editor tab offer, pure: the panel draws it, the container acts on it.
 *
 * Open in external editor and Reveal act on the HOST's screen (the OS's own app for the file, its file manager), so they
 * are offered only where this window is the host; copy and close work anywhere.
 */

export type FileMenuTarget = 'tree-file' | 'tree-folder' | 'tree-root' | 'tab';
export type FileMenuAction = 'open-external' | 'reveal' | 'export' | 'copy-path' | 'copy-relative-path' | 'close' | 'close-others' | 'close-all' | 'lock-folder' | 'unlock' | FileOpAction;
export type FileMenuItem = { readonly id: FileMenuAction; readonly label: string } | { readonly id: '-'; readonly label: '' };

const LABELS: Readonly<Record<FileMenuAction, string>> = {
    'open-external': 'Open in external editor',
    reveal: 'Reveal in file manager',
    export: 'Export…',
    'copy-path': 'Copy path',
    'copy-relative-path': 'Copy relative path',
    close: 'Close',
    'close-others': 'Close others',
    'close-all': 'Close all',
    'new-file': 'New file',
    'new-folder': 'New folder',
    rename: 'Rename',
    duplicate: 'Duplicate',
    delete: 'Delete',
    'lock-folder': 'Lock Files panel to this folder',
    unlock: 'Unlock Files panel',
};

const item = (id: FileMenuAction): FileMenuItem => ({ id, label: LABELS[id] });
const SEPARATOR: FileMenuItem = { id: '-', label: '' };

/**
 * `edit` (Tynn #844): the tree's file operations — New file / New folder (inside a folder, beside a file, at the root from
 * empty space), Rename, Duplicate (files only, as in Genie 1) and Delete (to the trash). Offered where the panel can do
 * them; a tab never offers them.
 */
/**
 * `lock` (beta.33 item 15; Genie 1 FileTreeContextMenu): a folder offers "Lock Files panel to this folder" — the tree is
 * rooted there — and while locked every tree row offers Unlock. Absent where the panel cannot be locked (a code pane).
 */
/**
 * `export` (genie#1264): Export… saves a FILE to a place on this machine through the OS save dialog — a tree file and an
 * editor tab, never a folder (Genie 1 exported nothing at all). Its own group: it neither acts on the host's screen nor
 * touches the clipboard.
 */
export function fileMenuItems(target: FileMenuTarget, available: { readonly external: boolean; readonly reveal: boolean; readonly export?: boolean; readonly edit?: boolean; readonly lock?: { readonly lockedRoot: string | null } }): FileMenuItem[] {
    const edit = available.edit === true && target !== 'tab';
    const lock: FileMenuItem[] = [];
    if (available.lock && target !== 'tab') {
        if (target === 'tree-folder') lock.push(item('lock-folder'));
        if (available.lock.lockedRoot !== null) lock.push(item('unlock'));
    }
    if (target === 'tree-root') {
        const root = edit ? [item('new-file'), item('new-folder')] : [];
        return lock.length === 0 ? root : root.length === 0 ? lock : [...root, SEPARATOR, ...lock];
    }
    const host: FileMenuItem[] = [];
    if (available.external && target !== 'tree-folder') host.push(item('open-external'));
    if (available.reveal) host.push(item('reveal'));
    const exporting: FileMenuItem[] = available.export === true && target !== 'tree-folder' ? [item('export')] : [];
    const groups: FileMenuItem[][] = [host, exporting, [item('copy-path'), item('copy-relative-path')]];
    if (edit) {
        groups.unshift([item('new-file'), item('new-folder')]);
        groups.push(target === 'tree-file' ? [item('rename'), item('duplicate'), item('delete')] : [item('rename'), item('delete')]);
    }
    if (lock.length > 0) groups.push(lock);
    if (target === 'tab') groups.push([item('close'), item('close-others'), item('close-all')]);
    return groups.filter((g) => g.length > 0).flatMap((g, i) => (i === 0 ? g : [SEPARATOR, ...g]));
}
