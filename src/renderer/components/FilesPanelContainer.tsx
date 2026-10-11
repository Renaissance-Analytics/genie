import { useCallback, useEffect, useState } from 'react';
import type { TreeNode } from '../../core/files-panel.js';
import type { GenieBridge } from '../bridge.js';
import { FilesPanel, type FilesPanelState, type OpenFile } from './FilesPanel.js';

/**
 * The file panel's WIRING (§4.3): loads the tree and the attribution state from the bridge, re-reads
 * them when the host says the workspace changed (push, never a poll), keeps the open tabs. The pure
 * rendering is `FilesPanel`, which is what the tests render. One container per workspace surface.
 */
export function FilesPanelContainer({ workspace, files, pinned, onPin, onClose }: {
    workspace: { id: string; name?: string | undefined; path: string };
    files: GenieBridge['files'];
    pinned: boolean;
    onPin: () => void;
    onClose: () => void;
}) {
    const [tree, setTree] = useState<readonly TreeNode[] | null>(null);
    const [state, setState] = useState<FilesPanelState | null>(null);
    const [tabs, setTabs] = useState<readonly string[]>([]);
    const [open, setOpen] = useState<OpenFile | null>(null);

    const refresh = useCallback(() => {
        void files.tree(workspace.id).then((t) => setTree(t));
        void files.state(workspace.id).then((s) => setState(s));
    }, [files, workspace.id]);

    useEffect(() => {
        refresh();
        void files.watch(workspace.id);
        return files.onChange((id) => { if (id === workspace.id) refresh(); });
    }, [files, workspace.id, refresh]);

    // A file that changed on disk while open is re-read; a dirty buffer would never be — the viewer is read-only today.
    useEffect(() => {
        if (!open) return;
        return files.onChange((id) => { if (id === workspace.id) void files.open(workspace.id, open.path).then(setOpen); });
    }, [files, workspace.id, open]);

    const select = useCallback((path: string) => {
        setTabs((t) => (t.includes(path) ? t : [...t, path]));
        void files.open(workspace.id, path).then(setOpen);
    }, [files, workspace.id]);

    const closeTab = useCallback((path: string) => {
        setTabs((t) => {
            const next = t.filter((p) => p !== path);
            if (open?.path === path) {
                const fallback = next[next.length - 1];
                if (fallback) void files.open(workspace.id, fallback).then(setOpen);
                else setOpen(null);
            }
            return next;
        });
    }, [files, workspace.id, open]);

    return <FilesPanel workspace={workspace} tree={tree} state={state} tabs={tabs} open={open} pinned={pinned} onSelect={select} onCloseTab={closeTab} onPin={onPin} onClose={onClose} />;
}
