import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Select } from '@particle-academy/react-fancy';
import { CommitComposer, DiffViewer, WorkingTree } from '@particle-academy/fancy-git-ui';
import type { ChangeKind, WorkingTreeStatus } from '@particle-academy/fancy-git';
import type { RepoChangeLabel, RepoStatus } from '../../main/repo-model.js';
import type { GenieBridge } from '../bridge.js';

/**
 * THE REPOSITORY PANEL (beta.33 item 14; Genie 1 renderer/components/Plugins/RepoChangesPanel.tsx) — the Repository official
 * plugin's panel. Built only from Fancy components: fancy-git-ui's WorkingTree / CommitComposer / DiffViewer and react-fancy's
 * Button / Select / Input. Every action is the person's own click; the git runs on the host that holds the workspace
 * (main/repo-git.ts), and a failure is said in git's own words. Nothing destructive (no force push, no reset) is offered.
 */

/** fancy-git has no `typechange`: a mode change reads as a modification (Genie 1 repo-status-model). */
const kindOf = (label: RepoChangeLabel): ChangeKind => (label === 'typechange' ? 'modified' : label);

export function workingTreeStatusFrom(status: RepoStatus): WorkingTreeStatus {
    return {
        branch: status.branch,
        upstream: status.upstream,
        ahead: status.ahead,
        behind: status.behind,
        clean: status.changes.length === 0,
        files: status.changes.map((c) => ({ path: c.path, index: c.staged ? kindOf(c.label) : null, worktree: c.unstaged ? kindOf(c.label) : null })),
    };
}

export interface RepoChangesActions {
    readonly pickRepo?: (rel: string) => void;
    readonly select?: (paths: string[]) => void;
    readonly stage?: (paths: string[]) => void;
    readonly unstage?: (paths: string[]) => void;
    readonly draft?: (draft: { message: string; description?: string }) => void;
    readonly commit?: () => void;
    readonly push?: () => void;
    readonly pull?: () => void;
    readonly refresh?: () => void;
    readonly branch?: (name: string) => void;
}

export interface RepoChangesViewProps {
    readonly repos: readonly { rel: string; name: string }[];
    readonly repoRel: string;
    readonly status: RepoStatus | null;
    readonly selected: string[];
    readonly diff: string | null;
    readonly busy: boolean;
    readonly error: string | null;
    readonly notice: string | null;
    readonly draft: { message: string; description?: string };
    readonly on: RepoChangesActions;
}

/** The panel as drawn — pure, so it is rendered in a test. */
export function RepoChangesView({ repos, repoRel, status, selected, diff, busy, error, notice, draft, on }: RepoChangesViewProps) {
    const [newBranch, setNewBranch] = useState('');
    const wt = status ? workingTreeStatusFrom(status) : null;
    return (
        <section data-repo-panel={repoRel} className="flex h-full min-h-0 flex-col text-[13px]">
            <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-1)] px-3 py-1.5">
                {repos.length > 1 ? <Select aria-label="Repository" list={repos.map((r) => ({ value: r.rel, label: r.name }))} value={repoRel} onValueChange={(v) => on.pickRepo?.(v)} /> : null}
                <span data-repo-branch="" className="font-mono text-xs">
                    {status?.detached ? 'detached HEAD' : (status?.branch ?? '—')}
                    {status && status.ahead > 0 ? <span data-ahead={status.ahead} className="ml-1.5 text-[var(--fg-3)]">↑{status.ahead}</span> : null}
                    {status && status.behind > 0 ? <span data-behind={status.behind} className="ml-1 text-[var(--fg-3)]">↓{status.behind}</span> : null}
                    {status?.upstream ? <span className="ml-1.5 text-[var(--fg-4)]">{status.upstream}</span> : null}
                </span>
                <span className="flex-1" />
                <Button size="sm" variant="ghost" data-action="repo-refresh" disabled={busy} onClick={() => on.refresh?.()}>Refresh</Button>
                <Button size="sm" variant="ghost" data-action="repo-pull" disabled={busy} onClick={() => on.pull?.()} title="Pull — fast-forward only, never a merge commit">Pull</Button>
                <Button size="sm" variant="ghost" data-action="repo-push" disabled={busy} onClick={() => on.push?.()} title="Push this branch and set its upstream">Push</Button>
            </header>
            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-1)] px-3 py-1.5">
                <Input size="sm" aria-label="New branch name" placeholder="New branch name…" value={newBranch} onValueChange={setNewBranch} onKeyDown={(e) => { if (e.key === 'Enter' && newBranch.trim()) { on.branch?.(newBranch.trim()); setNewBranch(''); } }} />
                <Button size="sm" variant="ghost" data-action="repo-branch" disabled={busy || !newBranch.trim()} onClick={() => { on.branch?.(newBranch.trim()); setNewBranch(''); }}>Create branch</Button>
            </div>
            {error ? <p role="alert" data-repo-error="" className="m-2 rounded-md border border-[var(--danger)] p-2 font-mono text-xs">{error}</p> : null}
            {notice && !error ? <p data-repo-notice="" className="mx-3 mt-2 text-xs text-[var(--success)]">{notice}</p> : null}
            <div className="flex min-h-0 flex-1">
                <div className="flex w-[320px] shrink-0 flex-col gap-2 overflow-auto border-r border-[var(--border-1)] p-2">
                    {wt ? <WorkingTree value={wt} selectedPaths={selected} onSelectedPathsChange={(p) => on.select?.(p)} onStage={(p) => on.stage?.(p)} onUnstage={(p) => on.unstage?.(p)} pending={busy} /> : <p className="text-xs text-[var(--fg-3)]">{error ? '' : 'Reading the repository…'}</p>}
                    {wt?.clean ? <p className="text-xs text-[var(--fg-3)]">Nothing to commit — the working tree is clean.</p> : null}
                    <CommitComposer value={draft} onChange={(d) => on.draft?.(d)} onSubmit={() => on.commit?.()} pending={busy} />
                </div>
                <div className="min-w-0 flex-1 overflow-auto">
                    {selected.length === 1 && diff !== null ? <DiffViewer value={diff} mode="split" /> : <p className="p-3 text-xs text-[var(--fg-3)]">{selected.length === 1 ? 'An untracked file has no diff yet — stage it to review.' : 'Select one changed file to review its diff.'}</p>}
                </div>
            </div>
        </section>
    );
}

type RepoBridge = NonNullable<GenieBridge['repo']>;

/** The panel's wiring: the repo picked, its status, the selection, the diff, and every action through the host. */
export function RepoChangesPanel({ workspaceId, repo, files }: { workspaceId: string; repo: RepoBridge | undefined; files?: Pick<GenieBridge['files'], 'watch' | 'onChange'> | undefined }) {
    const [repos, setRepos] = useState<readonly { rel: string; name: string }[]>([]);
    const [repoRel, setRepoRel] = useState('');
    const [status, setStatus] = useState<RepoStatus | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
    const [diff, setDiff] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [draft, setDraft] = useState<{ message: string; description?: string }>({ message: '' });

    useEffect(() => {
        if (!repo) return;
        let alive = true;
        void repo.call('list', workspaceId, '').then((r) => {
            if (!alive) return;
            if (!r.ok) { setError(r.error); return; }
            const list = r.value as { rel: string; name: string }[];
            setRepos(list);
            setRepoRel((cur) => (list.some((x) => x.rel === cur) ? cur : (list[0]?.rel ?? '')));
            if (list.length === 0) setError('This workspace is not a git repository, and its project.json names none that are checked out.');
        });
        return () => { alive = false; };
    }, [repo, workspaceId]);

    const refresh = useCallback(async () => {
        if (!repo) return;
        const r = await repo.call('status', workspaceId, repoRel);
        if (r.ok) { setStatus(r.value as RepoStatus); setError(null); } else { setStatus(null); setError(r.error); }
    }, [repo, workspaceId, repoRel]);
    useEffect(() => { if (repos.length > 0) void refresh(); }, [refresh, repos.length]);
    // Live: the host's watcher pushes every change on disk (an agent's write, a commit elsewhere), never a poll.
    useEffect(() => {
        if (!files || repos.length === 0) return;
        void files.watch(workspaceId);
        return files.onChange((id) => { if (id === workspaceId) void refresh(); });
    }, [files, workspaceId, refresh, repos.length]);

    const changes = useMemo(() => new Map((status?.changes ?? []).map((c) => [c.path, c])), [status]);
    useEffect(() => {
        const path = selected.length === 1 ? selected[0]! : null;
        if (!repo || !path) { setDiff(null); return; }
        const c = changes.get(path);
        let alive = true;
        // Only-staged content shows its staged diff; otherwise the working tree's is the one that matters.
        void repo.call('diff', workspaceId, repoRel, path, !!c && c.staged && !c.unstaged).then((r) => { if (alive) setDiff(r.ok ? (r.value as { patch: string }).patch || null : null); });
        return () => { alive = false; };
    }, [repo, workspaceId, repoRel, selected, changes]);

    const run = async (label: string, op: () => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>) => {
        setBusy(true); setError(null); setNotice(null);
        try { const r = await op(); if (r.ok) setNotice(label); else setError(r.error); } finally { setBusy(false); await refresh(); }
    };

    if (!repo) return <p className="p-4 text-[13px] text-[var(--fg-3)]">This window has no repository host — the repository lives on the machine that holds the workspace.</p>;
    return (
        <RepoChangesView
            repos={repos} repoRel={repoRel} status={status} selected={selected} diff={diff} busy={busy} error={error} notice={notice} draft={draft}
            on={{
                pickRepo: (rel) => { setRepoRel(rel); setSelected([]); },
                select: setSelected,
                stage: (paths) => void run('Staged', () => repo.call('stage', workspaceId, repoRel, paths)),
                unstage: (paths) => void run('Unstaged', () => repo.call('unstage', workspaceId, repoRel, paths)),
                draft: setDraft,
                commit: () => {
                    const message = draft.message.trim();
                    if (!message) { setError('A commit message is required.'); return; }
                    const full = draft.description?.trim() ? `${message}\n\n${draft.description.trim()}` : message;
                    void run('Committed', () => repo.call('commit', workspaceId, repoRel, full)).then(() => setDraft({ message: '' }));
                },
                push: () => void run('Pushed', () => repo.call('push', workspaceId, repoRel)),
                pull: () => void run('Pulled', () => repo.call('pull', workspaceId, repoRel)),
                refresh: () => void refresh(),
                branch: (name) => void run(`Switched to ${name}`, () => repo.call('branch', workspaceId, repoRel, name)),
            }}
        />
    );
}
