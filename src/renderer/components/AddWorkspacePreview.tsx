import { useState } from 'react';
import { filterRepos, type AccessibleRepo, type RepoListing } from '../../core/github.js';
import type { FolderKind, PlanStep } from '../../core/workspace-model.js';
import type { TynnContent, TynnProject } from '../../core/tynn.js';

/**
 * ADDING A FOLDER, PREVIEWED (§6.1) — what Genie found the folder to be and every step it would take,
 * the ones that WRITE marked, before anything is written. Confirm does the plan; Cancel does nothing.
 * A refusal shows its reason and offers only to pick again.
 */

export type AddPreviewView =
    | { ok: true; path: string; kind: FolderKind; steps: readonly PlanStep[]; source?: 'git'; url?: string; parent?: string }
    /** From Tynn (§6.1): the project's envelope, or a new one with its repos, or an empty one; the link is recorded in project.json. */
    | { ok: true; path: string; kind: FolderKind; steps: readonly PlanStep[]; source: 'tynn'; project: TynnProject; host: string; parent: string; content?: TynnContent }
    | { ok: false; reason: string };

const KIND_LABEL: Record<FolderKind, string> = {
    empty: 'an empty folder — Genie will set up a new envelope here',
    'simple-repo': 'a plain git repo — Genie will wrap it as an envelope with this folder as the host repo',
    'pre-init': 'a folder already laid out for an envelope, missing its manifest',
    'full-envelope': 'a full envelope — Genie will register it, stamping the schema only if it is older',
    missing: 'a folder that does not exist',
    other: 'a folder Genie cannot classify',
};

/** What a Tynn project brings (core/tynn.ts tynnContent), in words, before Confirm. */
function tynnContentWords(content: TynnContent | undefined): string {
    if (content?.kind === 'envelope') return `Tynn names its envelope, ${content.url}${content.branch ? ` (branch ${content.branch})` : ''}: Genie clones it with its submodules and links it back to the project.`;
    if (content?.kind === 'repos') {
        const n = content.repos.length;
        return `Tynn lists ${n} ${n === 1 ? 'repository' : 'repositories'} for it: Genie makes a new envelope, adds each as a submodule under repos/, and links it back to the project.`;
    }
    return 'Tynn lists no repositories for it: Genie makes a new envelope with its first commit, linked back to the project.';
}

/** Rows the browser draws at once; past this the person narrows it with the search (the whole list stays searchable). */
export const REPO_BROWSER_ROWS = 200;

export type GithubBrowseAsk = 'sign-in' | 'install';

export interface GithubRepoBrowserProps {
    /** `null` = being read from GitHub. */
    readonly listing: RepoListing | null;
    readonly query: string;
    /** The URL in the box, so the repository it names is marked as chosen. */
    readonly selectedUrl: string;
    readonly onQuery: (query: string) => void;
    readonly onPick: (repo: AccessibleRepo) => void;
    readonly onReload: () => void;
    readonly onGithub: (ask: GithubBrowseAsk) => void;
}

const browserBox = 'flex flex-col gap-2 rounded-lg border border-[var(--border-1)] bg-[var(--bg-0)] p-3';
const smallButton = 'rounded-md border border-[var(--border-1)] px-2.5 py-1 text-xs hover:bg-[var(--bg-2)]';
const smallMuted = 'text-xs text-[var(--fg-3)]';

/**
 * IMPORT FROM GIT'S BROWSER (Add workspace parity item 8; Genie 1's InteractiveUpgradeWizard :989-1068): the repositories
 * the GitHub sign-in reaches — every installation, every page (main/github-account.ts repoListing) — searchable, each
 * marked private or public; picking one puts its clone URL in the box. Signed out or not installed it says so and offers
 * the fix, as the remote choice does. Hook-free, so a test can render and press it.
 */
export function GithubRepoBrowser({ listing, query, selectedUrl, onQuery, onPick, onReload, onGithub }: GithubRepoBrowserProps) {
    if (listing === null) {
        return <div data-repo-browser="loading" className={browserBox}><span className={smallMuted}>Reading the repositories your GitHub sign-in reaches…</span></div>;
    }
    if (listing.status === 'signed-out') {
        return (
            <div data-repo-browser="signed-out" className={browserBox}>
                <span className={smallMuted}>Sign in to GitHub to pick from your repositories, private ones included. Meanwhile, paste any git URL below.</span>
                <div><button type="button" data-action="github-sign-in" onClick={() => onGithub('sign-in')} className={smallButton}>Sign in to GitHub…</button></div>
            </div>
        );
    }
    if (listing.status === 'not-installed') {
        return (
            <div data-repo-browser="not-installed" className={browserBox}>
                <span className={smallMuted}>The Genie AOS app is not installed on any of your GitHub accounts yet, so there are no repositories to list. Install it on the accounts and repositories Genie should reach, then check again.</span>
                <div className="flex gap-2">
                    <button type="button" data-action="github-install" onClick={() => onGithub('install')} className={smallButton}>Install Genie on GitHub…</button>
                    <button type="button" data-action="repos-reload" onClick={onReload} className={smallButton}>Check again</button>
                </div>
            </div>
        );
    }
    if (listing.status === 'failed') {
        return (
            <div data-repo-browser="failed" className={browserBox}>
                <span className="text-xs text-[var(--danger)]">{listing.message}</span>
                <div><button type="button" data-action="repos-reload" onClick={onReload} className={smallButton}>Try again</button></div>
            </div>
        );
    }
    const matches = filterRepos(listing.repos, query);
    const shown = matches.slice(0, REPO_BROWSER_ROWS);
    const chosen = selectedUrl.trim();
    return (
        <div data-repo-browser="listed" className={browserBox}>
            <div className="flex items-center gap-2">
                <input data-field="repo-search" aria-label="Search your repositories" value={query} placeholder={`Search ${listing.repos.length} repositories…`} onChange={(e) => onQuery(e.target.value)} className="min-w-0 flex-1 rounded-md border border-[var(--border-1)] bg-transparent px-2 py-1 text-xs" />
                <button type="button" data-action="repos-reload" onClick={onReload} className={smallButton}>Refresh</button>
            </div>
            {shown.length === 0 ? (
                <span className={smallMuted}>{listing.repos.length === 0 ? 'Your GitHub sign-in reaches no repositories yet.' : 'No repository matches that search.'}</span>
            ) : (
                <ul className="flex max-h-56 flex-col overflow-y-auto">
                    {shown.map((r) => (
                        <li key={r.fullName}>
                            <button type="button" data-repo-pick={r.fullName} aria-pressed={r.cloneUrl === chosen} onClick={() => onPick(r)} className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-[var(--bg-2)] ${r.cloneUrl === chosen ? 'bg-[var(--bg-2)]' : ''}`}>
                                <span className="font-mono">{r.fullName}</span>
                                <span data-repo-private={r.private ? 'true' : 'false'} className={smallMuted}>{r.private ? 'Private' : 'Public'}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {matches.length > shown.length ? <span className={smallMuted}>Showing {shown.length} of {matches.length}; search to find the rest.</span> : null}
            {listing.truncated ? <span data-repos-truncated="" className={smallMuted}>GitHub has more repositories than Genie reads at once; search above, or paste the URL below.</span> : null}
        </div>
    );
}

export interface AddFromGitViewProps {
    readonly url: string;
    readonly query: string;
    /** The browser's listing; `null` = loading; `undefined` = this host cannot list (the URL box alone, as before). */
    readonly repos: RepoListing | null | undefined;
    readonly busy: boolean;
    readonly onUrl: (url: string) => void;
    readonly onQuery: (query: string) => void;
    readonly onPreview: (url: string) => void;
    readonly onCancel: () => void;
    readonly onReloadRepos: () => void;
    readonly onGithub: (ask: GithubBrowseAsk) => void;
}

/**
 * IMPORT FROM GIT (§6.1; Add workspace parity items 7 + 8): pick one of your GitHub repositories, or type any git URL; then
 * Genie clones it to a STAGING folder and reads it, and the same wizard as Open existing folder builds a new workspace
 * from it (Genie 1 cloned, then analysed). The person's folders are not written until they confirm the wizard's last
 * step; the staging clone is removed afterwards. Hook-free; AddFromGitForm holds the state.
 *
 * The box is `type="text"`, not `url`: a browser's url check refuses `git@host:owner/name.git`, which is a git URL.
 */
export function AddFromGitView({ url, query, repos, busy, onUrl, onQuery, onPreview, onCancel, onReloadRepos, onGithub }: AddFromGitViewProps) {
    const button = 'rounded-lg border border-[var(--border-1)] px-3 py-1.5 text-sm';
    return (
        <form data-form="add-from-git" className="mx-auto my-4 flex max-w-xl flex-col gap-3 rounded-xl border border-[var(--border-1)] bg-[var(--bg-1)] p-4 text-sm" onSubmit={(e) => { e.preventDefault(); const u = url.trim(); if (u && !busy) onPreview(u); }}>
            <p className="font-semibold">Add a workspace from a git repository</p>
            {repos !== undefined ? GithubRepoBrowser({ listing: repos, query, selectedUrl: url, onQuery, onPick: (r) => onUrl(r.cloneUrl), onReload: onReloadRepos, onGithub }) : null}
            <input name="url" type="text" aria-label="Git URL" value={url} onChange={(e) => onUrl(e.target.value)} placeholder="https://github.com/owner/name.git or git@host:owner/name.git" className="rounded-md border border-[var(--border-1)] bg-transparent px-2 py-1 font-mono text-xs" />
            <p className="text-xs text-[var(--fg-3)]">Genie clones it to a staging folder and reads it; then you choose what goes into the new workspace and where it lives. Nothing of yours is written until you confirm.</p>
            <div className="flex gap-2">
                <button type="submit" data-action="clone-and-read" disabled={busy} className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm text-white disabled:opacity-60">{busy ? 'Cloning…' : 'Clone and read it'}</button>
                <button type="button" className={button} onClick={onCancel}>Cancel</button>
            </div>
        </form>
    );
}

/** AddFromGitView with its URL and search held here; the listing and the asks come from the window (App.tsx). */
export function AddFromGitForm({ onPreview, onCancel, busy = false, repos, onReloadRepos = () => {}, onGithub = () => {} }: { onPreview: (url: string) => void; onCancel: () => void; busy?: boolean | undefined; repos?: RepoListing | null | undefined; onReloadRepos?: (() => void) | undefined; onGithub?: ((ask: GithubBrowseAsk) => void) | undefined }) {
    const [url, setUrl] = useState('');
    const [query, setQuery] = useState('');
    return AddFromGitView({ url, query, repos, busy, onUrl: setUrl, onQuery: setQuery, onPreview, onCancel, onReloadRepos, onGithub });
}

/**
 * `busy` (parity row 25): the confirmed add is running — the button is disabled and says what is happening, so a double
 * click cannot start a second clone into the same folder (src/renderer/add-confirm.ts refuses it as well).
 */
export function AddWorkspacePreview({ preview, busy = false, onConfirm, onCancel, onConfirmGit, onConfirmTynn }: { preview: AddPreviewView; busy?: boolean | undefined; onConfirm: (path: string) => void; onCancel: () => void; onConfirmGit?: ((url: string, parent: string) => void) | undefined; onConfirmTynn?: ((parent: string, projectId: string) => void) | undefined }) {
    const button = 'rounded-lg border border-[var(--border-1)] px-3 py-1.5 text-sm';
    if (!preview.ok) {
        return (
            <section data-add-preview="refused" className="mx-auto my-4 flex max-w-xl flex-col gap-3 rounded-xl border border-[var(--danger)] p-4 text-sm">
                <p className="font-semibold">Genie will not add that folder</p>
                <p className="text-[var(--fg-2)]">{preview.reason}</p>
                <div><button type="button" className={button} onClick={onCancel}>Pick another folder</button></div>
            </section>
        );
    }
    return (
        <section data-add-preview={preview.kind} {...(preview.source ? { 'data-add-source': preview.source } : {})} className="mx-auto my-4 flex max-w-xl flex-col gap-3 rounded-xl border border-[var(--border-1)] bg-[var(--bg-1)] p-4 text-sm">
            <p className="font-semibold">Add <span className="font-mono">{preview.path}</span>?</p>
            {preview.source === 'git' ? <p className="text-[var(--fg-2)]">From <span className="font-mono">{preview.url}</span> — cloned into this folder first. Nothing is cloned until you confirm.</p> : null}
            {preview.source === 'tynn' ? (
                <p data-tynn-content={preview.content?.kind ?? 'empty'} className="text-[var(--fg-2)]">
                    From Tynn project <span className="font-medium text-[var(--fg-1)]">{preview.project.name}</span> at <span className="font-mono">{preview.host}</span> — {tynnContentWords(preview.content)} Nothing is written until you confirm.
                </p>
            ) : null}
            <p className="text-[var(--fg-2)]">This is {KIND_LABEL[preview.kind]}. Nothing has been written yet. Genie would:</p>
            <ol className="flex flex-col gap-1 pl-5">
                {preview.steps.map((s, i) => (
                    <li key={`${s.action}-${i}`} data-step-writes={s.writes ? 'true' : 'false'} className="list-decimal">
                        <span>{s.action}</span>
                        {s.writes ? <span className="ml-2 font-mono text-[11px] text-[var(--warning)]">writes</span> : <span className="ml-2 font-mono text-[11px] text-[var(--fg-4)]">no write</span>}
                    </li>
                ))}
            </ol>
            <div className="flex gap-2">
                <button type="button" data-action="confirm-add" disabled={busy} className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm text-white disabled:opacity-60" onClick={() => (busy ? undefined : preview.source === 'tynn' && onConfirmTynn ? onConfirmTynn(preview.parent, preview.project.id) : preview.source === 'git' && preview.url && preview.parent !== undefined && onConfirmGit ? onConfirmGit(preview.url, preview.parent) : onConfirm(preview.path))}>{preview.source === 'tynn' ? (preview.content?.kind === 'envelope' ? (busy ? 'Cloning…' : 'Clone and add') : busy ? 'Creating…' : 'Create and add') : preview.source === 'git' ? (busy ? 'Cloning…' : 'Clone and add') : busy ? 'Adding…' : 'Add this workspace'}</button>
                <button type="button" className={button} onClick={onCancel}>Cancel</button>
            </div>
        </section>
    );
}
