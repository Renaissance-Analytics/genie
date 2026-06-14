import { useMemo, useState } from 'react';
import { TreeNav } from '@particle-academy/react-fancy';
import FileTreeContextMenu from './FileTreeContextMenu';
import { showPrompt } from '../Master/Prompt';
import { api, type TreeNodeData } from '../../lib/genie';

interface Props {
    nodes: TreeNodeData[];
    /** Workspace-relative path of the open file (the TreeNav selectedId). */
    selectedId?: string;
    /** Workspace root — every file op is path-guarded to it in main. */
    workspacePath: string;
    /** Fires only for file (leaf) selections — folders just expand/collapse. */
    onSelectFile: (relPath: string) => void;
    /** Re-run after any mutating op so the tree reflects the new shape. */
    onTreeChanged: () => void | Promise<void>;
    /** Open a freshly-created file in the editor. */
    onOpenCreatedFile: (relPath: string) => void;
}

interface MenuState {
    x: number;
    y: number;
    /** The right-clicked node, or null for an empty-space click (tree root). */
    node: TreeNodeData | null;
}

/** Parent folder of a workspace-relative path ('' = root). */
function parentOf(rel: string): string {
    const i = rel.lastIndexOf('/');
    return i === -1 ? '' : rel.slice(0, i);
}

/** Join a folder (possibly '') with a leaf into a workspace-relative path. */
function joinRel(folder: string, leaf: string): string {
    return folder ? `${folder}/${leaf}` : leaf;
}

/**
 * Thin wrapper around react-fancy's `<TreeNav>`. Wires selection +
 * controlled expansion, filters folder clicks out of the file-open
 * callback, and adds a right-click context menu for file operations
 * (New File / New Folder / Rename / Delete / Copy relative path).
 *
 * All operations route through the path-guarded `files:*` IPC, so a
 * created/renamed/deleted target can never escape the workspace root.
 * Delete confirms via the in-app `showPrompt` modal — never a native
 * dialog or `window.confirm` (Electron disables those in the renderer).
 */
export default function FileTree({
    nodes,
    selectedId,
    workspacePath,
    onSelectFile,
    onTreeChanged,
    onOpenCreatedFile,
}: Props) {
    const [expanded, setExpanded] = useState<string[]>([]);
    const [menu, setMenu] = useState<MenuState | null>(null);

    // Set of folder ids so onSelect can distinguish a folder toggle from a
    // file open, and so the menu knows whether the target is a folder.
    const folderIds = useMemo(() => {
        const ids = new Set<string>();
        const walk = (ns: TreeNodeData[]) => {
            for (const n of ns) {
                if (n.type === 'folder') {
                    ids.add(n.id);
                    if (n.children) walk(n.children);
                }
            }
        };
        walk(nodes);
        return ids;
    }, [nodes]);

    /**
     * Resolve the folder a "create" op should target:
     *   - right-click a folder → create INSIDE it,
     *   - right-click a file    → create as its SIBLING,
     *   - empty space           → create at the tree root.
     */
    const createDir = (node: TreeNodeData | null): string => {
        if (!node) return '';
        if (node.type === 'folder') return node.id;
        return parentOf(node.id);
    };

    const handleNewFile = async (node: TreeNodeData | null) => {
        const dir = createDir(node);
        const name = await showPrompt({
            title: 'New file',
            label: 'File name',
            placeholder: 'index.ts',
            confirmLabel: 'Create',
        });
        if (!name) return;
        const rel = joinRel(dir, name.trim());
        try {
            await api().files.createFile(workspacePath, rel);
            if (dir && !expanded.includes(dir)) setExpanded((p) => [...p, dir]);
            await onTreeChanged();
            onOpenCreatedFile(rel);
        } catch (e) {
            await showPrompt({
                title: 'Could not create file',
                body: e instanceof Error ? e.message : String(e),
                confirmLabel: 'OK',
            });
        }
    };

    const handleNewFolder = async (node: TreeNodeData | null) => {
        const dir = createDir(node);
        const name = await showPrompt({
            title: 'New folder',
            label: 'Folder name',
            placeholder: 'components',
            confirmLabel: 'Create',
        });
        if (!name) return;
        const rel = joinRel(dir, name.trim());
        try {
            await api().files.createFolder(workspacePath, rel);
            setExpanded((p) => (p.includes(rel) ? p : [...p, rel]));
            await onTreeChanged();
        } catch (e) {
            await showPrompt({
                title: 'Could not create folder',
                body: e instanceof Error ? e.message : String(e),
                confirmLabel: 'OK',
            });
        }
    };

    const handleRename = async (node: TreeNodeData) => {
        const next = await showPrompt({
            title: `Rename ${node.type === 'folder' ? 'folder' : 'file'}`,
            label: 'New name',
            initial: node.label,
            confirmLabel: 'Rename',
        });
        const trimmed = next?.trim();
        if (!trimmed || trimmed === node.label) return;
        const toRel = joinRel(parentOf(node.id), trimmed);
        try {
            await api().files.rename(workspacePath, node.id, toRel);
            await onTreeChanged();
            // Re-open under the new path if the renamed node was the open file.
            if (node.type !== 'folder' && node.id === selectedId) {
                onOpenCreatedFile(toRel);
            }
        } catch (e) {
            await showPrompt({
                title: 'Could not rename',
                body: e instanceof Error ? e.message : String(e),
                confirmLabel: 'OK',
            });
        }
    };

    const handleDelete = async (node: TreeNodeData) => {
        const ok = await showPrompt({
            title: `Delete ${node.type === 'folder' ? 'folder' : 'file'}`,
            body:
                node.type === 'folder'
                    ? `Delete "${node.label}" and everything inside it? This cannot be undone.`
                    : `Delete "${node.label}"? This cannot be undone.`,
            confirmLabel: 'Delete',
            destructive: true,
        });
        if (ok === null) return;
        try {
            await api().files.delete(workspacePath, node.id);
            await onTreeChanged();
        } catch (e) {
            await showPrompt({
                title: 'Could not delete',
                body: e instanceof Error ? e.message : String(e),
                confirmLabel: 'OK',
            });
        }
    };

    const handleDuplicate = async (node: TreeNodeData) => {
        if (node.type === 'folder') return; // file-only op
        try {
            const { relPath } = await api().files.duplicate(workspacePath, node.id);
            await onTreeChanged();
            onOpenCreatedFile(relPath); // select + open the new copy
        } catch (e) {
            await showPrompt({
                title: 'Could not duplicate',
                body: e instanceof Error ? e.message : String(e),
                confirmLabel: 'OK',
            });
        }
    };

    const handleCopyPath = async (node: TreeNodeData) => {
        try {
            await navigator.clipboard.writeText(node.id);
        } catch {
            /* clipboard unavailable — silent */
        }
    };

    return (
        <div
            className="filetree-root"
            // Right-click on empty tree space → create-at-root menu.
            onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, node: null });
            }}
        >
            <TreeNav
                nodes={nodes}
                selectedId={selectedId}
                expandedIds={expanded}
                onExpandedChange={setExpanded}
                onSelect={(id) => {
                    if (folderIds.has(id)) return; // folder → expand/collapse only
                    onSelectFile(id);
                }}
                onNodeContextMenu={(e, node) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenu({ x: e.clientX, y: e.clientY, node });
                }}
            />
            {menu && (
                <FileTreeContextMenu
                    position={{ x: menu.x, y: menu.y }}
                    node={menu.node}
                    onClose={() => setMenu(null)}
                    onNewFile={() => void handleNewFile(menu.node)}
                    onNewFolder={() => void handleNewFolder(menu.node)}
                    onRename={() => menu.node && void handleRename(menu.node)}
                    onDuplicate={() => menu.node && void handleDuplicate(menu.node)}
                    onDelete={() => menu.node && void handleDelete(menu.node)}
                    onCopyPath={() => menu.node && void handleCopyPath(menu.node)}
                />
            )}
        </div>
    );
}
