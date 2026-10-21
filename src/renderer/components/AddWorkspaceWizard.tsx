import { Badge, Icon, Modal, Select } from '@particle-academy/react-fancy';
import { useEffect, useState, type ReactNode } from 'react';
import { workspaceFolderName } from '../../core/add-workspace.js';
import { defaultRemoteChoice, remoteChoiceProblem, type Published, type RemoteChoice } from '../../core/agi-remote.js';
import type { GithubView } from '../../core/github.js';
import { OwnerPicker, PublishedView, RemoteChoiceView, type GithubAsk } from './AgiRemoteChoice.js';
import { TynnProjectLink, type TynnLinkApi } from './TynnProjectLink.js';
import {
    buildPlan,
    choosePrimary,
    KNOWLEDGE_TARGETS,
    patchRepo,
    planProblem,
    renameWorkspace,
    repoNamesProblem,
    setMonorepoMode,
    sourceOptions,
    startDraft,
    usesDisposition,
    type Disposition,
    type DispositionRow,
    type EnvelopePlan,
    type KnowledgeRow,
    type OtherEntry,
    type RepoSource,
    type SourceAnalysis,
    type SourceKind,
    type WizardDraft,
} from '../../core/envelope-plan.js';

/**
 * OPEN EXISTING FOLDER / IMPORT FROM GIT — GENIE 1'S FOUR STEPS (Add workspace parity item 7; Genie 1's
 * InteractiveUpgradeWizard): Source → Repos → Knowledge → Workspace, then a NEW `<slug>.agi` beside the source with its
 * repos as submodules and its knowledge copied in. The source is read, never written. A folder that is already a
 * workspace skips the steps and is only added.
 *
 * Every step is a hook-free view over the draft (core/envelope-plan.ts), so a test can render and press it; the modal holds
 * the draft, the step and the busy state.
 */

const button = 'rounded-md border border-[var(--border-1)] px-3 py-1 text-xs hover:bg-[var(--bg-2)] disabled:opacity-50';
const primaryButton = 'flex items-center gap-1.5 rounded-md bg-[var(--violet-500)] px-3 py-1 text-xs font-medium text-white hover:bg-[var(--violet-400)] disabled:opacity-50';
const chip = (on: boolean) => `rounded-md border px-2.5 py-1 text-xs ${on ? 'border-[var(--violet-400)] bg-[var(--violet-500)]/15 text-[var(--fg-1)]' : 'border-[var(--border-1)] text-[var(--fg-3)] hover:bg-[var(--bg-2)]'}`;
const muted = 'text-xs text-[var(--fg-3)]';
const table = 'w-full border-collapse text-xs [&_td]:border-t [&_td]:border-[var(--border-1)] [&_td]:px-2 [&_td]:py-1.5 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_th]:text-[var(--fg-3)]';
const field = 'rounded-md border border-[var(--border-1)] bg-[var(--bg-0)] px-2 py-1';

export const WIZARD_STEPS = ['Source', 'Repos', 'Knowledge', 'Workspace'] as const;

/** Genie 1's KIND_COPY, its words (Genie 1 said "Single repository" and so on; the GApp line is gone with GApps). */
export const KIND_COPY: Record<SourceKind, { title: string; body: string; icon: string }> = {
    'single-repo': { title: 'Single repository', body: 'This folder is one git repo with no submodules. It becomes the workspace’s ONE repository, and any docs/plans folders can copy into its shared knowledge.', icon: 'git-branch' },
    monorepo: { title: 'Monorepo (git submodules)', body: 'This folder is one git repo that itself bundles git submodules. You can EXPLODE it — each submodule joins the workspace as its own repository — or WRAP it whole as a single one. Choose on the next step.', icon: 'boxes' },
    'repo-collection': { title: 'Collection of repositories', body: 'This folder is not a repo itself, but it contains git repos. Each one joins the workspace as its own repository — pick which to include on the next step.', icon: 'folder-git-2' },
    'plain-folder': { title: 'Plain folder', body: 'No git repos found at the top level. Genie can still make a workspace here and copy your notes into its shared knowledge — repositories can be added later.', icon: 'folder' },
};

const SOURCE_LABEL: Record<RepoSource, string> = { origin: 'Origin (clone)', local: 'Local path', fork: 'Fork on GitHub' };

export function WizardStepper({ step, onStep }: { step: number; onStep: (i: number) => void }) {
    return (
        <ol data-wizard-steps="" className="flex items-center gap-2 text-xs">
            {WIZARD_STEPS.map((name, i) => (
                <li key={name} className="flex items-center gap-2">
                    <button type="button" data-wizard-step={name} aria-current={i === step ? 'step' : undefined} onClick={() => onStep(i)} className={chip(i === step)}>
                        {i + 1}. {name}
                    </button>
                    {i < WIZARD_STEPS.length - 1 ? <Icon name="chevron-right" size="xs" /> : null}
                </li>
            ))}
        </ol>
    );
}

/** Step 1 — what Genie found. The source is named, and so is the promise: it is read, never changed. */
export function SourceStepView({ analysis, staged, url }: { analysis: SourceAnalysis; staged: boolean; url?: string | undefined }) {
    const kind = KIND_COPY[analysis.sourceKind];
    const n = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;
    return (
        <div data-wizard-source={analysis.sourceKind} className="flex flex-col gap-3">
            <p className={muted}>
                {staged ? <>Cloned <span className="font-mono">{url}</span> to a staging folder to read it. </> : <>Read <span className="font-mono">{analysis.root}</span>. </>}
                Genie never changes it: the new workspace is a separate folder, its repositories are cloned from this one or from their remotes, and knowledge is copied out.
            </p>
            <div className="flex items-start gap-3 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] p-3">
                <span className="text-[var(--violet-400)]"><Icon name={kind.icon} size="md" /></span>
                <div className="flex flex-col gap-1">
                    <span data-kind-title="" className="text-sm font-semibold">{kind.title}</span>
                    <span className={muted}>{kind.body}</span>
                    <span data-found="" className={muted}>Found: {n(analysis.repos.length, 'repo')} · {n(analysis.knowledge.length, 'knowledge candidate')} · {n(analysis.other.length, 'other item')}</span>
                </div>
            </div>
        </div>
    );
}

export interface ReposStepProps {
    readonly draft: WizardDraft;
    readonly onPatch: (key: string, patch: { included?: boolean; name?: string; source?: RepoSource }) => void;
    readonly onMode: (mode: 'explode' | 'wrap') => void;
    readonly onPrimary: (name: string) => void;
    /** The GitHub sign-in: signed in, a GitHub repository may also be forked (Add workspace parity item 12). */
    readonly github?: GithubView | null | undefined;
    /** Where Fork rows go — the owner picker's choice. */
    readonly onForkInto?: ((owner: string) => void) | undefined;
    readonly onGithub?: ((ask: GithubAsk) => void) | undefined;
}

/**
 * Step 2 — Genie 1's repos table: include, `repos/<name>`, Origin, Local or Fork; for a monorepo, explode or wrap and the
 * host. With a Fork row, the owner the forks go to (the remote's owner picker, item 12).
 */
export function ReposStepView({ draft, onPatch, onMode, onPrimary, github = null, onForkInto = () => {}, onGithub = () => {} }: ReposStepProps) {
    const canFork = github?.status === 'signed-in';
    const forking = canFork && draft.repos.some((r) => r.included && r.source === 'fork');
    const kind = draft.analysis.sourceKind;
    const members = draft.analysis.submodules.length;
    const exploding = kind === 'monorepo' && draft.monorepoMode === 'explode';
    const problem = repoNamesProblem(draft.repos);
    return (
        <div data-wizard-repos="" className="flex flex-col gap-3">
            {kind === 'monorepo' ? (
                <div className="flex flex-col gap-1.5">
                    <span className={muted}>This monorepo has {members} member{members === 1 ? '' : 's'}. Choose how to bring it in:</span>
                    <div className="flex gap-2">
                        <button type="button" data-monorepo-mode="explode" aria-pressed={draft.monorepoMode === 'explode'} onClick={() => onMode('explode')} className={chip(draft.monorepoMode === 'explode')}>Explode into {members} submodule{members === 1 ? '' : 's'}</button>
                        <button type="button" data-monorepo-mode="wrap" aria-pressed={draft.monorepoMode === 'wrap'} onClick={() => onMode('wrap')} className={chip(draft.monorepoMode === 'wrap')}>Wrap whole (one submodule)</button>
                    </div>
                </div>
            ) : null}
            {draft.repos.length === 0 ? (
                <p className={muted}>No git repos here — the workspace starts without repositories. Repositories can be added at any time.</p>
            ) : (
                <>
                    <p className={muted}>
                        Each becomes a git submodule under <span className="font-mono">repos/</span>. <strong>Origin</strong> clones it from its remote; <strong>Local</strong> from the folder on disk{canFork ? <>; <strong>Fork</strong> forks it on GitHub into the account you choose, and the fork becomes the submodule</> : null}.
                        {exploding ? ' The host is the repo the workspace builds; the rest are packages it uses.' : ''}
                    </p>
                    <table className={table}>
                        <thead>
                            <tr><th /> {exploding ? <th>Host</th> : null}<th>Source</th><th>repos/&lt;name&gt;</th><th>From</th></tr>
                        </thead>
                        <tbody>
                            {draft.repos.map((r) => {
                                const options = sourceOptions(r, draft.staged, canFork);
                                return (
                                    <tr key={r.key} data-repo-row={r.key}>
                                        <td><input type="checkbox" aria-label={`Include ${r.relPath}`} checked={r.included} onChange={(e) => onPatch(r.key, { included: e.target.checked })} /></td>
                                        {exploding ? <td><input type="radio" name="wizard-host" aria-label={`${r.name} is the host`} checked={r.included && r.name.trim() === draft.primary} disabled={!r.included} onChange={() => onPrimary(r.name.trim())} /></td> : null}
                                        <td>
                                            <span className="font-mono">{r.relPath === '.' ? '(this folder)' : `${r.relPath}/`}</span>
                                            {r.headRef ? <span className={`block ${muted}`}>@{r.headRef}</span> : null}
                                        </td>
                                        <td><input data-repo-name={r.key} aria-label={`Name for ${r.relPath}`} value={r.name} onChange={(e) => onPatch(r.key, { name: e.target.value })} className={`${field} font-mono`} /></td>
                                        <td>
                                            {options.length > 0 ? (
                                                <Select list={options.map((o) => ({ value: o, label: SOURCE_LABEL[o] }))} value={r.source} onValueChange={(v) => onPatch(r.key, { source: v as RepoSource })} aria-label={`Where ${r.name} comes from`} />
                                            ) : (
                                                <span data-no-source="" className="text-[var(--danger)]">No remote to clone from</span>
                                            )}
                                            {r.source === 'origin' && r.originUrl ? <span className={`block break-all font-mono text-[10px] ${muted}`}>{r.originUrl}</span> : null}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </>
            )}
            {forking && github ? (
                <div data-fork-into="" className="flex flex-col gap-1.5">
                    {OwnerPicker({ label: 'Fork into', field: 'fork-owner', value: draft.forkInto ?? '', github, why: 'to fork repositories into this account', onOwner: onForkInto, onGithub })}
                    <span className={muted}>GitHub makes each fork first; the workspace is built only once every fork is ready.</span>
                </div>
            ) : null}
            {problem ? <p data-repos-problem="" className="text-xs text-[var(--danger)]">{problem}</p> : null}
        </div>
    );
}

const GIT_STATE_HINT: Record<DispositionRow['gitState'], string> = {
    tracked: 'in git — travels with the repo',
    untracked: 'NOT in git — stays behind unless copied',
    ignored: 'gitignored — stays behind unless copied',
};
const GIT_STATE_COLOR = { tracked: 'emerald', untracked: 'amber', ignored: 'zinc' } as const;
const DISPOSITIONS: ReadonlyArray<{ value: Disposition; label: string; short: string }> = [
    { value: 'codebase', label: 'Codebase (stays in repo)', short: 'Codebase' },
    { value: 'knowledge', label: 'Knowledge → .ai/', short: 'Knowledge' },
    { value: 'root', label: 'Workspace root', short: 'Root' },
    { value: 'ignore', label: 'Ignore (leave out)', short: 'Ignore' },
];

/** Step 3, for a source that is a repo — Genie 1's DispositionStep: what each top-level entry becomes, with its git state. */
export function DispositionStepView({ rows, onSet, onSetAll }: { rows: readonly DispositionRow[]; onSet: (relPath: string, patch: { disposition?: Disposition; targetSubdir?: string }) => void; onSetAll: (d: Disposition) => void }) {
    return (
        <div data-wizard-disposition="" className="flex flex-col gap-3">
            <p className={muted}>
                What git tracks already travels with the repo — that is <strong>Codebase</strong>, nothing is copied. What is NOT in git (a gitignored <span className="font-mono">.ai/</span>, loose notes) would be left behind: send it to <strong>Knowledge</strong> (<span className="font-mono">.ai/…</span>) or the workspace <strong>Root</strong>. <strong>Ignore</strong> leaves it out. Everything is copied; the source keeps its own.
            </p>
            <div className="flex items-center gap-1.5">
                <span className={muted}>Set all:</span>
                {DISPOSITIONS.map((d) => <button key={d.value} type="button" data-set-all={d.value} onClick={() => onSetAll(d.value)} className={button}>{d.short}</button>)}
            </div>
            <table className={table}>
                <thead><tr><th>Entry</th><th>Git</th><th>Becomes</th><th>Target</th></tr></thead>
                <tbody>
                    {rows.map((r) => (
                        <tr key={r.relPath} data-disposition-row={r.relPath} data-disposition={r.disposition}>
                            <td className="font-mono">{r.relPath}{r.kind === 'directory' ? '/' : ''}</td>
                            <td><Badge size="sm" variant="soft" color={GIT_STATE_COLOR[r.gitState]} title={GIT_STATE_HINT[r.gitState]} data-git-state={r.gitState}>{r.gitState}</Badge></td>
                            <td><Select list={DISPOSITIONS.map((d) => ({ value: d.value, label: d.label }))} value={r.disposition} onValueChange={(v) => onSet(r.relPath, { disposition: v as Disposition, ...(v === 'knowledge' && !r.targetSubdir ? { targetSubdir: 'knowledge' } : {}) })} aria-label={`What ${r.relPath} becomes`} /></td>
                            <td>
                                {r.disposition === 'knowledge' ? (
                                    <Select list={KNOWLEDGE_TARGETS.map((t) => ({ value: t.value, label: t.label }))} value={r.targetSubdir} onValueChange={(v) => onSet(r.relPath, { targetSubdir: v })} aria-label={`Where in .ai/ ${r.relPath} goes`} />
                                ) : (
                                    <span className={muted}>{r.disposition === 'root' ? `/${r.relPath}${r.kind === 'directory' ? '/' : ''}` : r.disposition === 'ignore' ? 'left out' : '—'}</span>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/** Step 3, for a collection or a plain folder — Genie 1's KnowledgeStep: the knowledge-shaped entries, each copied to `.ai/<target>`. */
export function KnowledgeStepView({ rows, other, onPatch }: { rows: readonly KnowledgeRow[]; other: readonly OtherEntry[]; onPatch: (relPath: string, patch: { included?: boolean; targetSubdir?: string }) => void }) {
    return (
        <div data-wizard-knowledge="" className="flex flex-col gap-3">
            <p className={muted}>Folders like plans/, docs/, notes/, .ai/ and loose markdown files. Each is copied into <span className="font-mono">.ai/</span> at the target you pick — the source keeps its own.</p>
            {rows.length === 0 ? (
                <p className={muted}>No knowledge found here. Nothing to choose — go on to the next step.</p>
            ) : (
                <table className={table}>
                    <thead><tr><th /><th>Source</th><th>Into .ai/</th></tr></thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr key={r.relPath} data-knowledge-row={r.relPath}>
                                <td><input type="checkbox" aria-label={`Copy ${r.relPath}`} checked={r.included} onChange={(e) => onPatch(r.relPath, { included: e.target.checked })} /></td>
                                <td className="font-mono">{r.relPath}{r.kind === 'directory' ? '/' : ''}</td>
                                <td><Select list={KNOWLEDGE_TARGETS.map((t) => ({ value: t.value, label: t.label }))} value={r.targetSubdir} onValueChange={(v) => onPatch(r.relPath, { targetSubdir: v })} aria-label={`Where in .ai/ ${r.relPath} goes`} /></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {other.length > 0 ? (
                <details className={muted}>
                    <summary>{other.length} other item{other.length === 1 ? '' : 's'} — stay in the source folder, untouched</summary>
                    <ul className="mt-1 pl-4 font-mono">
                        {other.slice(0, 30).map((o) => <li key={o.relPath}>{o.relPath}{o.kind === 'directory' ? '/' : ''}</li>)}
                        {other.length > 30 ? <li>… and {other.length - 30} more</li> : null}
                    </ul>
                </details>
            ) : null}
        </div>
    );
}

/** Step 4 — the name, where the new workspace lands, an optional Tynn project (Genie 1's), what it will hold, and where it is kept (None / GitHub / Paste URL). */
export function WorkspaceStepView({ draft, sep, onName, onBrowse, remote, github, onRemote, onGithub, tynnLink }: {
    draft: WizardDraft;
    sep: string;
    onName: (name: string) => void;
    onBrowse: () => void;
    remote?: RemoteChoice | undefined;
    github?: GithubView | null | undefined;
    onRemote?: ((choice: RemoteChoice) => void) | undefined;
    onGithub?: ((ask: GithubAsk) => void) | undefined;
    tynnLink?: ReactNode;
}) {
    const plan = buildPlan(draft);
    const folder = workspaceFolderName(draft.name);
    const lands = draft.parent.trim() !== '' && folder !== '' ? `${draft.parent.trim().replace(/[\\/]+$/, '')}${sep}${folder}` : null;
    const copies = plan.knowledge.length;
    return (
        <div data-wizard-workspace="" className="flex flex-col gap-3 text-sm">
            <label className="flex flex-col gap-1">
                <span className="text-xs font-semibold">Workspace name</span>
                <input data-field="workspace-name" value={draft.name} onChange={(e) => onName(e.target.value)} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-0)] px-2.5 py-1.5" />
            </label>
            <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold">Folder</span>
                <div className="flex items-center gap-2">
                    <input data-field="workspace-parent" value={draft.parent} readOnly placeholder="No folder chosen" className="min-w-0 flex-1 rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2.5 py-1.5 font-mono text-xs" />
                    <button type="button" data-action="browse-parent" onClick={onBrowse} className={`${button} flex items-center gap-1.5`}><Icon name="folder" size="xs" />Browse</button>
                </div>
                <span data-lands-at="" className={muted}>{lands ? `Lands at ${lands}` : 'Pick the folder your workspaces live in.'}</span>
            </div>
            {tynnLink ?? null}
            <p data-wizard-summary="" className={muted}>
                {plan.forkInto ? <>Genie first forks {plan.repos.filter((r) => r.fork).length} on GitHub into <strong>{plan.forkInto}</strong> and waits until each fork is ready. Then it </> : 'Genie '}makes the folder and its first commit, adds <strong>{plan.repos.length}</strong> submodule{plan.repos.length === 1 ? '' : 's'}, copies <strong>{copies}</strong> knowledge item{copies === 1 ? '' : 's'}, and commits them. {draft.staged ? 'The staging clone is removed afterwards.' : 'Your folder is not changed.'}
            </p>
            {remote && onRemote ? <RemoteChoiceView choice={remote} github={github ?? null} folder={folder} onChoice={onRemote} onGithub={onGithub ?? (() => {})} /> : null}
        </div>
    );
}

/** A folder that is already a workspace (Genie 1: it has a project.json): nothing to build, it is only added. */
export function ExistingWorkspaceView({ path, staged, url, parent, sep, onBrowse }: { path: string; staged: boolean; url?: string | undefined; parent: string; sep: string; onBrowse: () => void }) {
    const leaf = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
    return (
        <div data-wizard-existing="" className="flex flex-col gap-3 text-sm">
            <p className="font-semibold">This is already a workspace</p>
            {staged ? (
                <>
                    <p className={muted}><span className="font-mono">{url}</span> has a project.json, so it is added as it is. Genie clones it into the folder you choose.</p>
                    <div className="flex items-center gap-2">
                        <input data-field="workspace-parent" value={parent} readOnly placeholder="No folder chosen" className="min-w-0 flex-1 rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2.5 py-1.5 font-mono text-xs" />
                        <button type="button" data-action="browse-parent" onClick={onBrowse} className={`${button} flex items-center gap-1.5`}><Icon name="folder" size="xs" />Browse</button>
                    </div>
                    {parent.trim() ? <span data-lands-at="" className={muted}>Lands at {parent.trim().replace(/[\\/]+$/, '')}{sep}{leaf}</span> : null}
                </>
            ) : (
                <p className={muted}><span className="font-mono">{path}</span> has a project.json, so Genie adds it as it is — nothing is built, and nothing in it is changed (its schema is updated only if it declares an older one, with a backup).</p>
            )}
        </div>
    );
}

export type SourceReadView =
    | { ok: true; existing: true; path: string; staged?: true; url?: string }
    | { ok: true; existing: false; analysis: SourceAnalysis; staged: boolean; url?: string };

type Outcome = { ok: true; id: string } | { ok: false; reason: string };
/** A build: also where its remote went (Add workspace parity 11), when one was chosen. */
type BuildOutcome = { ok: true; id: string; path?: string; published?: Published } | { ok: false; reason: string };

export interface AddWorkspaceWizardProps {
    /** What was read — a folder, or an import's staging clone; `null` = closed. */
    readonly read: SourceReadView | null;
    readonly primaryWorkspace: string;
    readonly sep: string;
    readonly browseParent: (current: string) => Promise<string | null>;
    readonly build: (plan: EnvelopePlan, remote: RemoteChoice) => Promise<BuildOutcome>;
    /** The GitHub sign-in, as Settings shows it; `null` = none to show (the remote choice defaults to None). */
    readonly github?: GithubView | null | undefined;
    readonly onGithub?: ((ask: GithubAsk) => void) | undefined;
    readonly registerExisting: (path: string) => Promise<Outcome>;
    /** An import that turned out to be a workspace already: clone it where the person chose (the ordinary Git add). */
    readonly cloneExisting: (url: string, parent: string) => Promise<Outcome>;
    /** Cancelling an import drops its staging clone. */
    readonly discard: (path: string) => void;
    readonly onAdded: (id: string) => void;
    readonly onClose: () => void;
    /** The optional Tynn project link on the Workspace step (Genie 1's ProjectPicker). Absent = no picker. */
    readonly tynn?: TynnLinkApi | undefined;
}

/** The step a forward move may reach: Repos needs valid names; nothing moves while a build runs. */
export function canLeaveStep(draft: WizardDraft, step: number): boolean {
    return step !== 1 || repoNamesProblem(draft.repos) === null;
}

export function AddWorkspaceWizard({ read, primaryWorkspace, sep, browseParent, build, github = null, onGithub = () => {}, registerExisting, cloneExisting, discard, onAdded, onClose, tynn }: AddWorkspaceWizardProps) {
    const [draft, setDraft] = useState<WizardDraft | null>(null);
    const [projectId, setProjectId] = useState<string | null>(null);
    const [step, setStep] = useState(0);
    const [parent, setParent] = useState(primaryWorkspace);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Untouched, the remote follows the GitHub sign-in as it loads (None without one); once picked, the pick stays.
    const [picked, setPicked] = useState<RemoteChoice | null>(null);
    const remote = picked ?? defaultRemoteChoice(github);
    // Built, but GitHub, git or Tynn did not go to plan: Genie 1's "<name> is ready".
    const [partial, setPartial] = useState<{ id: string; path: string; published: Published } | null>(null);
    // Every new read starts the wizard over, at the Source step, landing beside the Primary workspace (else the source's parent).
    useEffect(() => {
        setStep(0); setBusy(false); setError(null); setPicked(null); setPartial(null); setProjectId(null);
        const sourceParent = read && !read.existing && !read.staged ? read.analysis.root.replace(/[\\/]+[^\\/]+[\\/]*$/, '') : '';
        const start = primaryWorkspace || sourceParent;
        setParent(start);
        setDraft(read && !read.existing ? startDraft(read.analysis, { parent: start, staged: read.staged }) : null);
    }, [read, primaryWorkspace]);
    if (!read) return null;

    const stagedPath = read.existing ? (read.staged ? read.path : null) : read.staged ? read.analysis.root : null;
    const close = () => { if (busy) return; if (stagedPath) discard(stagedPath); onClose(); };
    const finish = (run: () => Promise<Outcome>) => {
        setBusy(true); setError(null);
        void run().then((r) => { if (r.ok) onAdded(r.id); else setError(r.reason); }, (e: unknown) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
    };
    const pickParent = (apply: (p: string) => void, current: string) => { void browseParent(current).then((p) => { if (p) { apply(p); setError(null); } }); };

    let body: ReactNode;
    let footer: ReactNode;
    if (partial && draft) {
        return (
            <Modal open onClose={() => { setPartial(null); onAdded(partial.id); }} size="xl">
                <Modal.Header><span className="flex items-center gap-2"><Icon name="layers" size="sm" />{read.staged ? 'Set up this repository' : 'Set up this folder'}</span></Modal.Header>
                <Modal.Body>
                    <PublishedView name={draft.name.trim()} path={partial.path} published={partial.published} onGithub={onGithub} onOpen={() => { setPartial(null); onAdded(partial.id); }} />
                </Modal.Body>
            </Modal>
        );
    }
    if (read.existing) {
        const ready = !busy && (!read.staged || parent.trim() !== '');
        body = <ExistingWorkspaceView path={read.path} staged={read.staged === true} url={read.url} parent={parent} sep={sep} onBrowse={() => pickParent(setParent, parent)} />;
        footer = (
            <button type="button" data-action="add-existing" disabled={!ready} onClick={() => finish(() => (read.staged && read.url ? (discard(read.path), cloneExisting(read.url, parent)) : registerExisting(read.path)))} className={primaryButton}>
                <Icon name="check" size="xs" />{busy ? 'Adding…' : 'Add workspace'}
            </button>
        );
    } else if (draft) {
        const d = draft;
        // The link rides the plan as an id only; the host looks it up in Tynn's own list before writing anything.
        const plan = { ...buildPlan(d), ...(projectId ? { tynnProjectId: projectId } : {}) };
        const finishProblem = planProblem(plan) ?? remoteChoiceProblem(remote);
        const go = (to: number) => { if (busy) return; if (to < step) { setStep(to); return; } for (let s = step; s < to; s++) if (!canLeaveStep(d, s)) return; setStep(to); };
        const knowledgeStep = usesDisposition(d.analysis.sourceKind) ? (
            <DispositionStepView
                rows={d.dispositions}
                onSet={(rel, patch) => setDraft({ ...d, dispositions: d.dispositions.map((r) => (r.relPath === rel ? { ...r, ...patch } : r)) })}
                onSetAll={(disp) => setDraft({ ...d, dispositions: d.dispositions.map((r) => ({ ...r, disposition: disp, targetSubdir: disp === 'knowledge' && !r.targetSubdir ? 'knowledge' : r.targetSubdir })) })}
            />
        ) : (
            <KnowledgeStepView rows={d.knowledge} other={d.analysis.other} onPatch={(rel, patch) => setDraft({ ...d, knowledge: d.knowledge.map((r) => (r.relPath === rel ? { ...r, ...patch } : r)) })} />
        );
        const views = [
            <SourceStepView key="source" analysis={d.analysis} staged={d.staged} url={read.url} />,
            <ReposStepView
                key="repos"
                draft={d}
                // Choosing Fork with no owner yet starts at the person (Genie 1: the owner picker's default).
                onPatch={(key, patch) => setDraft(patchRepo(patch.source === 'fork' && !d.forkInto && github?.user ? { ...d, forkInto: github.user.login } : d, key, patch))}
                onMode={(m) => setDraft(setMonorepoMode(d, m))}
                onPrimary={(n) => setDraft(choosePrimary(d, n))}
                github={github}
                onForkInto={(owner) => { setDraft({ ...d, forkInto: owner }); setError(null); }}
                onGithub={onGithub}
            />,
            knowledgeStep,
            <WorkspaceStepView key="workspace" draft={d} sep={sep} onName={(n) => { setDraft(renameWorkspace(d, n)); setError(null); }} onBrowse={() => pickParent((p) => setDraft({ ...d, parent: p }), d.parent)} remote={remote} github={github} onRemote={(c) => { setPicked(c); setError(null); }} onGithub={onGithub} tynnLink={tynn ? <TynnProjectLink api={tynn} projectId={projectId} onProject={(id) => { setProjectId(id); setError(null); }} /> : undefined} />,
        ];
        body = (
            <div className="flex flex-col gap-4">
                <WizardStepper step={step} onStep={go} />
                {views[step]}
                {step === WIZARD_STEPS.length - 1 && finishProblem ? <p data-plan-problem="" className="text-xs text-[var(--danger)]">{finishProblem}</p> : null}
            </div>
        );
        footer = (
            <>
                {step > 0 ? <button type="button" data-action="wizard-back" disabled={busy} onClick={() => setStep(step - 1)} className={button}>Back</button> : null}
                {step < WIZARD_STEPS.length - 1 ? (
                    <button type="button" data-action="wizard-next" disabled={busy || !canLeaveStep(d, step)} onClick={() => go(step + 1)} className={primaryButton}>Next<Icon name="arrow-right" size="xs" /></button>
                ) : (
                    <button type="button" data-action="build-workspace" disabled={busy || finishProblem !== null} onClick={() => {
                        setBusy(true); setError(null);
                        void build(plan, remote).then((r) => {
                            if (!r.ok) { setError(r.reason); return; }
                            if (r.published && r.published.problems.length > 0) { setPartial({ id: r.id, path: r.path ?? '', published: r.published }); return; }
                            onAdded(r.id);
                        }, (e: unknown) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
                    }} className={primaryButton}><Icon name="check" size="xs" />{busy ? 'Building the workspace…' : 'Add workspace'}</button>
                )}
            </>
        );
    } else {
        return null;
    }
    return (
        <Modal open onClose={close} size="xl">
            <Modal.Header><span className="flex items-center gap-2"><Icon name="layers" size="sm" />{read.staged ? 'Set up this repository' : 'Set up this folder'}</span></Modal.Header>
            <Modal.Body>
                <div className="flex flex-col gap-3">
                    {body}
                    {error ? <p data-add-error="" className="rounded-md border border-[var(--danger)] bg-[var(--danger)]/10 px-2.5 py-1.5 text-xs">{error}</p> : null}
                    <div className="flex items-center justify-end gap-2">
                        <button type="button" data-action="cancel-add" disabled={busy} onClick={close} className={button}>Cancel</button>
                        <span className="flex-1" />
                        {footer}
                    </div>
                </div>
            </Modal.Body>
        </Modal>
    );
}
