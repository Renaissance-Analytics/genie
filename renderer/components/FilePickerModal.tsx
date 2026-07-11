import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
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

// --- Singleton picker service ------------------------------------------------
//
// A picker is used from ~15 call sites across many components. Rather than make
// each mount its own modal, a module-level singleton drives ONE <FilePickerHost>
// mounted at the app root: any code calls `pickPath(opts)` and awaits the chosen
// path — a one-line swap for the old `api().settings.chooseFolder()` native dialog.

interface PickRequest {
    mode: 'file' | 'directory';
    title: string;
    initialPath?: string;
    resolve: (path: string | null) => void;
}

let currentRequest: PickRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
    for (const l of listeners) l();
}

/**
 * Open the in-app picker and resolve to the chosen absolute host path, or null if
 * cancelled. Requires <FilePickerHost/> to be mounted once at the app root. A
 * second call while one is open supersedes it (the prior resolves null).
 */
export function pickPath(opts: {
    mode: 'file' | 'directory';
    title: string;
    initialPath?: string;
}): Promise<string | null> {
    return new Promise((resolve) => {
        if (currentRequest) currentRequest.resolve(null);
        currentRequest = { ...opts, resolve };
        emit();
    });
}

/**
 * The single always-mounted host for {@link pickPath}. Renders nothing until a
 * pick is requested. Mount it ONCE, high in the tree (e.g. _app), so the modal
 * overlays every page.
 */
export function FilePickerHost() {
    const request = useSyncExternalStore(
        (cb) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        () => currentRequest,
        () => currentRequest,
    );
    if (!request) return null;
    const finish = (path: string | null) => {
        const r = request;
        currentRequest = null;
        emit();
        r.resolve(path);
    };
    return (
        <FilePickerModal
            mode={request.mode}
            title={request.title}
            initialPath={request.initialPath}
            onPick={(p) => finish(p)}
            onCancel={() => finish(null)}
        />
    );
}
