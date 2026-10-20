/**
 * THE TREE'S FILE OPERATIONS (Tynn #844; Genie 1's FileTree menu) — the pure half: where a new file goes, what a name may
 * be, the `-copy` name a duplicate takes, how open tabs follow a rename or a delete, and what each dialog says. The host
 * does the disk work (`main/files-host.ts`); the panel draws the dialog (`FileOpModal`).
 */

export type FileOpAction = 'new-file' | 'new-folder' | 'rename' | 'duplicate' | 'delete';
export type FileOpNode = { readonly path: string; readonly type: 'file' | 'folder' | 'root' };

const parentOf = (path: string): string => { const i = path.lastIndexOf('/'); return i === -1 ? '' : path.slice(0, i); };
const leafOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
export const joinRel = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/** The folder a New file / New folder lands in: inside a folder, beside a file, the root from empty space (Genie 1). */
export function createIn(path: string, target: 'tree-file' | 'tree-folder' | 'tree-root'): string {
    if (target === 'tree-root') return '';
    return target === 'tree-folder' ? path : parentOf(path);
}

/** Why a typed name cannot be used, or `null`: one name, never a path. */
export function nameProblem(name: string): string | null {
    const n = name.trim();
    if (n === '') return 'Give it a name';
    if (/[\\/]/.test(n)) return 'A name cannot contain / or \\';
    if (n === '.' || n === '..') return `“${n}” is not a name`;
    return null;
}

/** `foo.txt` → `foo-copy.txt`, `foo-copy-2.txt`…; `Makefile` → `Makefile-copy`; a dotfile keeps its name whole. */
export function copyName(name: string, n: number): string {
    const dot = name.lastIndexOf('.');
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    return `${base}${n > 1 ? `-copy-${n}` : '-copy'}${ext}`;
}

const under = (path: string, node: string): boolean => path === node || path.startsWith(`${node}/`);

/** Open tabs after `from` became `to`: the file itself, or everything under a renamed folder. */
export function tabsAfterRename(tabs: readonly string[], from: string, to: string): string[] {
    return tabs.map((t) => (under(t, from) ? to + t.slice(from.length) : t));
}

/** Open tabs after `path` went to the trash: the file itself, or everything under a folder, closed. */
export function tabsAfterDelete(tabs: readonly string[], path: string): string[] {
    return tabs.filter((t) => !under(t, path));
}

/** What a dialog says. `input` is the name field's starting text, or `null` for a dialog with no field (Delete). */
export interface FileOpDialog {
    readonly action: FileOpAction;
    readonly node: FileOpNode;
    readonly title: string;
    readonly confirmLabel: string;
    readonly input: string | null;
    readonly body?: string;
}

export function fileOpDialog(action: FileOpAction, node: FileOpNode): FileOpDialog {
    const name = leafOf(node.path);
    const where = node.path === '' ? 'the workspace' : node.path;
    switch (action) {
        case 'new-file': return { action, node, title: `New file in ${where}`, confirmLabel: 'Create', input: '' };
        case 'new-folder': return { action, node, title: `New folder in ${where}`, confirmLabel: 'Create', input: '' };
        case 'rename': return { action, node, title: `Rename ${name}`, confirmLabel: 'Rename', input: name };
        case 'duplicate': return { action, node, title: `Duplicate ${name}`, confirmLabel: 'Duplicate', input: null };
        case 'delete': return {
            action, node, title: `Delete ${name}`, confirmLabel: 'Move to trash', input: null,
            body: node.type === 'folder' ? `${name} and everything in it go to the trash.` : `${name} goes to the trash.`,
        };
    }
}

/** The workspace-relative path an operation targets from a dialog's typed name. */
export function targetOf(dialog: FileOpDialog, typed: string): string {
    const name = typed.trim();
    if (dialog.action === 'rename') return joinRel(parentOf(dialog.node.path), name);
    return joinRel(dialog.node.path, name);
}
