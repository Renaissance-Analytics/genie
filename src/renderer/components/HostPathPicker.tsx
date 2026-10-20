import { FileBrowser, Modal, type FileEntry } from '@particle-academy/react-fancy';
import { useMemo, useState } from 'react';
import type { HostListing } from '../../main/host-fs.js';

/**
 * EVERY FILE AND FOLDER INPUT READS THE HOST (Tynn #835; the owner, 2026-10-19: FileBrowser "is what we should be using
 * for all of our file inputs because it needs to read the host it's connecting to, not the machine the client is running
 * on"). react-fancy's FileBrowser over `host.listDir` — the HOST's disk, through the remote protocol when this window
 * drives another machine. A folder loads when it is opened, never an eager walk. Genie 1's #199 FilePickerModal.
 */

export type ListDir = (path: string) => Promise<HostListing>;

/** The host listing as FileBrowser entries; a refusal is the folder's error, in the host's words. */
export function fileEntriesOf(listing: HostListing): FileEntry[] {
    if (!listing.ok) throw new Error(listing.reason);
    return listing.entries.map((e) => (e.kind === 'dir' ? { path: e.path, name: e.name, kind: 'dir' as const } : { path: e.path, name: e.name, kind: 'file' as const, hasChildren: false }));
}

export interface HostPathPickerProps {
    /** `directory`: pick a folder; `file`: one file; `files`: several. */
    readonly mode: 'directory' | 'file' | 'files';
    readonly listDir: ListDir;
    readonly title?: string | undefined;
    /** Where it opens (`/` = the machine's root: its drives on Windows). */
    readonly initialPath?: string | undefined;
    /** Pre-selected (tests, a remembered choice). */
    readonly initialSelection?: string | readonly string[] | undefined;
    readonly onPick: (picked: string | string[]) => void;
    readonly onCancel: () => void;
}

const button = 'rounded-md border border-[var(--border-1)] px-3 py-1 text-xs hover:bg-[var(--bg-2)] disabled:opacity-50';

/** The picker's body — FileBrowser, what is picked, Choose / Cancel. Fancy's Modal portals; this does not. */
export function HostPathPickerForm({ mode, listDir, initialPath = '/', initialSelection, onPick, onCancel }: HostPathPickerProps) {
    const multiple = mode === 'files';
    const [picked, setPicked] = useState<string[]>(() => (initialSelection === undefined ? [] : Array.isArray(initialSelection) ? [...initialSelection] : [initialSelection as string]));
    const provider = useMemo(() => ({ loadChildren: async (path: string) => fileEntriesOf(await listDir(path)) }), [listDir]);
    return (
        <div data-host-path-picker={mode} className="flex flex-col gap-3 text-sm">
            <div className="h-[360px] overflow-hidden rounded-lg border border-[var(--border-1)]">
                <FileBrowser
                    provider={provider}
                    select={mode === 'directory' ? 'directory' : 'file'}
                    multiple={multiple}
                    defaultPath={initialPath}
                    value={multiple ? picked : (picked[0] ?? null)}
                    onChange={(value) => setPicked(value === null ? [] : Array.isArray(value) ? value : [value])}
                    className="h-full"
                />
            </div>
            <div className="flex items-center gap-2">
                <span data-picked="" className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--fg-3)]">{picked.length === 0 ? (mode === 'directory' ? 'Pick a folder' : 'Pick a file') : picked.join(', ')}</span>
                <button type="button" data-action="cancel-pick" onClick={onCancel} className={button}>Cancel</button>
                <button type="button" data-action="pick-path" disabled={picked.length === 0} onClick={() => onPick(multiple ? picked : picked[0]!)} className={button}>Choose</button>
            </div>
        </div>
    );
}

export function HostPathPicker(props: HostPathPickerProps) {
    return (
        <Modal open onClose={props.onCancel} size="lg">
            <Modal.Header>{props.title ?? (props.mode === 'directory' ? 'Pick a folder' : props.mode === 'files' ? 'Pick files' : 'Pick a file')}</Modal.Header>
            <Modal.Body>
                <HostPathPickerForm {...props} />
            </Modal.Body>
        </Modal>
    );
}
