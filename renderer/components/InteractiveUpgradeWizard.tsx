import { useEffect, useMemo, useState } from 'react';
import {
    Action,
    Carousel,
    Heading,
    Icon,
    Input,
    Select,
    Text,
    useCarousel,
} from '@particle-academy/react-fancy';
import {
    api,
    type AnalyseKnowledgeCandidate,
    type AnalyseRepoCandidate,
    type AnalyseResult,
    type ConvertPlanOpts,
    type RootEntry,
    type SourceKind,
    type TynnProject,
    type WorkspaceRow,
} from '../lib/genie';
import {
    useGitHubAccount,
    GitHubConnect,
    OwnerSelect,
    type GitHubAccount,
} from './GitHubConnect';

interface Props {
    /** Optional source folder pre-filled by the caller. */
    initialFolder?: string;
    /** Tynn projects to bind the new workspace to. */
    projects: TynnProject[];
    loadingProjects: boolean;
    onCancel: () => void;
    onCreated: (row: WorkspaceRow) => void;
}

/**
 * How a detected repo becomes a submodule:
 *   - 'origin' — clone from its existing origin remote (no copy of history
 *     into a new place; the envelope references the canonical repo).
 *   - 'fork'   — fork the origin on GitHub into the chosen owner, then
 *     submodule the FORK. This is the Teams/Agents path: each actor works
 *     on their own fork and PRs back.
 *   - 'local'  — submodule straight from the local path (file:// source);
 *     the only option when the repo has no GitHub origin.
 */
type RepoSourceMode = 'origin' | 'fork' | 'local';

/** UI plan rows; row.included controls whether they enter the executed plan. */
interface RepoRow extends AnalyseRepoCandidate {
    included: boolean;
    submodule_name: string;
    source_mode: RepoSourceMode;
    /** Parsed owner/repo when origin_url is a GitHub remote — gates 'fork'. */
    gh_ref: { owner: string; repo: string } | null;
}

interface KnowledgeRow extends AnalyseKnowledgeCandidate {
    included: boolean;
    /** Selected target subdir inside `.ai/`. Empty string = `.ai/` root (spread for dirs). */
    target_subdir: string;
}

/**
 * Single-repo sources get a per-entry disposition instead of the
 * knowledge-candidates table: every top-level item is either
 * Codebase (stays in the repo, travels with the submodule clone),
 * Knowledge (copies into .ai/<target>), or Root (copies beside
 * project.json).
 */
interface DispositionRow extends RootEntry {
    disposition: 'codebase' | 'knowledge' | 'root';
    target_subdir: string;
}

const KNOWLEDGE_TARGETS: Array<{ value: string; label: string }> = [
    { value: 'plans', label: '.ai/plans/' },
    { value: 'knowledge', label: '.ai/knowledge/' },
    { value: 'pm', label: '.ai/pm/' },
    { value: 'chat', label: '.ai/chat/' },
    { value: 'memory', label: '.ai/memory/' },
    { value: 'issues', label: '.ai/issues/' },
    { value: '', label: '.ai/ (root)' },
];

const KIND_COPY: Record<
    SourceKind,
    { title: string; body: string; icon: string }
> = {
    'single-repo': {
        title: 'Single repository',
        body: 'This folder is one git repo (monorepos count — one .git is one repo). It becomes ONE submodule inside the envelope, and any docs/plans folders can copy into .ai/.',
        icon: 'git-branch',
    },
    'repo-collection': {
        title: 'Collection of repositories',
        body: 'This folder is not a repo itself, but it contains git repos. Each one becomes its own submodule under repos/ — pick which to include on the next step.',
        icon: 'folder-git-2',
    },
    'plain-folder': {
        title: 'Plain folder',
        body: 'No git repos found at the top level. You can still build an envelope and move knowledge into .ai/ — repos can be added later.',
        icon: 'folder',
    },
};

/**
 * Upgrade-to-.agi wizard, structured as a four-step Carousel (wizard
 * variant): Source → Repos → Knowledge → Envelope. The Source step
 * classifies the folder (single repo / repo collection / plain folder)
 * and the later steps adapt to that shape. The source folder is never
 * modified — submodules clone FROM it, knowledge copies out of it.
 */
export default function InteractiveUpgradeWizard({
    initialFolder,
    projects,
    loadingProjects,
    onCancel,
    onCreated,
}: Props) {
    const [step, setStep] = useState(0);
    const [busy, setBusy] = useState(false);
    const [busyStep, setBusyStep] = useState<string | null>(null);
    const [sourceFolder, setSourceFolder] = useState<string>(initialFolder ?? '');
    const [scan, setScan] = useState<AnalyseResult | null>(null);
    const [scanning, setScanning] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Plan state
    const [repoRows, setRepoRows] = useState<RepoRow[]>([]);
    const [knowledgeRows, setKnowledgeRows] = useState<KnowledgeRow[]>([]);
    // Single-repo only: per-entry disposition rows replace knowledgeRows.
    const [dispositionRows, setDispositionRows] = useState<DispositionRow[]>([]);

    // Configure state
    const [projectId, setProjectId] = useState('');
    const [slug, setSlug] = useState('');
    const [parentFolder, setParentFolder] = useState('');
    const [primaryWorkspace, setPrimaryWorkspace] = useState<string | undefined>();
    const [remoteMode, setRemoteMode] = useState<'none' | 'paste' | 'github'>('none');
    const [remoteUrl, setRemoteUrl] = useState('');

    // Shared GitHub account — drives inline connect + owner selection for
    // BOTH the envelope remote and any repo forks. One account choice.
    const account = useGitHubAccount();
    const [ghOwner, setGhOwner] = useState<string>(''); // empty = personal user account
    const [ghPrivate, setGhPrivate] = useState(true);

    useEffect(() => {
        void api()
            .settings.get()
            .then((s) => {
                setPrimaryWorkspace(s.primary_workspace);
                if (!parentFolder && s.primary_workspace) {
                    setParentFolder(s.primary_workspace);
                }
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (initialFolder && !scan && !scanning) {
            void runScan(initialFolder);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialFolder]);

    const runScan = async (folder: string) => {
        setScanning(true);
        setError(null);
        try {
            const r = await api().agi.analyse(folder);
            setScan(r);
            // Parse each origin URL so the Repos step knows which repos are
            // GitHub remotes (and therefore forkable).
            const refs = await Promise.all(
                r.repos.map((c) =>
                    c.origin_url
                        ? api().github.parseRemote(c.origin_url).catch(() => null)
                        : Promise.resolve(null),
                ),
            );
            setRepoRows(
                r.repos.map((c, i) => ({
                    ...c,
                    included: true,
                    submodule_name: c.default_name,
                    source_mode: c.origin_url ? 'origin' : 'local',
                    gh_ref: refs[i],
                })),
            );
            setKnowledgeRows(
                r.knowledge.map((c) => ({
                    ...c,
                    included: true,
                    target_subdir: c.suggested_target,
                })),
            );
            setDispositionRows(
                (r.root_entries ?? []).map((e) => ({
                    ...e,
                    disposition: e.suggested,
                    target_subdir: e.suggested_target,
                })),
            );
            // Suggest a slug from the source folder's basename.
            const leaf = folder
                .replace(/[\\/]+$/, '')
                .split(/[\\/]/)
                .pop();
            if (leaf && !slug) setSlug(leaf.replace(/\.agi$/i, ''));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setScan(null);
        } finally {
            setScanning(false);
        }
    };

    const pickSourceFolder = async () => {
        const p = await api().settings.chooseFolder('Choose source folder to analyse');
        if (p) {
            setSourceFolder(p);
            await runScan(p);
        }
    };
    const pickParentFolder = async () => {
        const p = await api().settings.chooseFolder(
            'Choose destination parent folder for the new envelope',
        );
        if (p) setParentFolder(p);
    };

    const selectedRepoCount = useMemo(
        () => repoRows.filter((r) => r.included).length,
        [repoRows],
    );
    const isSingleRepo = scan?.source_kind === 'single-repo';
    const selectedKnowledgeCount = useMemo(
        () =>
            isSingleRepo
                ? dispositionRows.filter((r) => r.disposition !== 'codebase').length
                : knowledgeRows.filter((r) => r.included).length,
        [isSingleRepo, dispositionRows, knowledgeRows],
    );

    const repoNamesValid = useMemo(() => {
        const names = repoRows
            .filter((r) => r.included)
            .map((r) => r.submodule_name.trim());
        if (names.some((n) => !n)) return false;
        return new Set(names).size === names.length;
    }, [repoRows]);

    const planValid =
        slug.trim().length > 0 &&
        parentFolder.trim().length > 0 &&
        projectId.length > 0 &&
        repoNamesValid &&
        // GitHub is needed when the envelope is auto-created on GitHub OR
        // any repo is set to fork (forking hits the GitHub API).
        ((remoteMode !== 'github' && !repoRows.some((r) => r.included && r.source_mode === 'fork')) ||
            account.connected);

    /** Per-step forward gating. Back is always allowed. */
    const canLeave = (s: number): boolean => {
        if (busy) return false;
        if (s === 0) return !!scan;
        if (s === 1) return repoNamesValid;
        return true;
    };

    const onIndexChange = (next: number) => {
        if (next === step) return;
        if (next < step) {
            setStep(next);
            return;
        }
        // Forward jumps (Next button or clicking a later step dot) must
        // pass every gate between here and there.
        for (let s = step; s < next; s++) {
            if (!canLeave(s)) return;
        }
        setStep(next);
    };

    const execute = async () => {
        if (!planValid || busy) return;
        setBusy(true);
        setError(null);
        setBusyStep(null);
        try {
            const project = projects.find((p) => p.id === projectId);
            if (!project) throw new Error('Pick a Tynn project.');

            // Fork any repos set to 'fork' FIRST — the fork's clone URL
            // becomes the submodule source. Forks land under the chosen
            // owner (ghOwner; empty = personal), so Teams/Agents each get
            // their own fork to work on and PR back from.
            const forkUrlByPath = new Map<string, string>();
            const forkRows = repoRows.filter(
                (r) => r.included && r.source_mode === 'fork' && r.gh_ref,
            );
            for (const r of forkRows) {
                if (!account.connected) {
                    throw new Error('Connect GitHub to fork repositories.');
                }
                setBusyStep(`Forking ${r.gh_ref!.owner}/${r.gh_ref!.repo}…`);
                const fork = await api().github.forkRepo({
                    owner: r.gh_ref!.owner,
                    repo: r.gh_ref!.repo,
                    intoOrg: ghOwner || null,
                });
                forkUrlByPath.set(r.abs_path, fork.clone_url);
            }

            // If GitHub Auto is selected, mint the empty repo BEFORE we
            // build the envelope so the URL is ready to register as origin.
            let remote: ConvertPlanOpts['remote'] = { kind: 'none' };
            let pushAfter = false;
            if (remoteMode === 'paste' && remoteUrl.trim()) {
                remote = { kind: 'paste', url: remoteUrl.trim() };
            } else if (remoteMode === 'github') {
                if (!account.connected) {
                    throw new Error('Connect GitHub to auto-create the envelope repo.');
                }
                setBusyStep('Creating GitHub repo…');
                const created = await api().github.createRepo({
                    name: `${slug.trim()}.agi`,
                    owner: ghOwner || null,
                    description: `Aionima envelope for ${project.name}`,
                    private: ghPrivate,
                });
                remote = { kind: 'paste', url: created.clone_url };
                pushAfter = true;
            }

            const plan: ConvertPlanOpts = {
                slug: slug.trim(),
                name: project.name,
                parent_path: parentFolder.trim(),
                repos: repoRows
                    .filter((r) => r.included)
                    .map((r) => {
                        if (r.source_mode === 'fork' && forkUrlByPath.has(r.abs_path)) {
                            return {
                                source: forkUrlByPath.get(r.abs_path)!,
                                is_local: false,
                                submodule_name: r.submodule_name.trim(),
                            };
                        }
                        if (r.source_mode === 'origin' && r.origin_url) {
                            return {
                                source: r.origin_url,
                                is_local: false,
                                submodule_name: r.submodule_name.trim(),
                            };
                        }
                        return {
                            source: r.abs_path,
                            is_local: true,
                            submodule_name: r.submodule_name.trim(),
                        };
                    }),
                knowledge: isSingleRepo
                    ? dispositionRows
                          .filter((r) => r.disposition !== 'codebase')
                          .map((r) => ({
                              source_abs_path: r.abs_path,
                              kind: r.kind,
                              target_subdir:
                                  r.disposition === 'knowledge' ? r.target_subdir : '',
                              to_envelope_root: r.disposition === 'root',
                          }))
                    : knowledgeRows
                          .filter((r) => r.included)
                          .map((r) => ({
                              source_abs_path: r.abs_path,
                              kind: r.kind,
                              target_subdir: r.target_subdir,
                          })),
                remote,
            };
            setBusyStep('Building envelope + adding submodules…');
            const result = await api().agi.convertPlan(plan);

            if (pushAfter) {
                setBusyStep('Pushing initial commit to GitHub…');
                try {
                    await api().agi.push(result.path, 'main');
                } catch (pushErr) {
                    // Local envelope is fine; surface the push failure but
                    // still register the workspace so the user can fix
                    // credentials and push manually.
                    setError(
                        pushErr instanceof Error
                            ? pushErr.message
                            : String(pushErr),
                    );
                }
            }

            setBusyStep('Registering workspace…');
            const settings = await api().settings.get();
            const row: WorkspaceRow = {
                id: project.id,
                backend: project.backend ?? 'tynn',
                project_id: project.id,
                project_name: project.name,
                tynn_project_id: project.id,
                tynn_project_name: project.name,
                shape: 'agi',
                path: result.path,
                editor: settings.default_editor ?? 'cursor',
                editor_cmd: settings.default_editor_cmd ?? null,
                start_cmd: settings.default_start_cmd ?? null,
                env_file: settings.default_env_file ?? '.env',
                last_opened_at: null,
                created_by_genie: 1,
            };
            const saved = await api().workspaces.add(row);
            onCreated(saved);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusyStep(null);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Heading as="h2" size="sm">
                <Icon name="layers" size="sm" /> Upgrade to .agi envelope
            </Heading>

            <Carousel
                variant="wizard"
                activeIndex={step}
                onIndexChange={onIndexChange}
                onFinish={() => void execute()}
            >
                <Carousel.Steps className="upgrade-steps" />

                <Carousel.Panels
                    transition="fade"
                    className="upgrade-panels"
                >
                    <Carousel.Slide name="Source">
                        <SourceStep
                            folder={sourceFolder}
                            scan={scan}
                            scanning={scanning}
                            onPick={pickSourceFolder}
                            onRescan={() => sourceFolder && void runScan(sourceFolder)}
                        />
                    </Carousel.Slide>

                    <Carousel.Slide name="Repos">
                        <ReposStep
                            kind={scan?.source_kind ?? 'plain-folder'}
                            rows={repoRows}
                            setRows={setRepoRows}
                            namesValid={repoNamesValid}
                            account={account}
                        />
                    </Carousel.Slide>

                    <Carousel.Slide name="Knowledge">
                        {isSingleRepo ? (
                            <DispositionStep
                                rows={dispositionRows}
                                setRows={setDispositionRows}
                            />
                        ) : (
                            <KnowledgeStep
                                rows={knowledgeRows}
                                setRows={setKnowledgeRows}
                                other={scan?.other ?? []}
                            />
                        )}
                    </Carousel.Slide>

                    <Carousel.Slide name="Envelope">
                        <EnvelopeStep
                            projects={projects}
                            loadingProjects={loadingProjects}
                            projectId={projectId}
                            setProjectId={setProjectId}
                            slug={slug}
                            setSlug={setSlug}
                            parentFolder={parentFolder}
                            onPickParent={pickParentFolder}
                            primaryWorkspace={primaryWorkspace}
                            remoteMode={remoteMode}
                            setRemoteMode={setRemoteMode}
                            remoteUrl={remoteUrl}
                            setRemoteUrl={setRemoteUrl}
                            account={account}
                            ghOwner={ghOwner}
                            setGhOwner={setGhOwner}
                            ghPrivate={ghPrivate}
                            setGhPrivate={setGhPrivate}
                            forkCount={repoRows.filter((r) => r.included && r.source_mode === 'fork').length}
                            selectedRepoCount={selectedRepoCount}
                            selectedKnowledgeCount={selectedKnowledgeCount}
                            busyStep={busyStep}
                        />
                    </Carousel.Slide>
                </Carousel.Panels>

                {error && (
                    <Text
                        size="xs"
                        style={{ color: 'var(--rose-500)', display: 'block', marginTop: 8 }}
                    >
                        {error}
                    </Text>
                )}

                <WizardFooter
                    onCancel={onCancel}
                    busy={busy}
                    busyStep={busyStep}
                    canNext={canLeave(step)}
                    finishLabel={
                        remoteMode === 'github'
                            ? 'Create on GitHub + build envelope'
                            : 'Build envelope'
                    }
                    finishEnabled={planValid && !busy}
                    onFinish={() => void execute()}
                />
            </Carousel>
        </div>
    );
}

/**
 * Custom controls row — fancy-ui's built-in <Carousel.Controls> has no
 * per-step gating, and the finish action needs validity + busy state.
 * Lives inside the Carousel so useCarousel() reaches the context.
 */
function WizardFooter({
    onCancel,
    busy,
    busyStep,
    canNext,
    finishLabel,
    finishEnabled,
    onFinish,
}: {
    onCancel: () => void;
    busy: boolean;
    busyStep: string | null;
    canNext: boolean;
    finishLabel: string;
    finishEnabled: boolean;
    onFinish: () => void;
}) {
    const { activeIndex, totalSlides, next, prev } = useCarousel();
    const isFirst = activeIndex === 0;
    const isLast = activeIndex === totalSlides - 1;

    return (
        <div
            style={{
                display: 'flex',
                justifyContent: 'flex-end',
                alignItems: 'center',
                gap: 8,
                marginTop: 12,
            }}
        >
            <Action variant="ghost" onClick={onCancel} disabled={busy}>
                Cancel
            </Action>
            <span style={{ flex: 1 }} />
            {!isFirst && (
                <Action variant="ghost" icon="arrow-left" onClick={prev} disabled={busy}>
                    Back
                </Action>
            )}
            {isLast ? (
                <Action color="blue" icon="check" onClick={onFinish} disabled={!finishEnabled}>
                    {busy ? busyStep ?? 'Building envelope…' : finishLabel}
                </Action>
            ) : (
                <Action
                    color="blue"
                    iconTrailing="arrow-right"
                    onClick={next}
                    disabled={!canNext}
                >
                    Next
                </Action>
            )}
        </div>
    );
}

/* ===== Step 1 — Source =================================================== */

function SourceStep({
    folder,
    scan,
    scanning,
    onPick,
    onRescan,
}: {
    folder: string;
    scan: AnalyseResult | null;
    scanning: boolean;
    onPick: () => void;
    onRescan: () => void;
}) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                Pick the folder to upgrade. Genie reads its layout (never
                modifies it) and figures out whether it's a single repo, a
                collection of repos, or a plain folder.
            </Text>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                    <Input value={folder} readOnly placeholder="No folder chosen" />
                </div>
                <Action variant="ghost" onClick={onPick} icon="folder" disabled={scanning}>
                    Browse
                </Action>
                {folder && (
                    <Action
                        variant="ghost"
                        onClick={onRescan}
                        icon="refresh-cw"
                        disabled={scanning}
                    >
                        {scanning ? 'Scanning…' : 'Re-scan'}
                    </Action>
                )}
            </div>

            {scan && (
                <div className="upgrade-kind">
                    <span className="uk-icon">
                        <Icon name={KIND_COPY[scan.source_kind].icon} size="md" />
                    </span>
                    <div>
                        <Text size="sm" style={{ fontWeight: 600, display: 'block' }}>
                            {KIND_COPY[scan.source_kind].title}
                        </Text>
                        <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                            {KIND_COPY[scan.source_kind].body}
                        </Text>
                        <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 4 }}>
                            Found: {scan.repos.length} repo
                            {scan.repos.length === 1 ? '' : 's'} ·{' '}
                            {scan.knowledge.length} knowledge candidate
                            {scan.knowledge.length === 1 ? '' : 's'} ·{' '}
                            {scan.other.length} other item
                            {scan.other.length === 1 ? '' : 's'}
                        </Text>
                    </div>
                </div>
            )}
        </div>
    );
}

/* ===== Step 2 — Repos ==================================================== */

function ReposStep({
    kind,
    rows,
    setRows,
    namesValid,
    account,
}: {
    kind: SourceKind;
    rows: RepoRow[];
    setRows: React.Dispatch<React.SetStateAction<RepoRow[]>>;
    namesValid: boolean;
    account: GitHubAccount;
}) {
    const patchRow = (i: number, patch: Partial<RepoRow>) =>
        setRows((rs) => rs.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

    if (rows.length === 0) {
        return (
            <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                No git repos detected — the envelope starts without submodules.
                You can add repos later with <code>git submodule add</code> or
                from the workspace context menu.
            </Text>
        );
    }

    const anyForkable = rows.some((r) => r.gh_ref);
    const wantsFork = rows.some((r) => r.included && r.source_mode === 'fork');

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                {kind === 'single-repo'
                    ? 'The source repo becomes one submodule under repos/. Rename it if the folder name is unfortunate.'
                    : 'Each detected repo becomes a git submodule under repos/. Uncheck the ones you don’t want; rename where needed.'}{' '}
                <strong>Origin</strong> clones from the existing remote;{' '}
                <strong>Fork</strong> forks it into your account/org first (the
                Teams/Agents path — work on your fork, PR back);{' '}
                <strong>Local</strong> submodules straight from the folder on disk.
            </Text>

            {anyForkable && (
                <div className="gh-inline">
                    <GitHubConnect account={account} />
                </div>
            )}

            <table className="upgrade-tbl">
                <thead>
                    <tr>
                        <th />
                        <th>Source</th>
                        <th>repos/&lt;name&gt;</th>
                        <th>From</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((r, i) => {
                        const sourceOptions = [
                            ...(r.origin_url
                                ? [{ value: 'origin', label: 'Origin (clone)' }]
                                : []),
                            ...(r.gh_ref
                                ? [{ value: 'fork', label: 'Fork into…' }]
                                : []),
                            { value: 'local', label: 'Local path' },
                        ];
                        return (
                            <tr key={r.abs_path}>
                                <td>
                                    <input
                                        type="checkbox"
                                        checked={r.included}
                                        onChange={(e) => patchRow(i, { included: e.target.checked })}
                                    />
                                </td>
                                <td>
                                    <code>
                                        {r.rel_path === '.' ? '(this folder)' : `${r.rel_path}/`}
                                    </code>
                                    {r.head_ref && (
                                        <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                                            @{r.head_ref}
                                        </Text>
                                    )}
                                </td>
                                <td>
                                    <input
                                        type="text"
                                        className="upgrade-inp"
                                        value={r.submodule_name}
                                        onChange={(e) => patchRow(i, { submodule_name: e.target.value })}
                                    />
                                </td>
                                <td style={{ minWidth: 130 }}>
                                    <Select
                                        value={r.source_mode}
                                        onValueChange={(v) =>
                                            patchRow(i, { source_mode: v as RepoSourceMode })
                                        }
                                        list={sourceOptions}
                                    />
                                    {r.source_mode !== 'local' && r.origin_url && (
                                        <Text
                                            size="xs"
                                            className="text-zinc-500"
                                            style={{
                                                display: 'block',
                                                marginTop: 4,
                                                fontFamily: 'var(--font-mono)',
                                                fontSize: 10,
                                                wordBreak: 'break-all',
                                            }}
                                        >
                                            {r.origin_url}
                                        </Text>
                                    )}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            {wantsFork && !account.connected && (
                <Text size="xs" style={{ color: 'var(--rose-500)' }}>
                    Connect GitHub above to fork the selected repos.
                </Text>
            )}
            {!namesValid && (
                <Text size="xs" style={{ color: 'var(--rose-500)' }}>
                    Submodule names must be non-empty and unique.
                </Text>
            )}
        </div>
    );
}

/* ===== Step 3a — Disposition (single-repo sources) ====================== */

const GIT_STATE_HINT: Record<RootEntry['git_state'], string> = {
    tracked: 'in git — travels with the repo',
    untracked: 'NOT in git — stays behind unless copied',
    ignored: 'gitignored — stays behind unless copied',
};

function DispositionStep({
    rows,
    setRows,
}: {
    rows: DispositionRow[];
    setRows: React.Dispatch<React.SetStateAction<DispositionRow[]>>;
}) {
    const patchRow = (i: number, patch: Partial<DispositionRow>) =>
        setRows((rs) => rs.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

    const setAll = (d: DispositionRow['disposition']) =>
        setRows((rs) => rs.map((row) => ({ ...row, disposition: d })));

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                Everything tracked by git already travels with the repo —
                that's <strong>Codebase</strong> (nothing copies). Items NOT in
                git (a gitignored <code>.ai/</code>, loose notes) would be left
                behind on a fresh clone: send those to{' '}
                <strong>Knowledge</strong> (<code>.ai/…</code>) or{' '}
                <strong>Root</strong> (beside <code>project.json</code>).
            </Text>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Text size="xs" className="text-zinc-500">
                    Set all:
                </Text>
                {(['codebase', 'knowledge', 'root'] as const).map((d) => (
                    <Action key={d} size="sm" variant="ghost" onClick={() => setAll(d)}>
                        {d === 'codebase' ? 'Codebase' : d === 'knowledge' ? 'Knowledge' : 'Root'}
                    </Action>
                ))}
            </div>
            <table className="upgrade-tbl">
                <thead>
                    <tr>
                        <th>Entry</th>
                        <th>Git</th>
                        <th>Disposition</th>
                        <th>Target</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((r, i) => (
                        <tr key={r.abs_path}>
                            <td>
                                <code>
                                    {r.rel_path}
                                    {r.kind === 'directory' ? '/' : ''}
                                </code>
                            </td>
                            <td>
                                <span
                                    className={`git-pill git-${r.git_state}`}
                                    title={GIT_STATE_HINT[r.git_state]}
                                >
                                    {r.git_state}
                                </span>
                            </td>
                            <td>
                                <Select
                                    value={r.disposition}
                                    onValueChange={(v) =>
                                        patchRow(i, {
                                            disposition: v as DispositionRow['disposition'],
                                            // First flip into knowledge gets a sane target.
                                            target_subdir:
                                                v === 'knowledge' && !r.target_subdir
                                                    ? 'knowledge'
                                                    : r.target_subdir,
                                        })
                                    }
                                    list={[
                                        { value: 'codebase', label: 'Codebase (stays in repo)' },
                                        { value: 'knowledge', label: 'Knowledge / WIP → .ai/' },
                                        { value: 'root', label: 'Envelope root' },
                                    ]}
                                />
                            </td>
                            <td>
                                {r.disposition === 'knowledge' ? (
                                    <Select
                                        value={r.target_subdir}
                                        onValueChange={(v) => patchRow(i, { target_subdir: v })}
                                        list={KNOWLEDGE_TARGETS.map((t) => ({
                                            value: t.value,
                                            label: t.label,
                                        }))}
                                    />
                                ) : (
                                    <Text size="xs" className="text-zinc-500">
                                        {r.disposition === 'root'
                                            ? `/${r.rel_path}${r.kind === 'directory' ? '/' : ''}`
                                            : '—'}
                                    </Text>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/* ===== Step 3 — Knowledge =============================================== */

function KnowledgeStep({
    rows,
    setRows,
    other,
}: {
    rows: KnowledgeRow[];
    setRows: React.Dispatch<React.SetStateAction<KnowledgeRow[]>>;
    other: AnalyseResult['other'];
}) {
    const patchRow = (i: number, patch: Partial<KnowledgeRow>) =>
        setRows((rs) => rs.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                Folders matching plans/, docs/, notes/, k/, .ai/ etc., plus
                loose markdown files. Each copies into <code>.ai/</code> at the
                target you pick — the source stays untouched.
            </Text>
            {rows.length === 0 ? (
                <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                    No knowledge candidates detected. Nothing to configure here —
                    hit Next.
                </Text>
            ) : (
                <table className="upgrade-tbl">
                    <thead>
                        <tr>
                            <th />
                            <th>Source</th>
                            <th>Target inside .ai/</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r, i) => (
                            <tr key={r.abs_path}>
                                <td>
                                    <input
                                        type="checkbox"
                                        checked={r.included}
                                        onChange={(e) => patchRow(i, { included: e.target.checked })}
                                    />
                                </td>
                                <td>
                                    <code>
                                        {r.rel_path}
                                        {r.kind === 'directory' ? '/' : ''}
                                    </code>
                                    {r.kind === 'file' && r.size != null && (
                                        <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                                            {formatBytes(r.size)}
                                        </Text>
                                    )}
                                </td>
                                <td>
                                    <Select
                                        value={r.target_subdir}
                                        onValueChange={(v) => patchRow(i, { target_subdir: v })}
                                        list={KNOWLEDGE_TARGETS.map((t) => ({
                                            value: t.value,
                                            label: t.label,
                                        }))}
                                    />
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {other.length > 0 && (
                <details className="upgrade-other">
                    <summary>
                        {other.length} other item{other.length === 1 ? '' : 's'} —
                        stay in the source folder, untouched
                    </summary>
                    <ul>
                        {other.slice(0, 30).map((o) => (
                            <li key={o.rel_path}>
                                {o.rel_path}
                                {o.kind === 'directory' ? '/' : ''}
                            </li>
                        ))}
                        {other.length > 30 && <li>… and {other.length - 30} more</li>}
                    </ul>
                </details>
            )}
        </div>
    );
}

/* ===== Step 4 — Envelope ================================================ */

function EnvelopeStep({
    projects,
    loadingProjects,
    projectId,
    setProjectId,
    slug,
    setSlug,
    parentFolder,
    onPickParent,
    primaryWorkspace,
    remoteMode,
    setRemoteMode,
    remoteUrl,
    setRemoteUrl,
    account,
    ghOwner,
    setGhOwner,
    ghPrivate,
    setGhPrivate,
    forkCount,
    selectedRepoCount,
    selectedKnowledgeCount,
    busyStep,
}: {
    projects: TynnProject[];
    loadingProjects: boolean;
    projectId: string;
    setProjectId: (v: string) => void;
    slug: string;
    setSlug: (v: string) => void;
    parentFolder: string;
    onPickParent: () => void;
    primaryWorkspace?: string;
    remoteMode: 'none' | 'paste' | 'github';
    setRemoteMode: (v: 'none' | 'paste' | 'github') => void;
    remoteUrl: string;
    setRemoteUrl: (v: string) => void;
    account: GitHubAccount;
    ghOwner: string;
    setGhOwner: (v: string) => void;
    ghPrivate: boolean;
    setGhPrivate: (v: boolean) => void;
    forkCount: number;
    selectedRepoCount: number;
    selectedKnowledgeCount: number;
    busyStep: string | null;
}) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {loadingProjects ? (
                <Text size="xs" className="text-zinc-500">
                    Loading projects…
                </Text>
            ) : (
                <div>
                    <Text size="xs" style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                        Tynn project
                    </Text>
                    <Select
                        value={projectId}
                        onValueChange={setProjectId}
                        list={projects.map((p) => ({ value: p.id, label: p.name }))}
                    />
                </div>
            )}
            <Input
                label="Envelope slug"
                description={`Becomes the folder name: ${slug || '{slug}'}.agi`}
                value={slug}
                onValueChange={setSlug}
                placeholder="brain-v2"
            />
            <div>
                <Text size="xs" style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                    Destination parent
                </Text>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <div style={{ flex: 1 }}>
                        <Input value={parentFolder} readOnly placeholder="No folder chosen" />
                    </div>
                    <Action variant="ghost" onClick={onPickParent} icon="folder">
                        Browse
                    </Action>
                </div>
                <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 4 }}>
                    {primaryWorkspace
                        ? `Default: ${primaryWorkspace}. Result: <parent>/${slug || '{slug}'}.agi/`
                        : `Result: <parent>/${slug || '{slug}'}.agi/`}
                </Text>
            </div>

            <div>
                <Text size="xs" style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                    Envelope remote (optional)
                </Text>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {(['none', 'github', 'paste'] as const).map((m) => (
                        <Action
                            key={m}
                            size="sm"
                            variant={remoteMode === m ? 'default' : 'ghost'}
                            color={remoteMode === m ? 'blue' : undefined}
                            onClick={() => setRemoteMode(m)}
                        >
                            {m === 'none'
                                ? 'No remote'
                                : m === 'github'
                                  ? 'GitHub (auto-create)'
                                  : 'Paste URL'}
                        </Action>
                    ))}
                </div>
                {remoteMode === 'paste' && (
                    <Input
                        label="Remote URL"
                        value={remoteUrl}
                        onValueChange={setRemoteUrl}
                        placeholder="git@github.com:owner/{slug}.agi.git"
                        style={{ marginTop: 8 }}
                    />
                )}
                {remoteMode === 'github' && (
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <GitHubConnect account={account} />
                        {account.connected && (
                            <>
                                <OwnerSelect
                                    account={account}
                                    value={ghOwner}
                                    onChange={setGhOwner}
                                />
                                <label
                                    style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 8,
                                        cursor: 'pointer',
                                    }}
                                >
                                    <input
                                        type="checkbox"
                                        checked={ghPrivate}
                                        onChange={(e) => setGhPrivate(e.target.checked)}
                                    />
                                    <Text size="xs">Private repository</Text>
                                </label>
                                <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                                    Will create{' '}
                                    <code>
                                        github.com/{ghOwner || account.username || 'you'}/
                                        {slug || '{slug}'}.agi
                                    </code>
                                    , set it as <code>origin</code>, and push the
                                    initial commit.
                                </Text>
                            </>
                        )}
                    </div>
                )}
            </div>

            {/* When forks are queued, the same owner choice targets them —
                surface it here so the user sees one account decision. */}
            {forkCount > 0 && account.connected && (
                <OwnerSelect
                    account={account}
                    value={ghOwner}
                    onChange={setGhOwner}
                    label={`Fork ${forkCount} repo${forkCount === 1 ? '' : 's'} into`}
                />
            )}

            <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                Will create <strong>{selectedRepoCount}</strong> submodule
                {selectedRepoCount === 1 ? '' : 's'}
                {forkCount > 0 ? ` (${forkCount} via fork)` : ''} and copy{' '}
                <strong>{selectedKnowledgeCount}</strong> knowledge item
                {selectedKnowledgeCount === 1 ? '' : 's'} into <code>.ai/</code>.
            </Text>
            {busyStep && (
                <Text size="xs" style={{ display: 'block', color: 'var(--blue-500)' }}>
                    {busyStep}
                </Text>
            )}
        </div>
    );
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

