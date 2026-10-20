/**
 * RIGHT-CLICK A FILE (Tynn #841; the owner, 2026-10-20: "I should be able to right click and choose open in external
 * editor"). What a tree row and an editor tab offer, pure: the panel draws it, the container acts on it.
 *
 * Open in external editor and Reveal act on the HOST's screen (the OS's own app for the file, its file manager), so they
 * are offered only where this window is the host; copy and close work anywhere.
 */

export type FileMenuTarget = 'tree-file' | 'tree-folder' | 'tab';
export type FileMenuAction = 'open-external' | 'reveal' | 'copy-path' | 'copy-relative-path' | 'close' | 'close-others' | 'close-all';
export type FileMenuItem = { readonly id: FileMenuAction; readonly label: string } | { readonly id: '-'; readonly label: '' };

const LABELS: Readonly<Record<FileMenuAction, string>> = {
    'open-external': 'Open in external editor',
    reveal: 'Reveal in file manager',
    'copy-path': 'Copy path',
    'copy-relative-path': 'Copy relative path',
    close: 'Close',
    'close-others': 'Close others',
    'close-all': 'Close all',
};

const item = (id: FileMenuAction): FileMenuItem => ({ id, label: LABELS[id] });
const SEPARATOR: FileMenuItem = { id: '-', label: '' };

export function fileMenuItems(target: FileMenuTarget, available: { readonly external: boolean; readonly reveal: boolean }): FileMenuItem[] {
    const host: FileMenuItem[] = [];
    if (available.external && target !== 'tree-folder') host.push(item('open-external'));
    if (available.reveal) host.push(item('reveal'));
    const groups: FileMenuItem[][] = [host, [item('copy-path'), item('copy-relative-path')]];
    if (target === 'tab') groups.push([item('close'), item('close-others'), item('close-all')]);
    return groups.filter((g) => g.length > 0).flatMap((g, i) => (i === 0 ? g : [SEPARATOR, ...g]));
}
