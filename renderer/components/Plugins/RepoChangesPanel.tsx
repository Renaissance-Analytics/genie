import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Select } from '@particle-academy/react-fancy';
import { WorkingTree, CommitComposer, DiffViewer } from '@particle-academy/fancy-git-ui';
import { api, type RepoRef, type RepoResult, type RepoStatus, type WorkspaceRow } from '../../lib/genie';
import { workingTreeStatusFrom } from '../../lib/repo-status-model';

/**
 * The first-party Repository Changes PANEL adapter — the compile-time adapter the
 * `RepoChangesPanel` export resolves to. Built ONLY from vetted, Genie-bundled
 * Fancy components (`WorkingTree` / `CommitComposer` / `DiffViewer` from
 * fancy-git-ui, `Button` / `Select` from react-fancy); it ships no hand-rolled
 * git UI. All git EXECUTION is host-side core Genie IPC (`api().repo.*`),
 * human-initiated and ungated — the plugin's panel is only the seam.
 */

interface Props {
    /** The workspace whose repo(s) this panel browses (its `path` is the root). */
    workspace?: WorkspaceRow;
    /** Fallback root when no workspace row is available (spec.cwd). */
    fallbackRoot: string;
}

function errorOf<T>(r: RepoResult<T>): string | null {
    return r.ok ? null : r.error;
}

export default function RepoChangesPanel({ workspace, fallbackRoot }: Props) {
    const root = workspace?.path ?? fallbackRoot;

    const [repos, setRepos] = useState<RepoRef[]>([]);
    const [repoRel, setRepoRel] = useState<string>('');
    const [status, setStatus] = useState<RepoStatus | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
    const [diffPatch, setDiffPatch] = useState<string | null>(null);
    const [draft, setDraft] = useState<{ message: string; description?: string }>({ message: '' });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [newBranch, setNewBranch] = useState('');
    const [loading, setLoading] = useState(true);

    // Enumerate the selectable repos (workspace root + project.json members).
    useEffect(() => {
        let alive = true;
        void (async () => {
            const res = await api().repo.list(root);
            if (!alive) return;
            if (res.ok) {
                setRepos(res.value);
                setRepoRel((cur) => (res.value.some((r) => r.rel === cur) ? cur : res.value[0]?.rel ?? ''));
            } else {
                setError(res.error);
            }
        })();
        return () => {
            alive = false;
        };
    }, [root]);

    const refresh = useCallback(async () => {
        setLoading(true);
        const res = await api().repo.status(root, repoRel);
        if (res.ok) {
            setStatus(res.value);
            setError(null);
        } else {
            setStatus(null);
            setError(res.error);
        }
        setLoading(false);
    }, [root, repoRel]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const changeByPath = useMemo(
        () => new Map((status?.changes ?? []).map((c) => [c.path, c])),
        [status],
    );

    // Load the unified diff for the single selected file.
    useEffect(() => {
        const path = selected.length === 1 ? selected[0] : null;
        if (!path) {
            setDiffPatch(null);
            return;
        }
        let alive = true;
        void (async () => {
            const change = changeByPath.get(path);
            // A file that has only staged content shows its staged diff; otherwise
            // the working-tree diff is the meaningful one.
            const staged = !!change && change.staged && !change.unstaged;
            const res = await api().repo.diff(root, repoRel, path, staged);
            if (!alive) return;
            setDiffPatch(res.ok ? res.value.patch : '');
        })();
        return () => {
            alive = false;
        };
    }, [selected, changeByPath, root, repoRel]);

    /** Run a mutating op, surface its error, then refresh the status. */
    const run = useCallback(
        async (label: string, op: () => Promise<RepoResult<unknown>>) => {
            setBusy(true);
            setError(null);
            setNotice(null);
            try {
                const res = await op();
                const err = errorOf(res);
                if (err) setError(err);
                else setNotice(label);
            } finally {
                setBusy(false);
                await refresh();
            }
        },
        [refresh],
    );

    const onStage = (paths: string[]) => void run('Staged', () => api().repo.stage(root, repoRel, paths));
    const onUnstage = (paths: string[]) => void run('Unstaged', () => api().repo.unstage(root, repoRel, paths));
    const onCommit = () => {
        const message = draft.message.trim();
        if (!message) {
            setError('A commit message is required.');
            return;
        }
        const full = draft.description?.trim() ? `${message}\n\n${draft.description.trim()}` : message;
        void run('Committed', () => api().repo.commit(root, repoRel, full)).then(() => setDraft({ message: '' }));
    };
    const onPush = () => void run('Pushed', () => api().repo.push(root, repoRel));
    const onPull = () => void run('Pulled', () => api().repo.pull(root, repoRel));
    const onCreateBranch = () => {
        const name = newBranch.trim();
        if (!name) return;
        void run(`Switched to ${name}`, () => api().repo.createBranch(root, repoRel, name)).then(() =>
            setNewBranch(''),
        );
    };

    const wt = useMemo(() => (status ? workingTreeStatusFrom(status) : null), [status]);
    const ahead = status?.ahead ?? 0;
    const behind = status?.behind ?? 0;

    return (
        <div className="repo-panel">
            <div className="repo-panel-head">
                {repos.length > 1 && (
                    <Select
                        value={repoRel}
                        list={repos.map((r) => ({ value: r.rel, label: r.name }))}
                        onValueChange={setRepoRel}
                        aria-label="Repository"
                        data-repo-picker=""
                    />
                )}
                <span className="repo-panel-branch" data-repo-branch="">
                    {status?.detached ? 'detached HEAD' : status?.branch ?? '—'}
                    {(ahead > 0 || behind > 0) && (
                        <span className="repo-panel-track">
                            {ahead > 0 && <span data-ahead="">↑{ahead}</span>}
                            {behind > 0 && <span data-behind="">↓{behind}</span>}
                        </span>
                    )}
                </span>
                <span className="grow" />
                <Button size="sm" variant="ghost" icon="rotate-cw" onClick={() => void refresh()} disabled={busy || loading}>
                    Refresh
                </Button>
                <Button size="sm" variant="ghost" icon="arrow-up" onClick={onPush} disabled={busy}>
                    Push
                </Button>
                <Button size="sm" variant="ghost" icon="arrow-down" onClick={onPull} disabled={busy}>
                    Pull
                </Button>
            </div>

            <div className="repo-panel-branchbar">
                <input
                    className="repo-panel-branch-input"
                    placeholder="New branch name…"
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') onCreateBranch();
                    }}
                    aria-label="New branch name"
                />
                <Button size="sm" variant="ghost" icon="git-branch" onClick={onCreateBranch} disabled={busy || !newBranch.trim()}>
                    Create branch
                </Button>
            </div>

            {error && <div className="repo-panel-error" role="alert" data-repo-error="">{error}</div>}
            {notice && !error && <div className="repo-panel-notice" data-repo-notice="">{notice}</div>}

            <div className="repo-panel-body">
                <div className="repo-panel-left">
                    {wt && (
                        <WorkingTree
                            value={wt}
                            selectedPaths={selected}
                            onSelectedPathsChange={setSelected}
                            onStage={onStage}
                            onUnstage={onUnstage}
                            pending={busy}
                        />
                    )}
                    {wt && wt.clean && <p className="repo-panel-clean">Nothing to commit — working tree clean.</p>}
                    <CommitComposer
                        value={draft}
                        onChange={setDraft}
                        onSubmit={onCommit}
                        pending={busy}
                    />
                </div>
                <div className="repo-panel-right">
                    {selected.length === 1 ? (
                        <DiffViewer value={diffPatch ?? ''} mode="split" hideContext={false} />
                    ) : (
                        <p className="repo-panel-diff-hint">Select a changed file to review its diff.</p>
                    )}
                </div>
            </div>
        </div>
    );
}
