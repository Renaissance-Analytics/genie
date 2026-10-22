import { FileBrowser, Modal, type FileEntry } from '@particle-academy/react-fancy';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { hostFolder, parentOf, rootLabel, rootsOf } from '../../core/host-path.js';
import type { HostListing, HostMade } from '../../main/host-fs.js';

/**
 * EVERY FILE AND FOLDER INPUT READS THE HOST (Tynn #835; the owner, 2026-10-19: FileBrowser "is what we should be using
 * for all of our file inputs because it needs to read the host it's connecting to, not the machine the client is running
 * on"). react-fancy's FileBrowser over `host.listDir` — the HOST's disk, through the remote protocol when this window
 * drives another machine. A folder loads when it is opened, never an eager walk. Genie 1's #199 FilePickerModal.
 */

const button = 'rounded-md border border-[var(--border-1)] px-3 py-1 text-xs hover:bg-[var(--bg-2)] disabled:opacity-50';

export type ListDir = (path: string) => Promise<HostListing>;
/** New folder on the HOST (main/host-fs.ts makeHostDir): `name` made inside `parent`, through the remote protocol too. */
export type MakeDir = (parent: string, name: string) => Promise<HostMade>;

/**
 * New folder, as FileBrowser's form calls it: the HOST makes it inside the folder being viewed, then it is selected
 * (FileBrowser reloads the folder, so it shows). A refusal rejects — FileBrowser puts it on its form, in the host's words.
 */
export function newFolderHandler(mkdir: MakeDir, select: (path: string) => void) {
    return async ({ parentPath, name }: { parentPath: string; name: string }): Promise<void> => {
        const made = await mkdir(parentPath, name);
        if (!made.ok) throw new Error(made.reason);
        select(made.path);
    };
}

/**
 * Above the browser: Up to the parent and the machine's roots (its drives on Windows, `/` elsewhere), one click each —
 * the owner could not leave the folder the picker opened in without typing (2026-10-22). FileBrowser's own path bar,
 * below, keeps the breadcrumb and the typed path.
 */
export function PickerNav({ path, roots, onNavigate }: { readonly path: string; readonly roots: readonly string[]; readonly onNavigate: (path: string) => void }) {
    const up = parentOf(path);
    return (
        <div data-picker-path={path} className="flex items-center gap-1 text-xs">
            <button type="button" data-action="picker-up" disabled={up === null} title={up === null ? 'Already at the top' : `Up to ${up}`} onClick={() => { if (up !== null) onNavigate(up); }} className={button}>
                ↑ Up
            </button>
            {roots.map((root) => (
                <button key={root} type="button" data-picker-root={root} title={root === '/' ? 'The top of this machine' : `The ${rootLabel(root)} drive`} onClick={() => onNavigate(root)} className={`${button} font-mono${hostFolder(path) === root ? ' bg-[var(--bg-2)]' : ''}`}>
                    {rootLabel(root)}
                </button>
            ))}
        </div>
    );
}

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
    /** New folder, made on the host. Offered in a folder picker only, and only when given. */
    readonly mkdir?: MakeDir | undefined;
    readonly onPick: (picked: string | string[]) => void;
    readonly onCancel: () => void;
}

/** The picker's body — FileBrowser, what is picked, Choose / Cancel. Fancy's Modal portals; this does not. */
export function HostPathPickerForm({ mode, listDir, mkdir, initialPath = '/', initialSelection, extensions, onPick, onCancel }: HostPathPickerProps) {
    const multiple = mode === 'files';
    const [picked, setPicked] = useState<string[]>(() => (initialSelection === undefined ? [] : Array.isArray(initialSelection) ? [...initialSelection] : [initialSelection as string]));
    // The folder being viewed is the picker's, so Up and the roots can move it; every move — a breadcrumb, a typed path,
    // a double-clicked folder — passes through hostFolder (a breadcrumb's bare `C:` is the drive's root).
    const [path, setPath] = useState(() => hostFolder(initialPath));
    const [roots, setRoots] = useState<readonly string[]>(['/']);
    // The roots are read once, when the picker opens: App passes a fresh listDir on each render, and on Windows reading
    // `/` probes every drive letter — not something to repeat whenever the window re-renders.
    const firstListDir = useRef(listDir);
    useEffect(() => {
        let live = true;
        void firstListDir.current('/').then((listing) => { if (live) setRoots(rootsOf(listing)); }, () => {});
        return () => { live = false; };
    }, []);
    const provider = useMemo(() => ({ loadChildren: async (p: string) => fileEntriesOf(await listDir(p), extensions) }), [listDir, extensions]);
    const createFolder = useMemo(() => (mode === 'directory' && mkdir ? newFolderHandler(mkdir, (made) => setPicked([made])) : undefined), [mode, mkdir]);
    return (
        <div data-host-path-picker={mode} className="flex flex-col gap-3 text-sm">
            <PickerNav path={path} roots={roots} onNavigate={(p) => setPath(hostFolder(p))} />
            <div className="h-[360px] overflow-hidden rounded-lg border border-[var(--border-1)]">
                <FileBrowser
                    provider={provider}
                    select={mode === 'directory' ? 'directory' : 'file'}
                    multiple={multiple}
                    path={path}
                    onPathChange={(p) => setPath(hostFolder(p))}
                    {...(createFolder ? { onCreateFolder: createFolder } : {})}
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
