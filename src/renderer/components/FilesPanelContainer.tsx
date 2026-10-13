import { useCallback, useEffect, useState } from 'react';
import type { TreeNode } from '../../core/files-panel.js';
import { pauseRequests, resumed, type Pause } from '../../core/files-popout.js';
import type { GenieBridge } from '../bridge.js';
import { FilesPanel, type FilesEdit, type FilesPanelState, type OpenFile } from './FilesPanel.js';

/**
 * The file panel's WIRING (§4.3): loads the tree and the attribution state from the bridge, re-reads
 * them when the host says the workspace changed (push, never a poll), keeps the open tabs. The pure
 * rendering is `FilesPanel`, which is what the tests render. One container per workspace surface.
 */
export function FilesPanelContainer({ workspace, files, pinned, onPin, onClose, popped, onPopOut, onPause, onResume, single, onOpenInPane, onDirtyChange }: {
    workspace: { id: string; name?: string | undefined; path: string };
    files: GenieBridge['files'];
    pinned: boolean;
    onPin: () => void;
    onClose: () => void;
    popped?: boolean | undefined;
    onPopOut?: (() => void) | undefined;
    /**
     * An agent is writing a file you have dirty (§4.3): ask it to pause; lifted when the buffer is clean again.
     * `why === 'conflict'`: your save met its write — the notice says so (`conflictMessage`), and it stays paused.
     */
    onPause?: ((agent: string, path: string, why?: 'conflict') => void) | undefined;
    onResume?: ((agent: string, path: string) => void) | undefined;
    /** SINGLE mode (§4.6): this one file, opened on mount; no tree. */
    single?: string | undefined;
    /** Whether a buffer here differs from what was opened (§4.4: a panel with unsaved edits refuses to be replaced in the dock). */
    onDirtyChange?: ((dirty: boolean) => void) | undefined;
    onOpenInPane?: ((path: string) => void) | undefined;
}) {
    const [tree, setTree] = useState<readonly TreeNode[] | null>(null);
    const [state, setState] = useState<FilesPanelState | null>(null);
    const [tabs, setTabs] = useState<readonly string[]>([]);
    const [open, setOpen] = useState<OpenFile | null>(null);
    // The board's `All | Changed N` filter (§4.3): Changed shows the files grouped by who changed them.
    const [filter, setFilter] = useState<'all' | 'changed'>('all');
    // The buffer you are typing into (§4.3): dirty while it differs from what was opened; never auto-reloaded.
    const [buffer, setBuffer] = useState<{ path: string; text: string } | null>(null);
    const [conflict, setConflict] = useState<{ path: string; onDisk: string; sha: string; baseline?: string | undefined } | null>(null);
    // Agents asked to pause (§4.3): one ask per (agent, file) while your buffer is dirty; lifted when it is clean.
    const [paused, setPaused] = useState<readonly Pause[]>([]);
    // The agent TOLD about the open conflict (the banner says so only then), and whether Compare is open.
    const [told, setTold] = useState<string | null>(null);
    const [comparing, setComparing] = useState(false);
    useEffect(() => { if (conflict === null) { setTold(null); setComparing(false); } }, [conflict]);
    const dirtyPath = buffer !== null && open?.ok && buffer.path === open.path && buffer.text !== open.text ? buffer.path : null;
    // The dock's refusal rule needs to know (§4.4); reported on every change, and clean on unmount.
    useEffect(() => { onDirtyChange?.(dirtyPath !== null); return () => { onDirtyChange?.(false); }; }, [dirtyPath, onDirtyChange]);
    useEffect(() => {
        const dirty = dirtyPath ? [dirtyPath] : [];
        const adds = pauseRequests(state?.activity ?? [], dirty, paused);
        const lifted = resumed(paused, dirty);
        if (adds.length === 0 && lifted.length === 0) return;
        for (const p of adds) onPause?.(p.agent, p.path);
        for (const p of lifted) onResume?.(p.agent, p.path);
        setPaused([...paused.filter((p) => !lifted.includes(p)), ...adds]);
    }, [state, dirtyPath, paused, onPause, onResume]);

    // A code pane (§4.6) opens its one file on mount.
    useEffect(() => { if (single) { setTabs([single]); void files.open(workspace.id, single).then((r) => setOpen(r)); } }, [single, files, workspace.id]);

    const refresh = useCallback(() => {
        void files.tree(workspace.id).then((t) => setTree(t));
        void files.state(workspace.id).then((s) => setState(s));
    }, [files, workspace.id]);

    useEffect(() => {
        refresh();
        void files.watch(workspace.id);
        return files.onChange((id) => { if (id === workspace.id) refresh(); });
    }, [files, workspace.id, refresh]);

    // A dirty buffer is NEVER auto-reloaded (§4.3); a clean one follows the disk.
    useEffect(() => {
        if (!open || buffer !== null) return;
        return files.onChange((id) => { if (id === workspace.id) void files.open(workspace.id, open.path).then(setOpen); });
    }, [files, workspace.id, open, buffer]);

    const select = useCallback((path: string) => {
        setTabs((t) => (t.includes(path) ? t : [...t, path]));
        setBuffer(null);
        setConflict(null);
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

    const shown: OpenFile | null = open?.ok && buffer && buffer.path === open.path ? { ...open, text: buffer.text } : open;
    const save = (expected: string | null) => {
        if (!open?.ok || !buffer) return;
        void files.write(workspace.id, open.path, buffer.text, expected).then((r) => {
            if (r.ok) { setOpen({ ok: true, path: open.path, text: buffer.text, sha: r.sha }); setBuffer(null); setConflict(null); }
            else if (r.conflict) {
                setConflict({ ...r.conflict, baseline: open.text });
                // The known writer is TOLD, once, and held paused until your buffer is clean (then `resumeMessage`).
                // Without a known writer nobody is told, and the banner does not say anyone was.
                const writer = state?.activity.find((a) => a.verb === 'writing' && a.path === open.path)?.agent ?? null;
                if (writer !== null && onPause) {
                    onPause(writer, open.path, 'conflict');
                    setPaused((p) => (p.some((x) => x.agent === writer && x.path === open.path) ? p : [...p, { agent: writer, path: open.path }]));
                    setTold(writer);
                }
            }
        });
    };
    const edit: FilesEdit | undefined = open?.ok
        ? {
              dirty: buffer !== null && buffer.text !== open.text,
              conflict,
              onChange: (text) => setBuffer({ path: open.path, text }),
              onSave: () => save(open.sha),
              // keep mine: write against the CURRENT sha — an explicit choice, never implicit.
              onKeepMine: () => { if (conflict) save(conflict.sha); },
              onTakeTheirs: () => { if (conflict) { setOpen({ ok: true, path: open.path, text: conflict.onDisk, sha: conflict.sha }); setBuffer(null); setConflict(null); } },
              // Compare (the board's primary): your buffer against the disk, read-only. Nothing is written by looking.
              told,
              comparing,
              onCompare: () => setComparing((c) => !c),
          }
        : undefined;
    return <FilesPanel workspace={workspace} tree={tree} state={state} tabs={tabs} open={shown} pinned={pinned} onSelect={select} onCloseTab={closeTab} onPin={onPin} onClose={onClose} edit={edit} onPopOut={onPopOut} popped={popped} paused={paused} single={single} onOpenInPane={onOpenInPane} filter={filter} onFilter={setFilter} />;
}
