import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
    FileBrowser,
    type FileBrowserProvider,
    type FileEntry,
} from '@particle-academy/react-fancy';
import { api, type TreeNodeData } from '../lib/genie';

/**
 * In-app file/folder picker — replaces the native OS `dialog.showOpenDialog`
 * everywhere Genie needs a path (Settings' workspace folder / env file / custom
 * sound, plugin folder, …). Built on react-fancy's `FileBrowser` fed by the
 * `system`-mode `files.listTree` — so it browses the SAME machine the pty runs
 * on: local when local, and the HOST when driving a remote window (the native
 * dialog would have opened on the wrong machine and browsed the wrong disk).
 *
 * The provider is lazy: each folder loads its DIRECT children on first expand
 * (maxDepth 0), never an eager walk. Node ids are absolute, forward-slashed host
 * paths — exactly what a setting stores.
 */

export interface FilePickerModalProps {
    /** Which kind is selectable — a folder picker or a file picker. */
    mode: 'file' | 'directory';
    title: string;
    /** Directory to open at (absolute host path); defaults to the FS root/drives. */
    initialPath?: string;
    onPick: (absPath: string) => void;
    onCancel: () => void;
}

/** Map a Genie system-mode `TreeNodeData` to a react-fancy `FileEntry`. */
function toEntry(n: TreeNodeData): FileEntry {
    const isDir = n.type === 'folder';
    return {
        path: n.id,
        name: n.label,
        kind: isDir ? 'dir' : 'file',
        // Unknown depth → expandable; the provider fills children on expand. A file
        // is a leaf (never expandable).
        hasChildren: isDir ? undefined : false,
    };
}

export default function FilePickerModal({
    mode,
    title,
    initialPath,
    onPick,
    onCancel,
}: FilePickerModalProps) {
    const [selected, setSelected] = useState<string | null>(null);

    const provider = useMemo<FileBrowserProvider>(
        () => ({
            loadChildren: async (p: string): Promise<FileEntry[]> => {
                // '' / '/' = the machine root → drive letters (Windows) or `/` (POSIX).
                const top = !p || p === '/';
                const tree = await api().files.listTree('', {
                    system: true,
                    maxDepth: 0, // one level — the direct children of `p`, lazily
                    ...(top ? {} : { root: p }),
                });
                return tree.map(toEntry);
            },
        }),
        [],
    );

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCancel();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onCancel]);

    return (
        <div className="ctx-scrim" onMouseDown={onCancel}>
            <div
                className="file-picker-modal"
                role="dialog"
                aria-label={title}
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="file-picker-head">
                    <span className="file-picker-title">{title}</span>
                </div>
                <div className="file-picker-body">
                    <FileBrowser
                        provider={provider}
                        select={mode === 'directory' ? 'directory' : 'file'}
                        defaultPath={initialPath || '/'}
                        value={selected}
                        onChange={(v) =>
                            setSelected(
                                typeof v === 'string'
                                    ? v
                                    : Array.isArray(v)
                                      ? (v[0] ?? null)
                                      : null,
                            )
                        }
                    />
                </div>
                <div className="file-picker-actions">
                    <span className="file-picker-selected" title={selected ?? undefined}>
                        {selected || `Choose a ${mode === 'directory' ? 'folder' : 'file'}…`}
                    </span>
                    <div className="file-picker-btns">
                        <button type="button" className="agent-form-btn" onClick={onCancel}>
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="agent-form-btn agent-form-go"
                            disabled={!selected}
                            onClick={() => selected && onPick(selected)}
                        >
                            Choose
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

/**
 * Imperative helper for the picker: `pick({mode,title})` resolves to the chosen
 * absolute path (or null if cancelled); render `modal` somewhere in the tree.
 * Lets a plain handler `await` a path where it used to `await api().settings.
 * chooseFolder()` — the native dialog — with a one-line swap.
 */
export function useFilePicker(): {
    pick: (opts: {
        mode: 'file' | 'directory';
        title: string;
        initialPath?: string;
    }) => Promise<string | null>;
    modal: ReactNode;
} {
    const [request, setRequest] = useState<{
        mode: 'file' | 'directory';
        title: string;
        initialPath?: string;
        resolve: (path: string | null) => void;
    } | null>(null);

    const pick = useCallback(
        (opts: { mode: 'file' | 'directory'; title: string; initialPath?: string }) =>
            new Promise<string | null>((resolve) => setRequest({ ...opts, resolve })),
        [],
    );

    const finish = useCallback(
        (path: string | null) => {
            setRequest((cur) => {
                cur?.resolve(path);
                return null;
            });
        },
        [],
    );

    const modal = request ? (
        <FilePickerModal
            mode={request.mode}
            title={request.title}
            initialPath={request.initialPath}
            onPick={(p) => finish(p)}
            onCancel={() => finish(null)}
        />
    ) : null;

    return { pick, modal };
}
