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
    type SubmoduleEntry,
    type TynnProject,
    type WorkspaceRow,
} from '../lib/genie';
import {
    useGitHubAccount,
    GitHubConnect,
    GitHubErrorNotice,
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
    disposition: 'codebase' | 'knowledge' | 'root' | 'ignore';
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
        body: 'This folder is one git repo with no submodules. It becomes ONE submodule inside the envelope, and any docs/plans folders can copy into .ai/.',
        icon: 'git-branch',
    },
    'monorepo': {
        title: 'Monorepo (git submodules)',
        body: 'This folder is one git repo that itself bundles git submodules. You can EXPLODE it — add each submodule to the new envelope as its own submodule — or WRAP it whole as a single submodule. Choose on the next step.',
        icon: 'boxes',
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
    // Source can be a LOCAL folder (default) or a REMOTE git repo Genie clones
    // into a chosen parent and then analyses in place — the same workspaces.clone
    // path the Simple/Convert/Import flows use. After a clone the rest of the
    // wizard treats it exactly like a local source (it IS a local checkout).
    const [sourceMode, setSourceMode] = useState<'local' | 'remote'>('local');
    const [sourceUrl, setSourceUrl] = useState<string>('');
    const [cloneParent, setCloneParent] = useState<string>('');
    const [cloning, setCloning] = useState(false);

    // Plan state
    const [repoRows, setRepoRows] = useState<RepoRow[]>([]);
    const [knowledgeRows, setKnowledgeRows] = useState<KnowledgeRow[]>([]);
    // Single-repo / monorepo only: per-entry disposition rows replace knowledgeRows.
    const [dispositionRows, setDispositionRows] = useState<DispositionRow[]>([]);
    // Monorepo only: 'explode' = one row per declared submodule; 'wrap' = the
    // monorepo becomes ONE submodule (the legacy single-repo behaviour).
    const [monorepoMode, setMonorepoMode] = useState<'explode' | 'wrap'>('explode');
    // Monorepo explode only: submodule_name of the HOST (primary) member —
    // the repo Aionima builds. The rest are packages it consumes from the
    // registry. Defaults to the first included member.
    const [primaryName, setPrimaryName] = useState<string>('');

    // Configure state
    const [projectId, setProjectId] = useState('');
    const [slug, setSlug] = useState('');
    // True once the user has manually edited the slug — after that we stop
    // auto-deriving it (from the source basename or the chosen primary).
    const [slugTouched, setSlugTouched] = useState(false);
    const [parentFolder, setParentFolder] = useState('');
    const [primaryWorkspace, setPrimaryWorkspace] = useState<string | undefined>();
    const [remoteMode, setRemoteMode] = useState<'none' | 'paste' | 'github'>('none');
    const [remoteUrl, setRemoteUrl] = useState('');

    // Shared GitHub account — drives inline connect + owner selection for
    // BOTH the envelope remote and any repo forks. One account choice.
    const account = useGitHubAccount();
    const [ghOwner, setGhOwner] = useState<string>(''); // empty = personal user account
    // True once the user has manually picked an owner — after that we stop
    // defaulting it to the source repo's owner.
    const [ghOwnerTouched, setGhOwnerTouched] = useState(false);
    const [ghPrivate, setGhPrivate] = useState(true);

    /** Owner picker handler — records the manual choice so the source-owner
     *  default stops overriding it. */
    const chooseGhOwner = (login: string) => {
        setGhOwnerTouched(true);
        setGhOwner(login);
    };

    useEffect(() => {
        void api()
            .settings.get()
            .then((s) => {
                setPrimaryWorkspace(s.primary_workspace);
                if (!parentFolder && s.primary_workspace) {
                    setParentFolder(s.primary_workspace);
                }
                if (s.primary_workspace) {
                    setCloneParent((c) => c || s.primary_workspace!);
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

    /**
     * Build the "wrap" repoRows from analysed repo candidates — one row
     * per detected repo (for monorepo-wrap that's just the root repo; for
     * single-repo / repo-collection it's the usual set). Each origin URL is
     * parsed so the Repos step knows which rows are forkable.
     */
    const buildWrapRows = async (
        candidates: AnalyseRepoCandidate[],
    ): Promise<RepoRow[]> => {
        const refs = await Promise.all(
            candidates.map((c) =>
                c.origin_url
                    ? api().github.parseRemote(c.origin_url).catch(() => null)
                    : Promise.resolve(null),
            ),
        );
        return candidates.map((c, i) => ({
            ...c,
            included: true,
            submodule_name: c.default_name,
            source_mode: c.origin_url ? 'origin' : 'local',
            gh_ref: refs[i],
        }));
    };

    /**
     * Build the "explode" repoRows from a monorepo's member submodules —
     * one row per member (parsed `.gitmodules` entry OR detected nested
     * git repo). Members are sourced from their declared/origin URL. The
     * submodule_name is the sanitized basename of its path; gh_ref is parsed
     * so per-row fork is available. Members whose URL is a local filesystem
     * path (a nested repo with no origin remote) get source_mode 'local'
     * with origin_url null — so the executed plan submodules them straight
     * from disk (is_local) rather than treating the path as a clonable URL.
     */
    const buildExplodeRows = async (
        subs: SubmoduleEntry[],
    ): Promise<RepoRow[]> => {
        const refs = await Promise.all(
            subs.map((s) =>
                isLocalPathLike(s.url)
                    ? Promise.resolve(null)
                    : api().github.parseRemote(s.url).catch(() => null),
            ),
        );
        return subs.map((s, i) => {
            const leaf = s.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? s.name;
            const local = isLocalPathLike(s.url);
            return {
                rel_path: s.path,
                abs_path: s.url, // identity key; explode rows source from the URL
                default_name: sanitiseSubmoduleName(leaf),
                origin_url: local ? null : s.url,
                head_ref: null,
                included: true,
                submodule_name: sanitiseSubmoduleName(leaf),
                source_mode: (local ? 'local' : 'origin') as RepoSourceMode,
                gh_ref: refs[i],
            };
        });
    };

    const runScan = async (folder: string) => {
        setScanning(true);
        setError(null);
        try {
            const r = await api().agi.analyse(folder);
            setScan(r);
            // Monorepo defaults to EXPLODE: surface its member submodules as
            // rows. Everything else uses the detected repo candidates.
            let explodeRows: RepoRow[] | null = null;
            if (r.source_kind === 'monorepo' && r.submodules.length > 0) {
                setMonorepoMode('explode');
                explodeRows = await buildExplodeRows(r.submodules);
                setRepoRows(explodeRows);
                // Default the host to the first included member.
                const firstIncluded = explodeRows.find((row) => row.included);
                setPrimaryName(firstIncluded?.submodule_name ?? '');
            } else {
                setRepoRows(await buildWrapRows(r.repos));
                setPrimaryName('');
            }
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
            // Suggest a slug. For a monorepo exploded into members, default
            // it to the chosen primary's name; otherwise the source folder's
            // basename. Only auto-set until the user edits the slug.
            if (!slugTouched) {
                const primaryRow = explodeRows?.find((row) => row.included);
                if (primaryRow) {
                    setSlug(primaryRow.submodule_name.replace(/\.agi$/i, ''));
                } else {
                    const leaf = folder
                        .replace(/[\\/]+$/, '')
                        .split(/[\\/]/)
                        .pop();
                    if (leaf) setSlug(leaf.replace(/\.agi$/i, ''));
                }
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setScan(null);
        } finally {
            setScanning(false);
        }
    };

    /**
     * Switch a monorepo between explode (member submodules) and wrap (the
     * monorepo as one submodule), repopulating repoRows from the scan.
     * No-op when there's no scan or the mode is unchanged.
     */
    const setMonorepoModeAndRebuild = async (mode: 'explode' | 'wrap') => {
        if (!scan || mode === monorepoMode) return;
        setMonorepoMode(mode);
        if (mode === 'explode') {
            const rows = await buildExplodeRows(scan.submodules);
            setRepoRows(rows);
            const firstIncluded = rows.find((row) => row.included);
            setPrimaryName(firstIncluded?.submodule_name ?? '');
            if (!slugTouched && firstIncluded) {
                setSlug(firstIncluded.submodule_name.replace(/\.agi$/i, ''));
            }
        } else {
            setRepoRows(await buildWrapRows(scan.repos));
            setPrimaryName('');
        }
    };

    /**
     * Choose the host (primary) member. When the slug is still
     * auto-derived, re-derive it from the new primary's name so the
     * envelope folder tracks the host repo.
     */
    const choosePrimary = (name: string) => {
        setPrimaryName(name);
        if (!slugTouched && name) {
            setSlug(name.replace(/\.agi$/i, ''));
        }
    };

    /** Slug edited by the user — stop auto-deriving from here on. */
    const onSlugEdited = (v: string) => {
        setSlugTouched(true);
        setSlug(v);
    };

    const pickSourceFolder = async () => {
        const p = await api().settings.chooseFolder('Choose source folder to analyse');
        if (p) {
            setSourceFolder(p);
            await runScan(p);
        }
    };
    const chooseCloneParent = async () => {
        const p = await api().settings.chooseFolder('Choose where to clone the repo');
        if (p) setCloneParent(p);
    };
    // Remote source: clone the repo, then analyse the local checkout. The clone
    // lands at <cloneParent>/<repo>/; from there the wizard is identical to a
    // local source.
    const cloneAndScan = async () => {
        if (!sourceUrl.trim()) {
            setError('Enter the repository URL.');
            return;
        }
        if (!cloneParent.trim()) {
            setError('Pick where to clone the repo.');
            return;
        }
        setCloning(true);
        setError(null);
        try {
            const cloned = await api().workspaces.clone(
                sourceUrl.trim(),
                cloneParent.trim(),
            );
            setSourceFolder(cloned.path);
            await runScan(cloned.path);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setCloning(false);
        }
    };
    const pickParentFolder = async () => {
        const p = await api().settings.chooseFolder(
            'Choose destination parent folder for the new envelope',
        );
        if (p) setParentFolder(p);
    };

    // Default the GitHub owner to the SOURCE repo's owner (personal or org),
    // so a create/fork lands in the same account the original lives in — not
    // a personal-only default. We read the first included GitHub-origin repo's
    // owner; an org owner only sticks if Genie can actually act there (it's an
    // installed org), otherwise we leave it personal and the OwnerSelect
    // surfaces a per-account install prompt. Stops once the user picks an owner.
    const sourceOwner = useMemo(() => {
        const withRef = repoRows.find((r) => r.included && r.gh_ref);
        return withRef?.gh_ref?.owner ?? null;
    }, [repoRows]);
    useEffect(() => {
        if (ghOwnerTouched || !account.connected || !sourceOwner) return;
        if (!account.installationsLoaded) return;
        // Only default to the source owner when it's an installed ORG (the
        // personal account is the empty-string default already, and forking a
        // personal repo into its own owner is invalid).
        const inst = account.installations.find((i) => i.login === sourceOwner);
        if (inst?.isOrg && ghOwner !== sourceOwner) {
            setGhOwner(sourceOwner);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sourceOwner, account.connected, account.installationsLoaded, ghOwnerTouched]);

    const selectedRepoCount = useMemo(
        () => repoRows.filter((r) => r.included).length,
        [repoRows],
    );
    // Both single-repo and monorepo sources have a root git store, so the
    // Knowledge step uses the per-entry disposition table (root_entries),
    // not the knowledge-candidates table.
    const usesDisposition =
        scan?.source_kind === 'single-repo' || scan?.source_kind === 'monorepo';
    const selectedKnowledgeCount = useMemo(
        () =>
            usesDisposition
                ? dispositionRows.filter(
                      (r) => r.disposition !== 'codebase' && r.disposition !== 'ignore',
                  ).length
                : knowledgeRows.filter((r) => r.included).length,
        [usesDisposition, dispositionRows, knowledgeRows],
    );

    const repoNamesValid = useMemo(() => {
        const names = repoRows
            .filter((r) => r.included)
            .map((r) => r.submodule_name.trim());
        if (names.some((n) => !n)) return false;
        return new Set(names).size === names.length;
    }, [repoRows]);

    const isExplodeMono =
        scan?.source_kind === 'monorepo' && monorepoMode === 'explode';

    // Keep the host valid: if the chosen primary was unchecked or renamed
    // away, repick the first included member so a host always exists while
    // there are members. Uses submodule_name (the identity the plan uses).
    useEffect(() => {
        if (!isExplodeMono) return;
        const included = repoRows.filter((r) => r.included);
        if (included.length === 0) {
            if (primaryName) setPrimaryName('');
            return;
        }
        if (!included.some((r) => r.submodule_name.trim() === primaryName)) {
            const next = included[0].submodule_name.trim();
            setPrimaryName(next);
            if (!slugTouched && next) setSlug(next.replace(/\.agi$/i, ''));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isExplodeMono, repoRows, primaryName]);

    // For an exploded monorepo, a host must be designated among the
    // included members (the effect above guarantees one whenever members
    // exist, so this just guards the empty-members edge).
    const hostValid =
        !isExplodeMono ||
        repoRows.some((r) => r.included && r.submodule_name.trim() === primaryName);

    const planValid =
        slug.trim().length > 0 &&
        parentFolder.trim().length > 0 &&
        projectId.length > 0 &&
        repoNamesValid &&
        hostValid &&
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
            // The fork destination's numeric id pre-targets the install
            // chooser at THAT account if Genie isn't installed there (instead
            // of failing or defaulting elsewhere). Prefer the known
            // installation id; empty owner = personal (no id needed).
            const intoOrgId = ghOwner
                ? account.installations.find((i) => i.login === ghOwner)?.id ?? null
                : null;
            for (const r of forkRows) {
                if (!account.connected) {
                    throw new Error('Connect GitHub to fork repositories.');
                }
                setBusyStep(`Forking ${r.gh_ref!.owner}/${r.gh_ref!.repo}…`);
                const fork = await api().github.forkRepo({
                    owner: r.gh_ref!.owner,
                    repo: r.gh_ref!.repo,
                    intoOrg: ghOwner || null,
                    intoOrgId,
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
                    ownerId: ghOwner
                        ? account.installations.find((i) => i.login === ghOwner)?.id ?? null
                        : null,
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
                knowledge: usesDisposition
                    ? dispositionRows
                          // 'codebase' stays in the repo; 'ignore' is left out
                          // of the .agi mapping entirely — neither is copied.
                          .filter(
                              (r) =>
                                  r.disposition !== 'codebase' &&
                                  r.disposition !== 'ignore',
                          )
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
                // Host designation: only meaningful when exploding a
                // monorepo into N members. Wrap/single-repo leave it unset
                // (convert treats a lone repo as the host automatically).
                primary: isExplodeMono ? primaryName : undefined,
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
                            sourceMode={sourceMode}
                            onSourceModeChange={setSourceMode}
                            sourceUrl={sourceUrl}
                            onSourceUrlChange={setSourceUrl}
                            cloneParent={cloneParent}
                            onChooseCloneParent={chooseCloneParent}
                            cloning={cloning}
                            onClone={() => void cloneAndScan()}
                            primaryWorkspace={primaryWorkspace}
                        />
                    </Carousel.Slide>

                    <Carousel.Slide name="Repos">
                        <ReposStep
                            kind={scan?.source_kind ?? 'plain-folder'}
                            rows={repoRows}
                            setRows={setRepoRows}
                            namesValid={repoNamesValid}
                            account={account}
                            monorepoMode={monorepoMode}
                            onMonorepoModeChange={(m) =>
                                void setMonorepoModeAndRebuild(m)
                            }
                            submoduleCount={scan?.submodules.length ?? 0}
                            showPrimaryPicker={isExplodeMono}
                            primaryName={primaryName}
                            onChoosePrimary={choosePrimary}
                        />
                    </Carousel.Slide>

                    <Carousel.Slide name="Knowledge">
                        {usesDisposition ? (
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
                            setSlug={onSlugEdited}
                            parentFolder={parentFolder}
                            onPickParent={pickParentFolder}
                            primaryWorkspace={primaryWorkspace}
                            remoteMode={remoteMode}
                            setRemoteMode={setRemoteMode}
                            remoteUrl={remoteUrl}
                            setRemoteUrl={setRemoteUrl}
                            account={account}
                            ghOwner={ghOwner}
                            setGhOwner={chooseGhOwner}
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
                    <div style={{ marginTop: 8 }}>
                        <GitHubErrorNotice message={error} />
                    </div>
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
    sourceMode,
    onSourceModeChange,
    sourceUrl,
    onSourceUrlChange,
    cloneParent,
    onChooseCloneParent,
    cloning,
    onClone,
    primaryWorkspace,
}: {
    folder: string;
    scan: AnalyseResult | null;
    scanning: boolean;
    onPick: () => void;
    onRescan: () => void;
    sourceMode: 'local' | 'remote';
    onSourceModeChange: (m: 'local' | 'remote') => void;
    sourceUrl: string;
    onSourceUrlChange: (v: string) => void;
    cloneParent: string;
    onChooseCloneParent: () => void;
    cloning: boolean;
    onClone: () => void;
    primaryWorkspace?: string;
}) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                Pick the source to upgrade — a local folder or a remote git repo
                Genie clones first. Genie reads its layout (never modifies it) and
                figures out whether it's a single repo, a collection of repos, or a
                plain folder.
            </Text>
            <div style={{ display: 'flex', gap: 8 }}>
                {(['local', 'remote'] as const).map((m) => (
                    <Action
                        key={m}
                        size="sm"
                        variant={sourceMode === m ? 'default' : 'ghost'}
                        color={sourceMode === m ? 'blue' : undefined}
                        onClick={() => onSourceModeChange(m)}
                        disabled={scanning || cloning}
                    >
                        {m === 'local' ? 'Local folder' : 'Remote repo'}
                    </Action>
                ))}
            </div>

            {sourceMode === 'local' ? (
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
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <Input
                        label="Repository URL"
                        description="Genie clones it with your existing git auth (SSH key / credential helper), then analyses the clone; submodules included."
                        value={sourceUrl}
                        onValueChange={onSourceUrlChange}
                        placeholder="git@github.com:owner/repo.git"
                    />
                    <div>
                        <Text size="xs" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
                            Clone destination parent
                        </Text>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                            <div style={{ flex: 1 }}>
                                <Input value={cloneParent} readOnly placeholder="No folder chosen" />
                            </div>
                            <Action
                                variant="ghost"
                                onClick={onChooseCloneParent}
                                icon="folder"
                                disabled={cloning}
                            >
                                Browse
                            </Action>
                        </div>
                        <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 4 }}>
                            {primaryWorkspace
                                ? `Default: ${primaryWorkspace}. The repo lands at <parent>/<repo>/.`
                                : 'Where to clone the repo. It lands at <parent>/<repo>/.'}
                        </Text>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <Action
                            size="sm"
                            color="blue"
                            icon="download"
                            disabled={cloning || scanning || !sourceUrl.trim() || !cloneParent.trim()}
                            onClick={onClone}
                        >
                            {cloning ? 'Cloning…' : scanning ? 'Scanning…' : 'Clone & scan'}
                        </Action>
                        {folder && !cloning && (
                            <Text size="xs" className="text-zinc-500">
                                Cloned to {folder}
                            </Text>
                        )}
                        {folder && !cloning && !scanning && (
                            <Action variant="ghost" onClick={onRescan} icon="refresh-cw">
                                Re-scan
                            </Action>
                        )}
                    </div>
                </div>
            )}

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
    monorepoMode,
    onMonorepoModeChange,
    submoduleCount,
    showPrimaryPicker,
    primaryName,
    onChoosePrimary,
}: {
    kind: SourceKind;
    rows: RepoRow[];
    setRows: React.Dispatch<React.SetStateAction<RepoRow[]>>;
    namesValid: boolean;
    account: GitHubAccount;
    monorepoMode: 'explode' | 'wrap';
    onMonorepoModeChange: (m: 'explode' | 'wrap') => void;
    submoduleCount: number;
    /** True when exploding a monorepo — show the host (primary) picker. */
    showPrimaryPicker: boolean;
    /** submodule_name of the currently-chosen host. */
    primaryName: string;
    onChoosePrimary: (name: string) => void;
}) {
    const patchRow = (i: number, patch: Partial<RepoRow>) =>
        setRows((rs) => rs.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

    const isMonorepo = kind === 'monorepo';

    // Monorepo toggle — rendered even when (in some transient state) rows are
    // empty, so the user can always switch handling mode.
    const monorepoToggle = isMonorepo ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                This monorepo declares <strong>{submoduleCount}</strong> submodule
                {submoduleCount === 1 ? '' : 's'}. Choose how to bring it into the
                envelope:
            </Text>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {([
                    { value: 'explode', label: `Explode into ${submoduleCount} submodule${submoduleCount === 1 ? '' : 's'}` },
                    { value: 'wrap', label: 'Wrap whole (one submodule)' },
                ] as const).map((opt) => (
                    <Action
                        key={opt.value}
                        size="sm"
                        variant={monorepoMode === opt.value ? 'default' : 'ghost'}
                        color={monorepoMode === opt.value ? 'blue' : undefined}
                        onClick={() => onMonorepoModeChange(opt.value)}
                    >
                        {opt.label}
                    </Action>
                ))}
            </div>
            <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                {monorepoMode === 'explode'
                    ? 'Each member submodule is added to the new envelope as its own submodule — a flat multi-repo envelope of the monorepo’s members.'
                    : 'The whole monorepo becomes ONE submodule under repos/, with its own submodules nested inside it as-is.'}
            </Text>
        </div>
    ) : null;

    if (rows.length === 0) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {monorepoToggle}
                <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                    No git repos detected — the envelope starts without submodules.
                    You can add repos later with <code>git submodule add</code> or
                    from the workspace context menu.
                </Text>
            </div>
        );
    }

    const anyForkable = rows.some((r) => r.gh_ref);
    const wantsFork = rows.some((r) => r.included && r.source_mode === 'fork');

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {monorepoToggle}
            <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                {kind === 'single-repo'
                    ? 'The source repo becomes one submodule under repos/. Rename it if the folder name is unfortunate.'
                    : isMonorepo && monorepoMode === 'explode'
                        ? 'Each member submodule becomes a git submodule under repos/. Uncheck the ones you don’t want; rename where needed.'
                        : isMonorepo
                            ? 'The monorepo becomes one submodule under repos/. Rename it if the folder name is unfortunate.'
                            : 'Each detected repo becomes a git submodule under repos/. Uncheck the ones you don’t want; rename where needed.'}{' '}
                <strong>Origin</strong> clones from the existing remote;{' '}
                <strong>Fork</strong> forks it into your account/org first (the
                Teams/Agents path — work on your fork, PR back);{' '}
                <strong>Local</strong> submodules straight from the folder on disk.
            </Text>

            {showPrimaryPicker && (
                <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                    Pick the <strong>host</strong> — the one repo Aionima builds and
                    hosts. The rest become <strong>packages</strong> the host consumes
                    from the npm/composer registry (nothing in any build config is
                    rewritten). The envelope slug defaults to the host’s name.
                </Text>
            )}

            {anyForkable && (
                <div className="gh-inline">
                    <GitHubConnect account={account} />
                </div>
            )}

            <table className="upgrade-tbl">
                <thead>
                    <tr>
                        <th />
                        {showPrimaryPicker && <th>Host</th>}
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
                                {showPrimaryPicker && (
                                    <td style={{ textAlign: 'center' }}>
                                        <input
                                            type="radio"
                                            name="agi-primary-host"
                                            title={
                                                r.included
                                                    ? 'Make this the host (build target)'
                                                    : 'Include the repo to make it the host'
                                            }
                                            checked={
                                                r.included &&
                                                r.submodule_name.trim() === primaryName
                                            }
                                            disabled={!r.included}
                                            onChange={() =>
                                                onChoosePrimary(r.submodule_name.trim())
                                            }
                                        />
                                    </td>
                                )}
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
                <strong>Root</strong> (beside <code>project.json</code>). Pick{' '}
                <strong>Ignore</strong> to leave an item out of the envelope
                entirely (nothing is moved or copied).
            </Text>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Text size="xs" className="text-zinc-500">
                    Set all:
                </Text>
                {(['codebase', 'knowledge', 'root', 'ignore'] as const).map((d) => (
                    <Action key={d} size="sm" variant="ghost" onClick={() => setAll(d)}>
                        {d === 'codebase'
                            ? 'Codebase'
                            : d === 'knowledge'
                                ? 'Knowledge'
                                : d === 'root'
                                    ? 'Root'
                                    : 'Ignore'}
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
                                        { value: 'ignore', label: 'Ignore (leave out)' },
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
                                            : r.disposition === 'ignore'
                                                ? 'left out'
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
                        placeholder="Choose a project…"
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

/**
 * Mirror of analyse.ts's sanitiseRepoName for explode-row submodule names:
 * drop a leading underscore and replace characters git refuses in a
 * submodule path. Keeps renderer-side defaults consistent with the backend
 * validation in convertToAgiPlan (which enforces [A-Za-z0-9._-]).
 */
function sanitiseSubmoduleName(name: string): string {
    return name.replace(/^_+/, '').replace(/[^A-Za-z0-9._-]/g, '-') || name;
}

/**
 * True for absolute local paths (POSIX or Windows) and `file://` URLs —
 * mirrors main's isLocalPathLikeUrl. A monorepo member with no origin
 * remote falls back to its absolute local path as the submodule source;
 * this lets the explode row treat it as a local (is_local) submodule
 * instead of a clonable remote URL.
 */
function isLocalPathLike(value: string): boolean {
    if (value.startsWith('file://')) return true;
    if (value.startsWith('/')) return true;
    if (/^[A-Za-z]:[\\/]/.test(value)) return true;
    return false;
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

