import { Icon, Modal } from '@particle-academy/react-fancy';
import { useEffect, useState, type ReactNode } from 'react';
import { newWorkspaceProblem, workspaceFolderName } from '../../core/add-workspace.js';
import { defaultRemoteChoice, remoteChoiceProblem, type Published, type RemoteChoice } from '../../core/agi-remote.js';
import type { GithubView } from '../../core/github.js';
import { PublishedView, RemoteChoiceView, type GithubAsk } from './AgiRemoteChoice.js';
import { TynnProjectLink, type TynnLinkApi } from './TynnProjectLink.js';

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
    /** Where it is kept (Add workspace parity 10 + 11): None / GitHub / Paste URL. Absent = the form has no such choice. */
    readonly remote?: RemoteChoice | undefined;
    readonly github?: GithubView | null | undefined;
    readonly onRemote?: ((choice: RemoteChoice) => void) | undefined;
    readonly onGithub?: ((ask: GithubAsk) => void) | undefined;
    /** Genie 1's optional "Project (optional)" Tynn link (TynnProjectLink); absent = this host has no Tynn to ask. */
    readonly tynnLink?: ReactNode;
}

/** Genie 1's New workspace form: Workspace name, Folder (+ Browse), where it lands, an optional Tynn project, where it is kept, Create workspace. */
export function NewWorkspaceForm({ name, parent, sep, busy, error, onName, onBrowse, onCreate, onCancel, remote, github, onRemote, onGithub, tynnLink }: NewWorkspaceFormProps) {
    const folder = workspaceFolderName(name);
    const ready = newWorkspaceProblem(name, parent) === null && (!remote || remoteChoiceProblem(remote) === null) && !busy;
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
            {tynnLink ?? null}
            {remote && onRemote ? <RemoteChoiceView choice={remote} github={github ?? null} folder={folder} onChoice={onRemote} onGithub={onGithub ?? (() => {})} /> : null}
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
    /** Make it; `published` = what happened with its remote (Add workspace parity 11), when one was chosen. `tynnProjectId`: the optional link (parity 5). */
    readonly create: (name: string, parent: string, remote: RemoteChoice, tynnProjectId?: string) => Promise<{ ok: true; id: string; path: string; published?: Published } | { ok: false; reason: string }>;
    /** The GitHub sign-in, as Settings shows it; `null` = none to show (the remote choice defaults to None). */
    readonly github: GithubView | null;
    readonly onGithub: (ask: GithubAsk) => void;
    /** Made (and, after a partial success, the person pressed Open workspace): open it. */
    readonly onCreated: (id: string) => void;
    /** The person's Tynn projects (and, on a host that can, creating one) for the optional link. Absent = no picker. */
    readonly tynn?: TynnLinkApi | undefined;
    readonly onOpenExisting: () => void;
    readonly onGit: () => void;
    readonly onTynn: () => void;
    readonly onClose: () => void;
}

export function AddWorkspaceModal({ open, primaryWorkspace, sep, browseParent, create, github, onGithub, onCreated, tynn, onOpenExisting, onGit, onTynn, onClose }: AddWorkspaceModalProps) {
    const [stage, setStage] = useState<'source' | 'new'>('source');
    const [projectId, setProjectId] = useState<string | null>(null);
    const [name, setName] = useState('');
    const [parent, setParent] = useState(primaryWorkspace);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Untouched, the choice follows the GitHub sign-in as it loads (None without one); once picked, the person's pick stays.
    const [picked, setPicked] = useState<RemoteChoice | null>(null);
    const remote = picked ?? defaultRemoteChoice(github);
    // A partial success (Genie 1's "<name> is ready"): the workspace is made; GitHub, git or Tynn did not go to plan.
    const [partial, setPartial] = useState<{ id: string; path: string; published: Published } | null>(null);
    // Every opening starts at the chooser, with the folder from the setting as it is now.
    useEffect(() => { if (open) { setStage('source'); setName(''); setParent(primaryWorkspace); setError(null); setBusy(false); setPicked(null); setPartial(null); setProjectId(null); } }, [open, primaryWorkspace]);
    return (
        <Modal open={open} onClose={onClose} size="lg">
            <Modal.Header><span className="flex items-center gap-2"><Icon name="folder-plus" size="sm" />Add workspace</span></Modal.Header>
            <Modal.Body>
                {partial ? (
                    <PublishedView name={name.trim()} path={partial.path} published={partial.published} onGithub={onGithub} onOpen={() => { onCreated(partial.id); onClose(); }} />
                ) : stage === 'source' ? (
                    <AddWorkspaceSource onNew={() => setStage('new')} onOpenExisting={onOpenExisting} onGit={onGit} onTynn={onTynn} />
                ) : (
                    <NewWorkspaceForm
                        name={name}
                        parent={parent}
                        sep={sep}
                        busy={busy}
                        error={error}
                        onName={(n) => { setName(n); setError(null); }}
                        onBrowse={() => { void browseParent(parent).then((p) => { if (p) { setParent(p); setError(null); } }); }}
                        remote={remote}
                        github={github}
                        onRemote={(c) => { setPicked(c); setError(null); }}
                        onGithub={onGithub}
                        onCreate={() => {
                            setBusy(true);
                            setError(null);
                            void create(name, parent, remote, projectId ?? undefined)
                                .then((r) => {
                                    if (!r.ok) { setError(r.reason); return; }
                                    if (r.published && r.published.problems.length > 0) { setPartial({ id: r.id, path: r.path, published: r.published }); return; }
                                    onCreated(r.id);
                                    onClose();
                                })
                                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                                .finally(() => setBusy(false));
                        }}
                        onCancel={() => setStage('source')}
                        tynnLink={tynn ? <TynnProjectLink api={tynn} projectId={projectId} onProject={(id) => { setProjectId(id); setError(null); }} /> : undefined}
                    />
                )}
            </Modal.Body>
        </Modal>
    );
}
