import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import { TreeNav } from '@particle-academy/react-fancy';
import FileTreeContextMenu from './FileTreeContextMenu';
import { showPrompt } from '../Master/Prompt';
import { api, type GitStatusMap, type TreeNodeData } from '../../lib/genie';

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
    /** Lock the Editor's tree root to this folder (persisted by the panel). */
    onLockToFolder: (node: TreeNodeData) => void;
    /** Clear the Editor lock. */
    onUnlock: () => void;
    /** Whether the Editor is currently locked + to which folder ('' = workspace root). */
    locked: boolean;
    lockedRoot: string;
    /**
     * Workspace-relative paths of open tabs with UNSAVED edits. Each such node
     * gets a `*` marker. Owned by the panel (survives tree hide/show) and
     * cleared per-file on save.
     */
    dirtyPaths?: Set<string>;
    /**
     * Ids of the expanded folders. Controlled by the panel so expansion
     * survives the tree being hidden/shown and persists across restarts.
     */
    expandedIds: string[];
    /** Called whenever the expanded-folder set changes (panel persists it). */
    onExpandedChange: (ids: string[]) => void;
    /**
     * Bumped by the panel after a save so the tree refetches git status (the
     * file just changed on disk, so its colour should update).
     */
    gitRefreshKey?: number;
}

/** Per-status colour for a file node label (VS Code-ish palette). */
const STATUS_COLOR: Record<string, string> = {
    untracked: '#73c991', // green
    added: '#73c991', // green (staged)
    modified: '#e2c08d', // amber
    deleted: '#f48771', // red
    renamed: '#e2c08d', // amber-ish (a rename is a change)
    ignored: '#6b6b6b', // dim grey
};

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
    onLockToFolder,
    onUnlock,
    locked,
    lockedRoot,
    dirtyPaths,
    expandedIds,
    onExpandedChange,
    gitRefreshKey,
}: Props) {
    const [menu, setMenu] = useState<MenuState | null>(null);
    const [gitMap, setGitMap] = useState<GitStatusMap>({});

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

    // id → ORIGINAL (undecorated) node, so context-menu handlers always see a
    // plain string label (decoration replaces label with a ReactNode for
    // colouring, which must never reach rename/header logic).
    const byId = useMemo(() => {
        const m = new Map<string, TreeNodeData>();
        const walk = (ns: TreeNodeData[]) => {
            for (const n of ns) {
                m.set(n.id, n);
                if (n.children) walk(n.children);
            }
        };
        walk(nodes);
        return m;
    }, [nodes]);

    // Fetch git status on mount, whenever the tree shape changes, and after a
    // save (gitRefreshKey bumps). One cheap git call; never throws (main
    // returns {} for a non-repo). The map keys are workspace-relative paths.
    const refreshGit = useCallback(() => {
        let alive = true;
        api()
            .files.gitStatus(workspacePath)
            .then((m) => {
                if (alive) setGitMap(m);
            })
            .catch(() => {
                if (alive) setGitMap({});
            });
        return () => {
            alive = false;
        };
    }, [workspacePath]);

    useEffect(() => {
        const cancel = refreshGit();
        return cancel;
        // nodes in deps: refetch after any tree mutation reshapes it.
        // gitRefreshKey in deps: refetch after a save.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refreshGit, nodes, gitRefreshKey]);

    /**
     * Decorate the raw tree with git-status colour + a dirty `*` marker.
     *
     * react-fancy's `TreeNav` has no per-node `className`/`color`/`style`
     * field and no `renderLabel`/`renderNode` prop (checked the dist d.ts +
     * the bundle: the node label is rendered as `children: node.label`). The
     * one supported per-node hook is that label is rendered as React
     * *children*, so a ReactNode label renders fine even though the type says
     * `string`. We use that: each file node's `label` becomes a coloured
     * `<span>` carrying the status colour and the dirty `*`. Folders keep
     * their plain string label. The cast to `string` keeps the typed
     * `TreeNodeData` contract while passing a node that React renders.
     */
    const decorated = useMemo(() => {
        const decorate = (ns: TreeNodeData[]): TreeNodeData[] =>
            ns.map((n) => {
                if (n.type === 'folder') {
                    return n.children
                        ? { ...n, children: decorate(n.children) }
                        : n;
                }
                const status = gitMap[n.id];
                const isDirty = !!dirtyPaths && dirtyPaths.has(n.id);
                if (!status && !isDirty) return n;
                const color = status ? STATUS_COLOR[status] : undefined;
                const strike = status === 'deleted';
                const labelNode = (
                    <span
                        style={{
                            color,
                            textDecoration: strike ? 'line-through' : undefined,
                        }}
                        title={status ?? undefined}
                    >
                        {n.label}
                        {isDirty && (
                            <span className="tree-dirty-mark" aria-hidden>
                                {' '}
                                *
                            </span>
                        )}
                    </span>
                );
                // CRITICAL: once we replace the string label with a ReactNode,
                // react-fancy's TreeNav can no longer derive a file's extension
                // from `node.label.split('.')` — it throws "split is not a
                // function" on the ReactNode and the crash bubbles to the app
                // root. Pin `ext` from the original string label so TreeNav uses
                // it (for the FileIcon) and never splits the decorated label.
                const ext =
                    n.ext ??
                    (typeof n.label === 'string'
                        ? (n.label.split('.').pop() ?? '').toLowerCase()
                        : undefined);
                return { ...n, ext, label: labelNode as unknown as string };
            });
        return decorate(nodes);
    }, [nodes, gitMap, dirtyPaths]);

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
            if (dir && !expandedIds.includes(dir))
                onExpandedChange([...expandedIds, dir]);
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
            if (!expandedIds.includes(rel)) onExpandedChange([...expandedIds, rel]);
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

    /** The destination FOLDER for a drop: inside a folder target, else the
     *  target's parent folder ('' = workspace root). */
    const dropFolder = (
        targetId: string,
        position: 'before' | 'after' | 'inside',
    ): string => {
        const t = byId.get(targetId);
        return t?.type === 'folder' && position === 'inside'
            ? targetId
            : parentOf(targetId);
    };

    // Internal drag → MOVE (with confirm). A move IS a rename into a new folder,
    // so it routes through the path-guarded rename IPC.
    const handleNodeMove = async (
        sourceId: string,
        targetId: string,
        position: 'before' | 'after' | 'inside',
    ) => {
        const leaf = sourceId.split('/').pop() ?? sourceId;
        const destFolder = dropFolder(targetId, position);
        const newRel = joinRel(destFolder, leaf);
        if (newRel === sourceId) return; // dropped in the same folder — no-op
        if (`${newRel}/`.startsWith(`${sourceId}/`)) {
            await showPrompt({
                title: "Can't move there",
                body: 'A folder cannot be moved inside itself.',
                confirmLabel: 'OK',
            });
            return;
        }
        const ok = await showPrompt({
            title: 'Move',
            body: `Move "${leaf}" into ${destFolder ? `"${destFolder}"` : 'the workspace root'}?`,
            confirmLabel: 'Move',
        });
        if (ok === null) return;
        try {
            await api().files.rename(workspacePath, sourceId, newRel);
            if (destFolder && !expandedIds.includes(destFolder)) {
                onExpandedChange([...expandedIds, destFolder]);
            }
            await onTreeChanged();
            if (sourceId === selectedId) onOpenCreatedFile(newRel);
        } catch (e) {
            await showPrompt({
                title: 'Could not move',
                body: e instanceof Error ? e.message : String(e),
                confirmLabel: 'OK',
            });
        }
    };

    // External drag (Windows Explorer / Finder) → COPY the dropped OS files into
    // the folder. Copy is non-destructive, so no confirm; a name collision gets a
    // `-copy` sibling (no clobber). The destination is path-guarded in main.
    const handleExternalDrop = async (
        event: DragEvent,
        target: TreeNodeData,
        position: 'before' | 'after' | 'inside',
    ) => {
        const osFiles = Array.from(event.dataTransfer?.files ?? []);
        if (osFiles.length === 0) return; // a cross-component drag, not OS files
        const destFolder = dropFolder(target.id, position);
        const errors: string[] = [];
        for (const file of osFiles) {
            try {
                const srcAbs = api().files.pathForFile(file);
                if (!srcAbs) continue;
                await api().files.importExternal(workspacePath, srcAbs, destFolder);
            } catch (e) {
                errors.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        if (destFolder && !expandedIds.includes(destFolder)) {
            onExpandedChange([...expandedIds, destFolder]);
        }
        await onTreeChanged();
        if (errors.length) {
            await showPrompt({
                title: 'Some files could not be copied',
                body: errors.join('\n'),
                confirmLabel: 'OK',
            });
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
                nodes={decorated}
                selectedId={selectedId}
                expandedIds={expandedIds}
                onExpandedChange={onExpandedChange}
                onSelect={(id) => {
                    if (folderIds.has(id)) return; // folder → expand/collapse only
                    onSelectFile(id);
                }}
                onNodeContextMenu={(e, node) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // Resolve back to the original (string-label) node — the
                    // decorated node TreeNav hands us carries a ReactNode label.
                    setMenu({
                        x: e.clientX,
                        y: e.clientY,
                        node: byId.get(node.id) ?? node,
                    });
                }}
            />
            {menu && (
                <FileTreeContextMenu
                    position={{ x: menu.x, y: menu.y }}
                    node={menu.node}
                    locked={locked}
                    lockedRoot={lockedRoot}
                    onClose={() => setMenu(null)}
                    onNewFile={() => void handleNewFile(menu.node)}
                    onNewFolder={() => void handleNewFolder(menu.node)}
                    onRename={() => menu.node && void handleRename(menu.node)}
                    onDuplicate={() => menu.node && void handleDuplicate(menu.node)}
                    onDelete={() => menu.node && void handleDelete(menu.node)}
                    onCopyPath={() => menu.node && void handleCopyPath(menu.node)}
                    onLockToFolder={(n) => onLockToFolder(n)}
                    onUnlock={onUnlock}
                />
            )}
        </div>
    );
}
