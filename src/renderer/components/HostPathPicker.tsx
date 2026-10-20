import { FileBrowser, Modal, type FileEntry } from '@particle-academy/react-fancy';
import { createContext, useContext, useMemo, useState } from 'react';
import type { HostListing } from '../../main/host-fs.js';

/**
 * EVERY FILE AND FOLDER INPUT READS THE HOST (Tynn #835; the owner, 2026-10-19: FileBrowser "is what we should be using
 * for all of our file inputs because it needs to read the host it's connecting to, not the machine the client is running
 * on"). react-fancy's FileBrowser over `host.listDir` — the HOST's disk, through the remote protocol when this window
 * drives another machine. A folder loads when it is opened, never an eager walk. Genie 1's #199 FilePickerModal.
 */

export type ListDir = (path: string) => Promise<HostListing>;

/**
 * The host listing as FileBrowser entries; a refusal is the folder's error, in the host's words. With `extensions`
 * (an alert's sound), other files are listed but disabled — seen, not picked; folders stay open.
 */
export function fileEntriesOf(listing: HostListing, extensions?: readonly string[]): FileEntry[] {
    if (!listing.ok) throw new Error(listing.reason);
    const allowed = extensions ? new Set(extensions.map((x) => x.toLowerCase())) : null;
    const pickable = (name: string) => allowed === null || allowed.has((name.split('.').pop() ?? '').toLowerCase());
    return listing.entries.map((e) => (e.kind === 'dir'
        ? { path: e.path, name: e.name, kind: 'dir' as const }
        : { path: e.path, name: e.name, kind: 'file' as const, hasChildren: false, ...(pickable(e.name) ? {} : { disabled: true }) }));
}

/** Ask for a path on the HOST (Tynn #835): `null` when cancelled; `string[]` for `files`. */
export type PickHostPath = (opts: { mode: 'directory' | 'file' | 'files'; title?: string; initialPath?: string; extensions?: readonly string[] }) => Promise<string | string[] | null>;

/** The window's one picker, for components that pick (an alert's sound). Absent = nothing to pick with. */
export const HostPathPickerContext = createContext<PickHostPath | null>(null);
export const useHostPathPicker = (): PickHostPath | null => useContext(HostPathPickerContext);

export interface HostPathPickerProps {
    /** `directory`: pick a folder; `file`: one file; `files`: several. */
    readonly mode: 'directory' | 'file' | 'files';
    readonly listDir: ListDir;
    readonly title?: string | undefined;
    /** Where it opens (`/` = the machine's root: its drives on Windows). */
    readonly initialPath?: string | undefined;
    /** Files with other extensions are listed but cannot be picked. */
    readonly extensions?: readonly string[] | undefined;
    /** Pre-selected (tests, a remembered choice). */
    readonly initialSelection?: string | readonly string[] | undefined;
    readonly onPick: (picked: string | string[]) => void;
    readonly onCancel: () => void;
}

const button = 'rounded-md border border-[var(--border-1)] px-3 py-1 text-xs hover:bg-[var(--bg-2)] disabled:opacity-50';

/** The picker's body — FileBrowser, what is picked, Choose / Cancel. Fancy's Modal portals; this does not. */
export function HostPathPickerForm({ mode, listDir, initialPath = '/', initialSelection, extensions, onPick, onCancel }: HostPathPickerProps) {
    const multiple = mode === 'files';
    const [picked, setPicked] = useState<string[]>(() => (initialSelection === undefined ? [] : Array.isArray(initialSelection) ? [...initialSelection] : [initialSelection as string]));
    const provider = useMemo(() => ({ loadChildren: async (path: string) => fileEntriesOf(await listDir(path), extensions) }), [listDir, extensions]);
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

/**
 * A picked folder as a field relative to `root` wants it (Tynn #835 part 3): `repos/app`, `.` for the folder itself;
 * outside `root` — a sibling that merely starts with its name included — refused in words. Case is ignored only on a
 * Windows drive path.
 */
export function relativeInside(root: string, picked: string): { ok: true; path: string } | { ok: false; reason: string } {
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const r = norm(root);
    const p = norm(picked);
    const windows = /^[A-Za-z]:/.test(r);
    const fold = (s: string) => (windows ? s.toLowerCase() : s);
    if (fold(p) === fold(r)) return { ok: true, path: '.' };
    if (!fold(p).startsWith(`${fold(r)}/`)) return { ok: false, reason: `${picked} is not inside ${root}` };
    return { ok: true, path: p.slice(r.length + 1) };
}

/**
 * Browse beside a typed folder field (Tynn #835 part 3): picks over the HOST's disk, opening in the folder the field is
 * relative to, and writes the relative path into the form's field `name`. `root` is read at the click (a form whose
 * workspace is chosen in a select). No picker, or nothing to be relative to: nothing is drawn — the field stays typed.
 */
export function PathBrowse({ name, root }: { readonly name: string; readonly root: (() => string | null) | string | null }) {
    const pick = useHostPathPicker();
    const [problem, setProblem] = useState<string | null>(null);
    if (!pick || root === null) return null;
    return (
        <>
            <button
                type="button"
                data-action="browse-path"
                className="rounded-md border border-[var(--border-1)] px-2 py-0.5 text-xs hover:bg-[var(--bg-2)]"
                onClick={(e) => {
                    const form = e.currentTarget.form;
                    const base = typeof root === 'function' ? root() : root;
                    if (!form || !base) return;
                    void pick({ mode: 'directory', initialPath: base }).then((picked) => {
                        if (typeof picked !== 'string') return;
                        const rel = relativeInside(base, picked);
                        if (!rel.ok) { setProblem(rel.reason); return; }
                        setProblem(null);
                        const field = form.elements.namedItem(name);
                        if (field instanceof HTMLInputElement) {
                            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                            set?.call(field, rel.path);
                            field.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                    });
                }}
            >
                Browse…
            </button>
            {problem ? <span data-problem="browse" className="text-xs text-[var(--danger)]">{problem}</span> : null}
        </>
    );
}
