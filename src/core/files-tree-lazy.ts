import type { TreeNode } from './files-panel.js';

/**
 * THE FILE TREE, LOADED A FOLDER AT A TIME (the owner, 2026-10-19: "I can't load files below the 3rd layer and when it
 * opens all folders are open at once. it should not be like that at all").
 *
 * The tree used to be ONE eager walk with an entry budget (Genie 1's 5,000 / depth 6): on a big workspace the budget ran
 * out a few levels down and the deeper folders were never listed, and Fancy's TreeNav was told to expand everything.
 * Now the host lists one folder's direct children when it is opened (FilesHost.children), and these are the panel's
 * rules over what it has loaded:
 *
 *  - `treeFromLoaded`: the nodes TreeNav draws. A folder that has been opened carries its children; one that has not
 *    is a folder with none yet — TreeNav still shows it as a folder, and opening it is what loads it.
 *  - `revealFor`: the folders to have open so a file is visible — its ancestors, added to what is already open. A file
 *    named by the route (a chat link, a terminal path, a refresh) is shown in its place, with its folders opened.
 */

/** What has been loaded: a folder's path (`''` = the workspace root) → its direct children. */
export type LoadedFolders = ReadonlyMap<string, readonly TreeNode[]>;

export function treeFromLoaded(loaded: LoadedFolders): TreeNode[] | null {
    const root = loaded.get('');
    if (!root) return null;
    const nest = (nodes: readonly TreeNode[]): TreeNode[] =>
        nodes.map((node) => {
            if (node.type !== 'folder') return node;
            const kids = loaded.get(node.id);
            return kids ? { id: node.id, label: node.label, type: 'folder', children: nest(kids) } : { id: node.id, label: node.label, type: 'folder' };
        });
    return nest(root);
}

/** The folders a file sits in, outermost first: `a/b/x.ts` → `a`, `a/b`. */
export function ancestorsOf(path: string): string[] {
    const parts = path.split('/').filter(Boolean);
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

export function revealFor(path: string | null, expanded: readonly string[]): string[] {
    if (path === null) return [...expanded];
    const out = [...expanded];
    for (const folder of ancestorsOf(path)) if (!out.includes(folder)) out.push(folder);
    return out;
}
