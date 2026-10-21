import { Icon, Modal } from '@particle-academy/react-fancy';
import { useEffect, useState } from 'react';
import { newWorkspaceProblem, workspaceFolderName } from '../../core/add-workspace.js';
import type { TynnProject } from '../../core/tynn.js';

/**
 * ADD A WORKSPACE — GENIE 1'S MODAL (the owner, 2026-10-21: "WTf happened to my fucking new workspace UX … Look at Genie
 * 1 … I can't create workspaces at all right now"). Genie 1's AddWorkspaceModal: first "How should Genie start?" —
 * Start something new / Bring in what you already have — then, for a new one, a NAME and a FOLDER prefilled from Settings
 * → Primary workspace, where it lands, and Create workspace; Genie makes the folder. Genie 2 had opened a raw folder
 * browser on the drive list that could only adopt a folder that already existed.
 *
 * The two halves are hook-free, so a test can press them; the modal holds the stage and the draft.
 */

const card = 'flex min-h-[132px] flex-col items-start gap-2 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] p-4 text-left hover:border-[var(--violet-400)] hover:bg-[var(--bg-2)]';
const groupLabel = 'text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-4)]';
const button = 'rounded-md border border-[var(--border-1)] px-3 py-1 text-xs hover:bg-[var(--bg-2)] disabled:opacity-50';
const primary = 'flex items-center gap-1.5 rounded-md bg-[var(--violet-500)] px-3 py-1 text-xs font-medium text-white hover:bg-[var(--violet-400)] disabled:opacity-50';

/** One card — a call, not a component, so the chooser stays one hook-free tree a test can walk and press. */
function sourceCard({ id, icon, title, desc, onClick }: { id: string; icon: string; title: string; desc: string; onClick: () => void }) {
    return (
        <button type="button" data-add-source={id} onClick={onClick} className={card}>
            <span className="text-[var(--violet-400)]"><Icon name={icon} size="lg" /></span>
            <span className="text-sm font-semibold text-[var(--fg-1)]">{title}</span>
            <span className="text-xs text-[var(--fg-3)]">{desc}</span>
        </button>
    );
}

/** "How should Genie start?" — Genie 1's source chooser, its words (workspace-onboarding.ts). GApp workspaces are not in Genie 2. */
export function AddWorkspaceSource({ onNew, onOpenExisting, onGit, onTynn }: { onNew: () => void; onOpenExisting: () => void; onGit: () => void; onTynn: () => void }) {
    return (
        <div data-add-workspace-source="" className="flex flex-col gap-4">
            <div>
                <h2 className="text-base font-semibold">How should Genie start?</h2>
                <p className="text-xs text-[var(--fg-3)]">Start something new, or bring in what you already have — Genie reads a folder or repository before it writes anything, and shows you the plan first.</p>
            </div>
            <div className="flex flex-col gap-2">
                <span className={groupLabel}>Start something new</span>
                <div className="grid grid-cols-2 gap-3">
                    {sourceCard({ id: 'new', icon: 'sparkles', title: 'New workspace', desc: 'Name it, say where it lives. Genie makes the folder and its first commit.', onClick: onNew })}
                </div>
            </div>
            <div className="flex flex-col gap-2">
                <span className={groupLabel}>Bring in what you already have</span>
                <div className="grid grid-cols-3 gap-3">
                    {sourceCard({ id: 'existing', icon: 'folder-open', title: 'Open existing folder', desc: 'Point Genie at a folder you already have. It reads what is there and shows the plan before writing.', onClick: onOpenExisting })}
                    {sourceCard({ id: 'git', icon: 'git-branch', title: 'Import from Git', desc: 'Start from a GitHub repository now; more Git providers can plug into this route later.', onClick: onGit })}
                    {sourceCard({ id: 'tynn', icon: 'cloud-download', title: 'Import from Tynn', desc: 'Choose one of your Tynn projects and bring its repositories to this machine.', onClick: onTynn })}
                </div>
            </div>
        </div>
    );
}

export interface NewWorkspaceFormProps {
    readonly name: string;
    readonly parent: string;
    /** The host's path separator, for "Lands at …". */
    readonly sep: string;
    readonly busy: boolean;
    readonly error: string | null;
    readonly onName: (name: string) => void;
    readonly onBrowse: () => void;
    readonly onCreate: () => void;
    readonly onCancel: () => void;
    /**
     * The person's Tynn projects, for Genie 1's optional "Project" link: `null` while they load, a refusal in Tynn's
     * words when they cannot be listed. Absent = this window has no Tynn to ask, and no picker is offered.
     */
    readonly tynn?: { readonly ok: true; readonly projects: readonly TynnProject[] } | { readonly ok: false; readonly reason: string } | null;
    readonly projectId?: string | null;
    readonly onProject?: (projectId: string | null) => void;
}

/** Genie 1's New workspace form: Workspace name, Folder (+ Browse), where it lands, an optional Tynn project, Create workspace. */
export function NewWorkspaceForm({ name, parent, sep, busy, error, onName, onBrowse, onCreate, onCancel, tynn, projectId = null, onProject }: NewWorkspaceFormProps) {
    const folder = workspaceFolderName(name);
    const ready = newWorkspaceProblem(name, parent) === null && !busy;
    const lands = parent.trim() !== '' && folder !== '' ? `${parent.trim().replace(/[\\/]+$/, '')}${sep}${folder}` : null;
    return (
        <div data-new-workspace="" className="flex flex-col gap-4 text-sm">
            <div>
                <h2 className="text-base font-semibold">New workspace</h2>
                <p className="text-xs text-[var(--fg-3)]">An empty workspace. Repositories can be added at any time.</p>
            </div>
            <label className="flex flex-col gap-1">
                <span className="text-xs font-semibold">Workspace name</span>
                <input data-field="workspace-name" value={name} placeholder="Acme Storefront" onChange={(e) => onName(e.target.value)} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-0)] px-2.5 py-1.5" />
            </label>
            <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold">Folder</span>
                <div className="flex items-center gap-2">
                    <input data-field="workspace-parent" value={parent} readOnly placeholder="No folder chosen" className="min-w-0 flex-1 rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2.5 py-1.5 font-mono text-xs" />
                    <button type="button" data-action="browse-parent" onClick={onBrowse} className={`${button} flex items-center gap-1.5`}><Icon name="folder" size="xs" />Browse</button>
                </div>
                <span data-lands-at="" className="text-xs text-[var(--fg-3)]">{lands ? `Lands at ${lands}` : 'Pick the folder your workspaces live in.'}</span>
            </div>
            {/* WHERE IT IS KEPT, honestly (Genie 1 said "Backed up to GitHub as owner/x.agi" — Genie 2 creates no repository). */}
            {name.trim() !== '' ? <p data-storage-note="" className="text-xs text-[var(--fg-3)]">Kept on this machine. Genie does not create a GitHub repository for a new workspace.</p> : null}
            {/* GENIE 1'S OPTIONAL TYNN PROJECT: none by default; a workspace works the same without one. */}
            {tynn !== undefined ? (
                <label className="flex flex-col gap-1">
                    <span className="text-xs font-semibold">Project (optional)</span>
                    {tynn === null ? (
                        <span className="text-xs text-[var(--fg-3)]">Loading Tynn projects…</span>
                    ) : tynn.ok ? (
                        <select data-field="tynn-project" value={projectId ?? ''} onChange={(e) => onProject?.(e.target.value === '' ? null : e.target.value)} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-0)] px-2.5 py-1.5">
                            <option value="">— No project (just a folder) —</option>
                            {tynn.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                    ) : (
                        <span className="text-xs text-[var(--fg-3)]">No Tynn projects available — {tynn.reason}</span>
                    )}
                    <span className="text-xs text-[var(--fg-3)]">Optionally link this workspace to a Tynn project. Not required, and not required later either — the workspace works the same without one.</span>
                </label>
            ) : null}
            {error ? <p data-add-error="" className="rounded-md border border-[var(--danger)] bg-[var(--danger)]/10 px-2.5 py-1.5 text-xs">{error}</p> : null}
            <div className="flex items-center justify-end gap-2">
                <button type="button" data-action="cancel-add" onClick={onCancel} className={button}>Cancel</button>
                <button type="button" data-action="create-workspace" disabled={!ready} onClick={onCreate} className={primary}><Icon name="check" size="xs" />{busy ? 'Working…' : 'Create workspace'}</button>
            </div>
        </div>
    );
}

export interface AddWorkspaceModalProps {
    readonly open: boolean;
    /** Settings → General → Primary workspace: the New workspace folder starts here. */
    readonly primaryWorkspace: string;
    readonly sep: string;
    /** Browse for the folder: the host's picker, opened where the folder field points (else the Primary workspace). */
    readonly browseParent: (current: string) => Promise<string | null>;
    readonly create: (name: string, parent: string, tynnProjectId?: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
    /** The person's Tynn projects, for the optional link. Absent = no Tynn to ask (no picker). */
    readonly tynnProjects?: (() => Promise<{ ok: true; projects: TynnProject[] } | { ok: false; reason: string }>) | undefined;
    readonly onOpenExisting: () => void;
    readonly onGit: () => void;
    readonly onTynn: () => void;
    readonly onClose: () => void;
}

export function AddWorkspaceModal({ open, primaryWorkspace, sep, browseParent, create, tynnProjects, onOpenExisting, onGit, onTynn, onClose }: AddWorkspaceModalProps) {
    const [stage, setStage] = useState<'source' | 'new'>('source');
    const [tynn, setTynn] = useState<Exclude<NewWorkspaceFormProps['tynn'], undefined>>(null);
    const [projectId, setProjectId] = useState<string | null>(null);
    // The projects are read when the New workspace form opens; a failure is said in Tynn's words, never thrown.
    useEffect(() => {
        if (stage !== 'new' || !tynnProjects) return;
        let live = true;
        setTynn(null);
        void tynnProjects().then(
            (r) => { if (live) setTynn(r.ok ? { ok: true, projects: r.projects } : { ok: false, reason: r.reason }); },
            (e: unknown) => { if (live) setTynn({ ok: false, reason: e instanceof Error ? e.message : String(e) }); },
        );
        return () => { live = false; };
    }, [stage, tynnProjects]);
    const [name, setName] = useState('');
    const [parent, setParent] = useState(primaryWorkspace);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Every opening starts at the chooser, with the folder from the setting as it is now.
    useEffect(() => { if (open) { setStage('source'); setName(''); setParent(primaryWorkspace); setError(null); setBusy(false); setProjectId(null); } }, [open, primaryWorkspace]);
    return (
        <Modal open={open} onClose={onClose} size="lg">
            <Modal.Header><span className="flex items-center gap-2"><Icon name="folder-plus" size="sm" />Add workspace</span></Modal.Header>
            <Modal.Body>
                {stage === 'source' ? (
                    <AddWorkspaceSource onNew={() => setStage('new')} onOpenExisting={onOpenExisting} onGit={onGit} onTynn={onTynn} />
                ) : (
                    <NewWorkspaceForm
                        name={name}
                        parent={parent}
                        sep={sep}
                        busy={busy}
                        error={error}
                        {...(tynnProjects ? { tynn, projectId, onProject: setProjectId } : {})}
                        onName={(n) => { setName(n); setError(null); }}
                        onBrowse={() => { void browseParent(parent).then((p) => { if (p) { setParent(p); setError(null); } }); }}
                        onCreate={() => {
                            setBusy(true);
                            setError(null);
                            void create(name, parent, projectId ?? undefined)
                                .then((r) => { if (r.ok) onClose(); else setError(r.reason); })
                                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                                .finally(() => setBusy(false));
                        }}
                        onCancel={() => setStage('source')}
                    />
                )}
            </Modal.Body>
        </Modal>
    );
}
