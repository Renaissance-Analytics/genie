import { useEffect, useMemo, useState } from 'react';
import {
    Action,
    Card,
    Heading,
    Icon,
    Input,
    Select,
    Text,
} from '@particle-academy/react-fancy';
import {
    api,
    type AnalyseKnowledgeCandidate,
    type AnalyseRepoCandidate,
    type AnalyseResult,
    type ConvertPlanOpts,
    type TynnProject,
    type WorkspaceRow,
} from '../lib/genie';

interface Props {
    /** Optional source folder pre-filled by the caller. */
    initialFolder?: string;
    /** Tynn projects to bind the new workspace to. */
    projects: TynnProject[];
    loadingProjects: boolean;
    onCancel: () => void;
    onCreated: (row: WorkspaceRow) => void;
}

/** UI plan rows; row.included controls whether they enter the executed plan. */
interface RepoRow extends AnalyseRepoCandidate {
    included: boolean;
    submodule_name: string;
    /** Use the remote origin URL if available; otherwise the local path. */
    use_remote: boolean;
}

interface KnowledgeRow extends AnalyseKnowledgeCandidate {
    included: boolean;
    /** Selected target subdir inside `.ai/`. Empty string = `.ai/` root (spread for dirs). */
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

export default function InteractiveUpgradeWizard({
    initialFolder,
    projects,
    loadingProjects,
    onCancel,
    onCreated,
}: Props) {
    const [stage, setStage] = useState<'pick' | 'plan' | 'configure' | 'busy'>(
        initialFolder ? 'plan' : 'pick',
    );
    const [sourceFolder, setSourceFolder] = useState<string>(initialFolder ?? '');
    const [scan, setScan] = useState<AnalyseResult | null>(null);
    const [scanning, setScanning] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Plan state
    const [repoRows, setRepoRows] = useState<RepoRow[]>([]);
    const [knowledgeRows, setKnowledgeRows] = useState<KnowledgeRow[]>([]);

    // Configure state
    const [projectId, setProjectId] = useState('');
    const [slug, setSlug] = useState('');
    const [parentFolder, setParentFolder] = useState('');
    const [primaryWorkspace, setPrimaryWorkspace] = useState<string | undefined>();
    const [remoteMode, setRemoteMode] = useState<'none' | 'paste' | 'github'>('none');
    const [remoteUrl, setRemoteUrl] = useState('');

    // GitHub state — only fetched once the user picks the github remote mode.
    const [gh, setGh] = useState<{
        loaded: boolean;
        connected: boolean;
        username: string | null;
        orgs: Array<{ login: string }>;
        error: string | null;
    }>({ loaded: false, connected: false, username: null, orgs: [], error: null });
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

    // Fetch GitHub state lazily — first time the user opens the github
    // remote picker. Refresh on every reopen so a freshly-connected
    // account in Settings becomes visible without restarting the modal.
    useEffect(() => {
        if (remoteMode !== 'github') return;
        let cancelled = false;
        (async () => {
            try {
                const st = await api().github.status();
                if (cancelled) return;
                if (!st.connected) {
                    setGh({
                        loaded: true,
                        connected: false,
                        username: st.username,
                        orgs: [],
                        error: null,
                    });
                    return;
                }
                const orgs = await api().github.orgs();
                if (cancelled) return;
                setGh({
                    loaded: true,
                    connected: true,
                    username: st.username,
                    orgs: orgs.map((o) => ({ login: o.login })),
                    error: null,
                });
                // Default owner = personal user account.
                if (!ghOwner && st.username) setGhOwner('');
            } catch (e) {
                if (cancelled) return;
                setGh((prev) => ({
                    ...prev,
                    loaded: true,
                    error: e instanceof Error ? e.message : String(e),
                }));
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [remoteMode]);

    const runScan = async (folder: string) => {
        setScanning(true);
        setError(null);
        try {
            const r = await api().agi.analyse(folder);
            setScan(r);
            setRepoRows(
                r.repos.map((c) => ({
                    ...c,
                    included: true,
                    submodule_name: c.default_name,
                    use_remote: !!c.origin_url,
                })),
            );
            setKnowledgeRows(
                r.knowledge.map((c) => ({
                    ...c,
                    included: true,
                    target_subdir: c.suggested_target,
                })),
            );
            // Suggest a slug from the source folder's basename.
            const leaf = folder
                .replace(/[\\/]+$/, '')
                .split(/[\\/]/)
                .pop();
            if (leaf && !slug) setSlug(leaf);
            setStage('plan');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
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
    const selectedKnowledgeCount = useMemo(
        () => knowledgeRows.filter((r) => r.included).length,
        [knowledgeRows],
    );

    const planValid =
        slug.trim().length > 0 &&
        parentFolder.trim().length > 0 &&
        projectId.length > 0 &&
        // Submodule names unique + non-empty
        (() => {
            const names = repoRows.filter((r) => r.included).map((r) => r.submodule_name.trim());
            if (names.some((n) => !n)) return false;
            return new Set(names).size === names.length;
        })() &&
        // For GitHub auto, we need a connected account; the owner is
        // optional (empty string = personal account).
        (remoteMode !== 'github' || gh.connected);

    const [busyStep, setBusyStep] = useState<string | null>(null);

    const execute = async () => {
        if (!planValid) return;
        setStage('busy');
        setError(null);
        setBusyStep(null);
        try {
            const project = projects.find((p) => p.id === projectId);
            if (!project) throw new Error('Pick a Tynn project.');

            // If GitHub Auto is selected, mint the empty repo BEFORE we
            // build the envelope so the URL is ready to register as origin.
            let remote: ConvertPlanOpts['remote'] = { kind: 'none' };
            let pushAfter = false;
            if (remoteMode === 'paste' && remoteUrl.trim()) {
                remote = { kind: 'paste', url: remoteUrl.trim() };
            } else if (remoteMode === 'github') {
                if (!gh.connected) {
                    throw new Error(
                        'GitHub is not connected. Open Settings → GitHub and finish the Device Flow.',
                    );
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
                    .map((r) => ({
                        source:
                            r.use_remote && r.origin_url
                                ? r.origin_url
                                : r.abs_path,
                        is_local: !(r.use_remote && r.origin_url),
                        submodule_name: r.submodule_name.trim(),
                    })),
                knowledge: knowledgeRows
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
            setStage('configure');
            setBusyStep(null);
        }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Heading as="h2" size="sm">
                <Icon name="layers" size="sm" /> Interactive upgrade to .agi
            </Heading>
            <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                Genie scans the source folder, then lets you choose which
                sub-repos become <code>repos/</code> submodules and which
                knowledge folders / files land in <code>.ai/</code>. The
                original folder is never modified.
            </Text>

            <SourceFolderRow
                folder={sourceFolder}
                onPick={pickSourceFolder}
                scanning={scanning}
                onRescan={() => sourceFolder && runScan(sourceFolder)}
            />

            {error && (
                <Text size="xs" style={{ color: 'var(--rose-500)' }}>
                    {error}
                </Text>
            )}

            {scan && (
                <>
                    <ScanSection
                        title={`Detected repos · ${repoRows.length}`}
                        description={
                            repoRows.length === 0
                                ? 'No nested git repos found at the top level. The source folder itself can still be added as a single submodule via the simple checkbox flow.'
                                : 'Each detected repo becomes a git submodule under repos/. Uncheck the ones you don’t want; rename if the directory name is unfortunate.'
                        }
                    >
                        {repoRows.length === 0 ? null : (
                            <table className="upgrade-tbl">
                                <thead>
                                    <tr>
                                        <th />
                                        <th>Source</th>
                                        <th>repos/&lt;name&gt;</th>
                                        <th>Origin / fallback</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {repoRows.map((r, i) => (
                                        <tr key={r.abs_path}>
                                            <td>
                                                <input
                                                    type="checkbox"
                                                    checked={r.included}
                                                    onChange={(e) =>
                                                        setRepoRows((rs) =>
                                                            rs.map((row, idx) =>
                                                                idx === i
                                                                    ? {
                                                                            ...row,
                                                                            included:
                                                                                e.target
                                                                                    .checked,
                                                                        }
                                                                    : row,
                                                            ),
                                                        )
                                                    }
                                                />
                                            </td>
                                            <td>
                                                <code>{r.rel_path}/</code>
                                                {r.head_ref && (
                                                    <Text
                                                        size="xs"
                                                        className="text-zinc-500"
                                                        style={{ display: 'block' }}
                                                    >
                                                        @{r.head_ref}
                                                    </Text>
                                                )}
                                            </td>
                                            <td>
                                                <input
                                                    type="text"
                                                    className="upgrade-inp"
                                                    value={r.submodule_name}
                                                    onChange={(e) =>
                                                        setRepoRows((rs) =>
                                                            rs.map((row, idx) =>
                                                                idx === i
                                                                    ? {
                                                                            ...row,
                                                                            submodule_name:
                                                                                e.target.value,
                                                                        }
                                                                    : row,
                                                            ),
                                                        )
                                                    }
                                                />
                                            </td>
                                            <td>
                                                {r.origin_url ? (
                                                    <label
                                                        style={{
                                                            display: 'inline-flex',
                                                            alignItems: 'center',
                                                            gap: 6,
                                                            fontSize: 11,
                                                        }}
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            checked={r.use_remote}
                                                            onChange={(e) =>
                                                                setRepoRows((rs) =>
                                                                    rs.map((row, idx) =>
                                                                        idx === i
                                                                            ? {
                                                                                    ...row,
                                                                                    use_remote:
                                                                                        e.target
                                                                                            .checked,
                                                                                }
                                                                            : row,
                                                                    ),
                                                                )
                                                            }
                                                        />
                                                        <span
                                                            style={{
                                                                color: 'var(--fg-3)',
                                                                fontFamily: 'var(--font-mono)',
                                                                fontSize: 10.5,
                                                            }}
                                                        >
                                                            {r.origin_url}
                                                        </span>
                                                    </label>
                                                ) : (
                                                    <Text
                                                        size="xs"
                                                        className="text-zinc-500"
                                                        style={{
                                                            fontFamily: 'var(--font-mono)',
                                                            fontSize: 10.5,
                                                        }}
                                                    >
                                                        no origin · use local path
                                                    </Text>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </ScanSection>

                    <ScanSection
                        title={`Knowledge candidates · ${knowledgeRows.length}`}
                        description="Top-level folders matching plans/, docs/, notes/, k/, .ai/ etc., plus loose markdown files. Each one copies into .ai/ at the target you pick. The source is untouched."
                    >
                        {knowledgeRows.length === 0 ? null : (
                            <table className="upgrade-tbl">
                                <thead>
                                    <tr>
                                        <th />
                                        <th>Source</th>
                                        <th>Target inside .ai/</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {knowledgeRows.map((r, i) => (
                                        <tr key={r.abs_path}>
                                            <td>
                                                <input
                                                    type="checkbox"
                                                    checked={r.included}
                                                    onChange={(e) =>
                                                        setKnowledgeRows((rs) =>
                                                            rs.map((row, idx) =>
                                                                idx === i
                                                                    ? {
                                                                            ...row,
                                                                            included:
                                                                                e.target
                                                                                    .checked,
                                                                        }
                                                                    : row,
                                                            ),
                                                        )
                                                    }
                                                />
                                            </td>
                                            <td>
                                                <code>
                                                    {r.rel_path}
                                                    {r.kind === 'directory' ? '/' : ''}
                                                </code>
                                                {r.kind === 'file' && r.size != null && (
                                                    <Text
                                                        size="xs"
                                                        className="text-zinc-500"
                                                        style={{ display: 'block' }}
                                                    >
                                                        {formatBytes(r.size)}
                                                    </Text>
                                                )}
                                            </td>
                                            <td>
                                                <Select
                                                    value={r.target_subdir}
                                                    onValueChange={(v) =>
                                                        setKnowledgeRows((rs) =>
                                                            rs.map((row, idx) =>
                                                                idx === i
                                                                    ? {
                                                                            ...row,
                                                                            target_subdir: v,
                                                                        }
                                                                    : row,
                                                            ),
                                                        )
                                                    }
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
                    </ScanSection>

                    {scan.other.length > 0 && (
                        <ScanSection
                            title={`Other items · ${scan.other.length}`}
                            description="Stuff Genie didn’t classify. None of it will be moved or added — it stays in the source folder."
                        >
                            <ul
                                style={{
                                    margin: 0,
                                    padding: '6px 0 0 18px',
                                    fontSize: 11.5,
                                    color: 'var(--fg-3)',
                                    fontFamily: 'var(--font-mono)',
                                }}
                            >
                                {scan.other.slice(0, 30).map((o) => (
                                    <li key={o.rel_path}>
                                        {o.rel_path}
                                        {o.kind === 'directory' ? '/' : ''}
                                    </li>
                                ))}
                                {scan.other.length > 30 && (
                                    <li>… and {scan.other.length - 30} more</li>
                                )}
                            </ul>
                        </ScanSection>
                    )}

                    <Card
                        style={{
                            padding: 14,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 10,
                        }}
                    >
                        <Heading as="h3" size="sm" style={{ margin: 0 }}>
                            Envelope settings
                        </Heading>
                        <ProjectPickerInline
                            projects={projects}
                            loading={loadingProjects}
                            value={projectId}
                            onChange={setProjectId}
                        />
                        <Input
                            label="Envelope slug"
                            description={`Becomes the folder name: ${slug || '{slug}'}.agi`}
                            value={slug}
                            onValueChange={setSlug}
                            placeholder="brain-v2"
                        />
                        <ParentFolderRow
                            folder={parentFolder}
                            onChoose={pickParentFolder}
                            description={
                                primaryWorkspace
                                    ? `Default: ${primaryWorkspace}. Result: <parent>/${slug || '{slug}'}.agi/`
                                    : `Pick where the new envelope folder will be created. Result: <parent>/${slug || '{slug}'}.agi/`
                            }
                        />

                        <div>
                            <Text
                                size="xs"
                                style={{
                                    display: 'block',
                                    marginBottom: 6,
                                    fontWeight: 600,
                                }}
                            >
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
                                <GitHubAutoPanel
                                    gh={gh}
                                    slug={slug}
                                    owner={ghOwner}
                                    onOwnerChange={setGhOwner}
                                    isPrivate={ghPrivate}
                                    onPrivateChange={setGhPrivate}
                                    onOpenSettings={() =>
                                        api().app.showSettings().catch(() => {})
                                    }
                                />
                            )}
                        </div>

                        <Text
                            size="xs"
                            className="text-zinc-500"
                            style={{ display: 'block' }}
                        >
                            Will create <strong>{selectedRepoCount}</strong> submodule
                            {selectedRepoCount === 1 ? '' : 's'} and copy{' '}
                            <strong>{selectedKnowledgeCount}</strong> knowledge item
                            {selectedKnowledgeCount === 1 ? '' : 's'} into{' '}
                            <code>.ai/</code>.
                        </Text>
                    </Card>
                </>
            )}

            <div
                style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: 8,
                    marginTop: 4,
                }}
            >
                <Action variant="ghost" onClick={onCancel} disabled={stage === 'busy'}>
                    Cancel
                </Action>
                <Action
                    color="blue"
                    onClick={execute}
                    disabled={!scan || !planValid || stage === 'busy'}
                >
                    {stage === 'busy'
                        ? busyStep ?? 'Building envelope…'
                        : remoteMode === 'github'
                          ? 'Create on GitHub + build envelope'
                          : 'Build envelope'}
                </Action>
            </div>
        </div>
    );
}

function SourceFolderRow({
    folder,
    onPick,
    scanning,
    onRescan,
}: {
    folder: string;
    onPick: () => void;
    scanning: boolean;
    onRescan: () => void;
}) {
    return (
        <div>
            <Text size="xs" style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                Source folder
            </Text>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                    <Input
                        value={folder}
                        onValueChange={() => {}}
                        readOnly
                        placeholder="No folder chosen"
                    />
                </div>
                <Action variant="ghost" onClick={onPick} icon="folder">
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
        </div>
    );
}

function ScanSection({
    title,
    description,
    children,
}: {
    title: string;
    description: string;
    children: React.ReactNode;
}) {
    return (
        <Card style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Heading as="h3" size="sm" style={{ margin: 0 }}>
                {title}
            </Heading>
            <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                {description}
            </Text>
            {children}
        </Card>
    );
}

function ProjectPickerInline({
    projects,
    loading,
    value,
    onChange,
}: {
    projects: TynnProject[];
    loading: boolean;
    value: string;
    onChange: (id: string) => void;
}) {
    if (loading)
        return (
            <Text size="xs" className="text-zinc-500">
                Loading projects…
            </Text>
        );
    return (
        <div>
            <Text size="xs" style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                Tynn project
            </Text>
            <Select
                value={value}
                onValueChange={onChange}
                list={projects.map((p) => ({ value: p.id, label: p.name }))}
            />
        </div>
    );
}

function ParentFolderRow({
    folder,
    onChoose,
    description,
}: {
    folder: string;
    onChoose: () => void;
    description: string;
}) {
    return (
        <div>
            <Text size="xs" style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                Destination parent
            </Text>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                    <Input value={folder} readOnly placeholder="No folder chosen" />
                </div>
                <Action variant="ghost" onClick={onChoose} icon="folder">
                    Browse
                </Action>
            </div>
            {description && (
                <Text
                    size="xs"
                    className="text-zinc-500"
                    style={{ display: 'block', marginTop: 4 }}
                >
                    {description}
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

/**
 * GitHub Auto remote picker. Three states:
 *
 *  - GitHub not connected → "Connect first" prompt + Settings shortcut.
 *  - Connected, loading orgs → spinner row.
 *  - Connected + ready → owner dropdown (personal first, then each org)
 *    + visibility toggle + the URL we'll mint.
 */
function GitHubAutoPanel({
    gh,
    slug,
    owner,
    onOwnerChange,
    isPrivate,
    onPrivateChange,
    onOpenSettings,
}: {
    gh: {
        loaded: boolean;
        connected: boolean;
        username: string | null;
        orgs: Array<{ login: string }>;
        error: string | null;
    };
    slug: string;
    owner: string;
    onOwnerChange: (login: string) => void;
    isPrivate: boolean;
    onPrivateChange: (priv: boolean) => void;
    onOpenSettings: () => void;
}) {
    if (!gh.loaded) {
        return (
            <div style={{ marginTop: 8 }}>
                <Text size="xs" className="text-zinc-500">
                    Checking GitHub connection…
                </Text>
            </div>
        );
    }
    if (gh.error) {
        return (
            <div style={{ marginTop: 8 }}>
                <Text size="xs" style={{ color: 'var(--rose-500)' }}>
                    GitHub: {gh.error}
                </Text>
            </div>
        );
    }
    if (!gh.connected) {
        return (
            <div
                style={{
                    marginTop: 8,
                    padding: 10,
                    border: '1px dashed var(--border-2)',
                    borderRadius: 8,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                }}
            >
                <Text size="xs" style={{ display: 'block' }}>
                    GitHub isn't connected yet. Open <strong>Settings → GitHub</strong> and
                    finish the Device Flow, then come back here.
                </Text>
                <div>
                    <Action variant="ghost" size="sm" onClick={onOpenSettings}>
                        Open Settings…
                    </Action>
                </div>
            </div>
        );
    }

    const ownerLabel = owner || gh.username || 'me';
    const repoName = `${slug || '{slug}'}.agi`;
    const targetUrl = `https://github.com/${ownerLabel}/${repoName}`;

    const ownerOptions = [
        { value: '', label: `${gh.username ?? '(you)'} · personal` },
        ...gh.orgs.map((o) => ({ value: o.login, label: `${o.login} · org` })),
    ];

    return (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
                <Text size="xs" style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                    Owner
                </Text>
                <Select value={owner} onValueChange={onOwnerChange} list={ownerOptions} />
            </div>
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
                    checked={isPrivate}
                    onChange={(e) => onPrivateChange(e.target.checked)}
                />
                <Text size="xs">Private repository</Text>
            </label>
            <Text
                size="xs"
                className="text-zinc-500"
                style={{ display: 'block' }}
            >
                Will create <code>{targetUrl}</code>, set it as <code>origin</code>{' '}
                on the new envelope, and push the initial commit.
            </Text>
        </div>
    );
}
