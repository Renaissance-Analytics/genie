import React, { useEffect, useMemo, useState } from 'react';
import { projectPickerOptions } from '../lib/project-picker';
import {
    Action,
    Card,
    Heading,
    Icon,
    Input,
    Modal,
    Select,
    Text,
} from '@particle-academy/react-fancy';
import { api, ulid } from '../lib/genie';
import { pickPath } from './FilePickerModal';
import type {
    OwnerOption,
    TynnProject,
    WorkspaceRow,
} from '../lib/genie';
import InteractiveUpgradeWizard from './InteractiveUpgradeWizard';
import {
    useGitHubAccount,
    OwnerSelect,
    GitHubErrorNotice,
} from './GitHubConnect';
import { useGithubCapabilities } from '../lib/githubCapabilities';
import {
    ADD_WORKSPACE_SOURCES,
    containerRepoPlan,
    workspaceFolderName,
    workspacePathPreview,
    workspaceSlug,
    workspaceWizardEntry,
    type AddWorkspaceSource,
    type AddWorkspaceSourceId,
    type ContainerRepoPlan,
} from '../lib/workspace-onboarding';
import {
    importTynnEnvelopeWorkspace,
    tynnImportChoices,
    tynnImportRoute,
    type TynnImportRoute,
} from '../lib/tynn-import';

type Stage =
    | 'source'
    // genie#431: MAKING a workspace. Name + location, straight to `agi.create`.
    // There is nothing to inspect, so nothing inspects.
    | 'create'
    | 'tynn-import'
    // genie#355: a Tynn project that already IS a Genie workspace. Ask where to
    // put it, clone, register — the scan-and-convert wizard has nothing to do.
    | 'tynn-envelope'
    // …and one already registered on this machine: offer to open it rather than
    // import a second copy of the same thing.
    | 'tynn-open-existing'
    | 'gapp-create'
    // ADOPTING something that exists: a folder, or a repository. This is the one
    // route that scans, because it is the only one with something to read.
    | 'inspect'
    | 'done';

interface Props {
    onClose: () => void;
    onAdded: (row: WorkspaceRow) => void;
}

export default function AddWorkspaceModal({ onClose, onAdded }: Props) {
    const [stage, setStage] = useState<Stage>('source');
    const [projects, setProjects] = useState<TynnProject[]>([]);
    const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
    const [loadingProjects, setLoadingProjects] = useState(true);
    const [projectsError, setProjectsError] = useState<string | null>(null);
    const [interactiveMode, setInteractiveMode] = useState<'local' | 'remote'>('local');
    const [interactiveSourceUrl, setInteractiveSourceUrl] = useState('');
    const [interactiveProjectId, setInteractiveProjectId] = useState('');
    const [createProjectId, setCreateProjectId] = useState('');
    const [createGappDev, setCreateGappDev] = useState(false);
    // The Tynn project the import is acting on, plus the route `tynnImportRoute`
    // chose for it — the source to clone, or the workspace already here.
    const [tynnProject, setTynnProject] = useState<TynnProject | null>(null);
    const [tynnEnvelopeSource, setTynnEnvelopeSource] = useState<{ url: string; branch: string } | null>(null);
    const [tynnExistingWorkspaceId, setTynnExistingWorkspaceId] = useState('');

    useEffect(() => {
        Promise.all([api().tynn.projects(), api().workspaces.list()])
            .then(([p, w]) => {
                setProjects(p);
                setWorkspaces(w);
            })
            .catch((cause) => setProjectsError(cause instanceof Error ? cause.message : String(cause)))
            .finally(() => setLoadingProjects(false));
    }, []);

    // A project created inline from the "Create new project" affordance gets
    // appended to the shared list (so the picker can select it) and floated to
    // the top so it's the obvious pick.
    const onProjectCreated = (p: TynnProject) =>
        setProjects((prev) => [p, ...prev.filter((x) => x.id !== p.id)]);

    return (
        // The inspect wizard carries step tables — give it the widest modal so
        // nothing clips; the simpler flows stay at lg.
        <Modal open onClose={onClose} size={stage === 'inspect' ? 'xl' : 'lg'}>
            <Modal.Header>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Icon name="folder-plus" size="sm" /> Add workspace
                </span>
            </Modal.Header>
            <Modal.Body>
                {stage === 'source' && <ManagedSourcePicker onPick={(source) => {
                    // One route per KIND of act. `create` makes something and so
                    // has nothing to read; `local`/`remote` adopt something and so
                    // read it first (genie#431).
                    const entry = workspaceWizardEntry(source);
                    if (entry.mode === 'tynn') setStage('tynn-import');
                    else if (entry.mode === 'gapp') setStage('gapp-create');
                    else if (entry.mode === 'create') {
                        setCreateProjectId('');
                        setCreateGappDev(false);
                        setStage('create');
                    } else {
                        setInteractiveMode(entry.mode);
                        setStage('inspect');
                    }
                }} />}
                {stage === 'gapp-create' && (
                    <CreateProjectForm
                        isGapp
                        onCancel={() => setStage('source')}
                        onCreated={(project) => {
                            onProjectCreated(project);
                            setCreateProjectId(project.id);
                            setCreateGappDev(true);
                            setStage('create');
                        }}
                    />
                )}
                {stage === 'inspect' && (
                    <InteractiveUpgradeWizard
                        initialSourceMode={interactiveMode}
                        initialSourceUrl={interactiveSourceUrl}
                        initialProjectId={interactiveProjectId}
                        projects={projects}
                        loadingProjects={loadingProjects}
                        onCancel={() => setStage('source')}
                        onCreated={(row) => {
                            onAdded(row);
                            setStage('done');
                            onClose();
                        }}
                    />
                )}
                {stage === 'create' && (
                    <CreateWorkspaceForm
                        initialProjectId={createProjectId}
                        gappDev={createGappDev}
                        projects={projects}
                        loadingProjects={loadingProjects}
                        onProjectCreated={onProjectCreated}
                        onCancel={() => setStage('source')}
                        onCreated={(row) => {
                            onAdded(row);
                            setStage('done');
                            onClose();
                        }}
                    />
                )}
                {stage === 'tynn-import' && (
                    <TynnImportWizard
                        projects={projects}
                        workspaces={workspaces}
                        loading={loadingProjects}
                        loadError={projectsError}
                        onCancel={() => setStage('source')}
                        // The routing decision is `tynnImportRoute`'s, not this
                        // component's — genie#355 was one unconditional
                        // `setStage('inspect')` sitting exactly here.
                        onRoute={(project, route) => {
                            setTynnProject(project);
                            if (route.stage === 'tynn-envelope') {
                                setTynnEnvelopeSource(route.source);
                                setStage('tynn-envelope');
                                return;
                            }
                            if (route.stage === 'tynn-open-existing') {
                                setTynnExistingWorkspaceId(route.workspaceId);
                                setStage('tynn-open-existing');
                                return;
                            }
                            setInteractiveMode(route.mode);
                            setInteractiveSourceUrl(route.sourceUrl);
                            setInteractiveProjectId(project.id);
                            setStage('inspect');
                        }}
                    />
                )}
                {stage === 'tynn-envelope' && tynnProject && tynnEnvelopeSource && (
                    <TynnEnvelopeImport
                        project={tynnProject}
                        source={tynnEnvelopeSource}
                        onBack={() => setStage('tynn-import')}
                        onCreated={(row) => {
                            onAdded(row);
                            setStage('done');
                            onClose();
                        }}
                    />
                )}
                {stage === 'tynn-open-existing' && tynnProject && (
                    <TynnAlreadyImported
                        project={tynnProject}
                        workspace={workspaces.find((w) => w.id === tynnExistingWorkspaceId) ?? null}
                        onBack={() => setStage('tynn-import')}
                        onOpened={onClose}
                    />
                )}
            </Modal.Body>
        </Modal>
    );
}

function TynnImportWizard({
    projects,
    workspaces,
    loading,
    loadError,
    onCancel,
    onRoute,
}: {
    projects: TynnProject[];
    workspaces: WorkspaceRow[];
    loading: boolean;
    loadError: string | null;
    onCancel: () => void;
    onRoute: (project: TynnProject, route: TynnImportRoute) => void;
}) {
    // Every accessible project, the already-linked ones INCLUDED and labelled:
    // dropping them silently is what made "Genie can't see my project" and "this
    // project is already here" look identical in the picker.
    const choices = tynnImportChoices(projects, workspaces);
    const [projectId, setProjectId] = useState('');

    const chosen = choices.find((choice) => choice.project.id === projectId);
    const route = chosen ? tynnImportRoute(chosen.project, workspaces) : null;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
                <Heading as="h3" size="sm">Import from Tynn</Heading>
                <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 4 }}>
                    Choose one of your Tynn projects. A project that is already a Genie workspace is cloned straight onto this machine, repositories and all — Genie only asks where to put it. Anything else is inspected first, and you approve the plan before anything is written.
                </Text>
            </div>
            <Select
                value={projectId}
                onValueChange={setProjectId}
                list={choices.map(({ project, linkedWorkspaceId }) => ({
                    value: project.id,
                    label: linkedWorkspaceId ? `${project.name} — already added` : project.name,
                }))}
                placeholder={loading ? 'Loading Tynn projects…' : choices.length ? 'Choose a project…' : 'No Tynn projects available'}
                aria-label="Tynn workspace"
            />
            {route?.stage === 'tynn-envelope' && (
                <Text size="xs" className="text-emerald-500">
                    Already a Genie workspace — Genie will clone {route.source.url} and register it. Nothing to set up.
                </Text>
            )}
            {route?.stage === 'tynn-open-existing' && (
                <Text size="xs" className="text-amber-500">
                    This project is already a workspace on this machine.
                </Text>
            )}
            {route?.reason === 'envelope-repo-undeclared' && (
                <Text size="xs" className="text-amber-500">
                    Tynn marks this project as a workspace but does not say which repository holds it, so Genie has nothing to clone. Genie will inspect the project instead.
                </Text>
            )}
            {loadError && (
                <Text size="xs" className="text-rose-500">
                    Genie could not load Tynn workspaces: {loadError}
                </Text>
            )}
            <Footer
                onCancel={onCancel}
                onSubmit={() => {
                    if (chosen && route) onRoute(chosen.project, route);
                }}
                submitting={false}
                label={
                    route?.stage === 'tynn-envelope'
                        ? 'Choose location'
                        : route?.stage === 'tynn-open-existing'
                            ? 'Open workspace'
                            : 'Inspect workspace'
                }
                disabled={!route}
            />
        </div>
    );
}

/**
 * genie#355 — the whole import for a project that is ALREADY a Genie workspace:
 * ONE question, "where do you want it?", then clone + register. No repo picker
 * (the workspace carries its repos as submodules, so asking which one to clone
 * inverts the model) and no scan-and-convert wizard (there is nothing to
 * convert).
 */
function TynnEnvelopeImport({
    project,
    source,
    onBack,
    onCreated,
}: {
    project: TynnProject;
    source: { url: string; branch: string };
    onBack: () => void;
    onCreated: (row: WorkspaceRow) => void;
}) {
    const [parent, setParent] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [primaryWorkspace, setPrimaryWorkspace] = useState<string | undefined>();

    useEffect(() => {
        let live = true;
        api()
            .settings.get()
            .then((s) => {
                if (!live) return;
                setPrimaryWorkspace(s.primary_workspace);
                if (s.primary_workspace) setParent((p) => p || s.primary_workspace!);
            })
            .catch(() => {
                /* no default parent; the user picks one below */
            });
        return () => {
            live = false;
        };
    }, []);

    const submit = async () => {
        setBusy(true);
        setError(null);
        try {
            const saved = await importTynnEnvelopeWorkspace(
                { project, source, parentPath: parent },
                {
                    // `workspaces.clone` clones with `--recurse-submodules`, so the
                    // envelope's repos are present when this returns.
                    clone: (url, parentPath) => api().workspaces.clone(url, parentPath),
                    defaultEnvFile: async () => (await api().settings.get()).default_env_file ?? '.env',
                    addWorkspace: (row) => api().workspaces.add(row),
                },
            );
            onCreated(saved);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
                <Heading as="h3" size="sm">Where should {project.name} live?</Heading>
                <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 4 }}>
                    {project.name} is already a Genie workspace. Genie clones{' '}
                    <code>{source.url}</code> ({source.branch}) with all its repositories and
                    registers it — there is nothing to inspect.
                </Text>
            </div>
            <FolderRow
                folder={parent}
                onChoose={async () => {
                    const p = await pickPath({ mode: 'directory', title: 'Choose where to clone the workspace' });
                    if (p) setParent(p);
                }}
                description={
                    primaryWorkspace
                        ? `Parent folder (default: ${primaryWorkspace}). The workspace lands at <parent>/<repo>/.`
                        : 'Parent folder. The workspace lands at <parent>/<repo>/.'
                }
            />
            {error && (
                <Text size="xs" className="text-rose-500">
                    {error}
                </Text>
            )}
            <Footer
                onCancel={onBack}
                onSubmit={() => void submit()}
                submitting={busy}
                label="Clone & add workspace"
                disabled={!parent.trim()}
            />
        </div>
    );
}

/**
 * The project already has a workspace here. Importing again would clone a second
 * copy of the same envelope and leave two rows pointing at one project, so the
 * offer is to open the one that exists.
 */
function TynnAlreadyImported({
    project,
    workspace,
    onBack,
    onOpened,
}: {
    project: TynnProject;
    workspace: WorkspaceRow | null;
    onBack: () => void;
    onOpened: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const open = async () => {
        if (!workspace) return;
        setBusy(true);
        setError(null);
        try {
            await api().workspaces.open(workspace.id);
            onOpened();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
        }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
                <Heading as="h3" size="sm">{project.name} is already here</Heading>
                <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 4 }}>
                    A workspace on this machine is already linked to this Tynn project
                    {workspace ? <> at <code>{workspace.path}</code></> : null}. Open it instead of
                    cloning a second copy.
                </Text>
            </div>
            {error && (
                <Text size="xs" className="text-rose-500">
                    {error}
                </Text>
            )}
            <Footer
                onCancel={onBack}
                onSubmit={() => void open()}
                submitting={busy}
                label="Open workspace"
                disabled={!workspace}
            />
        </div>
    );
}

function ManagedSourcePicker({ onPick }: { onPick: (source: AddWorkspaceSourceId) => void }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
                <Heading as="h3" size="sm">How should Genie start?</Heading>
                <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 4 }}>
                    Start something new, or bring in what you already have — Genie reads a folder or
                    repository before it writes anything, and shows you the plan first.
                </Text>
            </div>
            {/* Two groups, because there are two acts (genie#431) — and a flat
                row of five cards would say they were all the same one. */}
            <SourceGroup
                label="Start something new"
                sources={ADD_WORKSPACE_SOURCES.filter((s) => s.group === 'create')}
                columns={2}
                onPick={onPick}
            />
            <SourceGroup
                label="Bring in what you already have"
                sources={ADD_WORKSPACE_SOURCES.filter((s) => s.group === 'adopt')}
                columns={3}
                onPick={onPick}
            />
        </div>
    );
}

function SourceGroup({
    label,
    sources,
    columns,
    onPick,
}: {
    label: string;
    sources: readonly AddWorkspaceSource[];
    columns: number;
    onPick: (source: AddWorkspaceSourceId) => void;
}) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Text
                size="xs"
                className="text-zinc-500"
                style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}
            >
                {label}
            </Text>
            <div
                style={{
                    display: 'grid',
                    gap: 12,
                    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                }}
            >
                {sources.map((source) => (
                    <Card
                        key={source.id}
                        style={{ padding: 16, cursor: 'pointer', minHeight: 140 }}
                        onClick={() => onPick(source.id)}
                    >
                        <Icon name={source.icon as never} size="lg" className="text-violet-500" />
                        <Heading as="h3" size="sm" style={{ marginTop: 10 }}>{source.title}</Heading>
                        <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 6, lineHeight: 1.5 }}>
                            {source.description}
                        </Text>
                    </Card>
                ))}
            </div>
        </div>
    );
}

/**
 * Making a workspace — the whole of it (genie#431).
 *
 * Name it, say where it lives, done. No scan, no plan to approve, no wizard:
 * the folder does not exist yet, so there is nothing to read and nothing to
 * decide. "New workspace" used to open the inspect-and-convert wizard and ask
 * which existing folder to convert, which is a question with no answer when you
 * are starting from nothing — so there was no way to create an empty workspace
 * at all.
 *
 * The container repository is DERIVED, never asked (`containerRepoPlan`): GitHub
 * connected means the workspace gets one, and GitHub absent or unhappy means it
 * does not. Either way the workspace is created — a repository the user did not
 * ask for must never be able to stop them making a folder. When GitHub does let
 * them down, the workspace is already on disk and the form says so instead of
 * closing as though everything went to plan.
 */
function CreateWorkspaceForm({
    initialProjectId = '',
    gappDev = false,
    projects,
    loadingProjects,
    onProjectCreated,
    onCancel,
    onCreated,
}: {
    initialProjectId?: string;
    /** Set by the "New GApp workspace" route; the plain route never asks. */
    gappDev?: boolean;
    projects: TynnProject[];
    loadingProjects: boolean;
    onProjectCreated: (p: TynnProject) => void;
    onCancel: () => void;
    onCreated: (row: WorkspaceRow) => void;
}) {
    const [projectId, setProjectId] = useState(initialProjectId);
    const [name, setName] = useState('');
    const [nameTouched, setNameTouched] = useState(false);
    const [parentFolder, setParentFolder] = useState('');
    const [primaryWorkspace, setPrimaryWorkspace] = useState<string | undefined>();
    const [owner, setOwner] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Created, but GitHub did not go to plan. The workspace EXISTS, so this is
    // not an error state — it is a finished one with something to say.
    const [partial, setPartial] = useState<{ row: WorkspaceRow; problem: string } | null>(null);
    const account = useGitHubAccount();
    // Creating a repo needs the App's `contents` write permission. Without it
    // the workspace is local-only rather than a 403 halfway through the flow.
    const { caps: githubCaps } = useGithubCapabilities();

    useEffect(() => {
        api()
            .settings.get()
            .then((s) => {
                setPrimaryWorkspace(s.primary_workspace);
                if (s.primary_workspace) setParentFolder((p) => p || s.primary_workspace!);
            })
            .catch(() => {
                /* no default parent; the user picks one below */
            });
    }, []);

    // A chosen Tynn project names the workspace until the user names it themselves.
    useEffect(() => {
        const project = projects.find((p) => p.id === projectId);
        if (project && !nameTouched) setName(project.name);
    }, [projectId, projects, nameTouched]);

    const folder = workspaceFolderName(name);
    const plan = containerRepoPlan({
        githubConnected: account.connected,
        githubCanProvision: !(
            githubCaps.connected && githubCaps.missing.includes('github.provision')
        ),
        owner: owner || account.username || '',
        slug: name,
    });

    const submit = async () => {
        setSubmitting(true);
        setError(null);
        try {
            const project = projects.find((p) => p.id === projectId);
            const slug = workspaceSlug(name);
            if (!slug) throw new Error('Give the workspace a name.');
            if (!parentFolder) throw new Error('Choose where the workspace should live.');

            // The repository has to exist before the first push, so it is made
            // first — but a failure here is a NOTE, not a stop. Genie carries on
            // and creates the workspace on this machine.
            let remote: { kind: 'none' } | { kind: 'paste'; url: string } = { kind: 'none' };
            let problem: string | null = null;
            if (plan.kind === 'github') {
                try {
                    const created = await api().github.createRepo({
                        name: plan.repo,
                        owner: owner || null,
                        // Pre-target the install chooser at the chosen org if Genie
                        // isn't installed there, so the prompt lands on the right
                        // account instead of failing.
                        ownerId: owner
                            ? account.installations.find((i) => i.login === owner)?.id ?? null
                            : null,
                        description: `Genie workspace for ${project?.name || name.trim()}`,
                        private: true,
                    });
                    remote = { kind: 'paste', url: created.clone_url };
                } catch (cause) {
                    problem = `Genie could not create ${plan.owner ? `${plan.owner}/` : ''}${
                        plan.repo
                    } on GitHub: ${cause instanceof Error ? cause.message : String(cause)}`;
                }
            }

            const res = await api().agi.create({
                slug,
                name: project?.name || name.trim(),
                parent_path: parentFolder,
                remote,
            });

            if (remote.kind === 'paste') {
                try {
                    await api().agi.push(res.path, 'main');
                } catch (cause) {
                    problem = `The workspace is on this machine, but Genie could not push it to ${
                        remote.url
                    }: ${cause instanceof Error ? cause.message : String(cause)}`;
                }
            }

            const settings = await api().settings.get();
            const row: WorkspaceRow = {
                id: project?.id ?? ulid(),
                backend: project?.backend ?? 'tynn',
                project_id: project?.id ?? '',
                project_name: project?.name ?? name.trim(),
                tynn_project_id: project?.id ?? '',
                tynn_project_name: project?.name ?? '',
                shape: 'agi',
                path: res.path,
                editor: null,
                editor_cmd: null,
                start_cmd: null,
                env_file: settings.default_env_file ?? '.env',
                last_opened_at: null,
                created_by_genie: 1,
                gapp_dev: gappDev ? 1 : 0,
            };
            const saved = await api().workspaces.add(row);
            if (problem) setPartial({ row: saved, problem });
            else onCreated(saved);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSubmitting(false);
        }
    };

    if (partial) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                    <Heading as="h3" size="sm">
                        {partial.row.project_name || name.trim()} is ready
                    </Heading>
                    <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 4 }}>
                        The workspace is at <code>{partial.row.path}</code>. GitHub did not go to
                        plan, which does not affect the workspace — you can connect it to a
                        repository later.
                    </Text>
                </div>
                <Text size="xs" className="text-amber-500">
                    {partial.problem}
                </Text>
                <Footer
                    onCancel={onCancel}
                    onSubmit={() => onCreated(partial.row)}
                    submitting={false}
                    label="Open workspace"
                    disabled={false}
                />
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
                <Heading as="h3" size="sm">
                    {gappDev ? 'New GApp workspace' : 'New workspace'}
                </Heading>
                <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 4 }}>
                    {gappDev
                        ? 'Genie creates the folder, its first commit, and the GApp build and preview workflows.'
                        : 'Genie creates the folder and its first commit. Nothing is scanned and nothing existing is touched.'}
                </Text>
            </div>

            <Input
                label="Workspace name"
                // The Fancy `label` prop draws the caption; the accessible name
                // is set explicitly so it matches what is on screen.
                aria-label="Workspace name"
                value={name}
                onValueChange={(v: string) => {
                    setName(v);
                    setNameTouched(true);
                }}
                placeholder="Acme Storefront"
            />

            <FolderRow
                folder={parentFolder}
                onChoose={async () => {
                    const p = await pickPath({
                        mode: 'directory',
                        title: 'Choose where the workspace should live',
                    });
                    if (p) setParentFolder(p);
                }}
                description={
                    folder && parentFolder
                        ? `Lands at ${workspacePathPreview(parentFolder, folder)}`
                        : primaryWorkspace
                            ? `Default: ${primaryWorkspace}`
                            : 'Pick the folder your workspaces live in.'
                }
            />

            <ContainerRepoNote plan={plan} account={account} owner={owner} onOwnerChange={setOwner} />

            <ProjectPicker
                value={projectId}
                onChange={(id: string) => {
                    setProjectId(id);
                    if (!id) setNameTouched(true);
                }}
                projects={projects}
                loading={loadingProjects}
                onProjectCreated={(p: TynnProject) => {
                    onProjectCreated(p);
                    setProjectId(p.id);
                }}
            />

            {error && <GitHubErrorNotice message={error} />}
            <Footer
                onCancel={onCancel}
                onSubmit={submit}
                submitting={submitting}
                label="Create workspace"
                disabled={!folder || !parentFolder}
            />
        </div>
    );
}

/**
 * What happens on GitHub, stated rather than asked (genie#431). There is no
 * "No remote / Auto-create / Paste URL" choice any more: the answer follows from
 * whether an account is connected, so the form reports the consequence and, when
 * there is more than one account to land in, asks the only question left — which.
 */
function ContainerRepoNote({
    plan,
    account,
    owner,
    onOwnerChange,
}: {
    plan: ContainerRepoPlan;
    account: ReturnType<typeof useGitHubAccount>;
    owner: string;
    onOwnerChange: (v: string) => void;
}) {
    if (plan.kind === 'github') {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Text size="xs" className="text-zinc-500">
                    <Icon name="github" size="xs" /> Backed up to GitHub as{' '}
                    <code>
                        {plan.owner ? `${plan.owner}/` : ''}
                        {plan.repo}
                    </code>{' '}
                    (private), pushed once it exists.
                </Text>
                {account.installations.length > 1 && (
                    <OwnerSelect
                        account={account}
                        value={owner}
                        onChange={onOwnerChange}
                        label="Create under"
                    />
                )}
            </div>
        );
    }

    if (plan.reason === 'missing-permission') {
        return (
            <Text size="xs" style={{ color: 'var(--amber-600)', lineHeight: 1.4 }}>
                Genie's GitHub App is missing <strong>repository contents</strong> write access, so
                this workspace stays on this machine. Approve the permission on GitHub and reconnect
                (see the warning in the title bar) to back it up.
            </Text>
        );
    }

    if (plan.reason === 'not-connected') {
        return (
            <Text size="xs" className="text-zinc-500">
                Kept on this machine. Connect GitHub in Settings and new workspaces are backed up to
                a private repository as they are created.
            </Text>
        );
    }

    return null;
}


function FolderRow({
    folder,
    onChoose,
    description,
}: {
    folder: string;
    onChoose: () => void;
    description?: string;
}) {
    return (
        <div>
            <Text size="xs" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
                Folder
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
                <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 4 }}>
                    {description}
                </Text>
            )}
        </div>
    );
}

function ProjectPicker({
    value,
    onChange,
    projects,
    loading,
    onProjectCreated,
}: {
    value: string;
    onChange: (v: string) => void;
    projects: TynnProject[];
    loading: boolean;
    /** When provided, the picker offers a "+ New project" mode that creates a
     *  Tynn project inline and hands it back so the caller can select it. */
    onProjectCreated?: (p: TynnProject) => void;
}) {
    const [mode, setMode] = useState<'select' | 'create'>('select');
    const options = useMemo(
        () => [
            // Associating a project is OPTIONAL — Tynn is never required to add a
            // workspace. An explicit "no project" entry lets the user pick (or
            // clear back to) none.
            { value: '', label: '— No project (just a folder) —' },
            ...projectPickerOptions(projects, { withOwner: true }),
        ],
        [projects],
    );

    if (onProjectCreated && mode === 'create') {
        return (
            <CreateProjectForm
                onCancel={() => setMode('select')}
                onCreated={(p) => {
                    onProjectCreated(p);
                    setMode('select');
                }}
            />
        );
    }

    return (
        <div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <Text size="xs" style={{ fontWeight: 600 }}>
                    Project <span style={{ fontWeight: 400, color: 'var(--zinc-500)' }}>(optional)</span>
                </Text>
                {onProjectCreated && (
                    <Action
                        variant="ghost"
                        size="sm"
                        icon="plus"
                        onClick={() => setMode('create')}
                    >
                        New project
                    </Action>
                )}
            </div>
            <Select
                description={
                    loading
                        ? 'Loading projects…'
                        : 'Optionally associate this workspace with a Tynn/Aionima project. Not required — leave as “No project” to add a plain folder.'
                }
                value={value}
                onValueChange={onChange}
                list={options}
                placeholder="— No project (just a folder) —"
            />
        </div>
    );
}

/**
 * Inline "Create new project" form for the Add-workspace picker. Creates a
 * Tynn project (POST /api/v1/projects) and hands the result back so the picker
 * selects it. Owner defaults to the personal account; orgs/teams the user can
 * create under are offered when available (from /api/v1/projects/owner-options).
 * The slug is auto-derived from the name and stays editable. The created
 * project doesn't fork workspace creation — it just becomes the selected
 * project the existing flow already consumes.
 */
function CreateProjectForm({
    onCancel,
    onCreated,
    isGapp = false,
}: {
    onCancel: () => void;
    onCreated: (p: TynnProject) => void;
    isGapp?: boolean;
}) {
    const [name, setName] = useState('');
    const [slug, setSlug] = useState('');
    const [slugTouched, setSlugTouched] = useState(false);
    const [owners, setOwners] = useState<OwnerOption[]>([]);
    const [ownerKey, setOwnerKey] = useState(''); // `${kind}:${id}`
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        api()
            .tynn.ownerOptions()
            .then((opts) => {
                setOwners(opts);
                // Default to the personal (user) entry when present.
                const personal = opts.find((o) => o.kind === 'user') ?? opts[0];
                if (personal) setOwnerKey(`${personal.kind}:${personal.id}`);
            });
    }, []);

    // Auto-derive the slug from the name until the user edits it themselves.
    const onNameChange = (v: string) => {
        setName(v);
        if (!slugTouched) {
            setSlug(
                v
                    .toLowerCase()
                    .trim()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-+|-+$/g, ''),
            );
        }
    };

    const submit = async () => {
        setSubmitting(true);
        setError(null);
        try {
            if (!name.trim()) throw new Error('Project name is required.');
            const owner = owners.find((o) => `${o.kind}:${o.id}` === ownerKey);
            const created = await api().tynn.createProject({
                name: name.trim(),
                owner_type: owner?.kind,
                owner_id: owner?.id,
                slug: slug.trim() || undefined,
                is_gapp: isGapp,
            });
            onCreated(created);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Card style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <Text size="sm" style={{ fontWeight: 600 }}>
                    {isGapp ? 'Create GApp Development Workspace' : 'Create new project'}
                </Text>
                <Action variant="ghost" size="sm" icon="arrow-left" onClick={onCancel}>
                    Select existing
                </Action>
            </div>
            <Input
                label="Name"
                value={name}
                onValueChange={onNameChange}
                placeholder={isGapp ? 'My New GApp' : 'My New Project'}
                required
            />
            {isGapp && (
                <Text size="xs" className="text-zinc-500">
                    Genie creates this as a GApp project in Tynn, then opens the normal inspection wizard so you can choose and review the starting folder before anything is written.
                </Text>
            )}
            {owners.length > 1 && (
                <Select
                    label="Owner"
                    description="Who owns the project. Defaults to your personal account."
                    value={ownerKey}
                    onValueChange={setOwnerKey}
                    list={owners.map((o) => ({
                        value: `${o.kind}:${o.id}`,
                        label: o.label,
                    }))}
                />
            )}
            <Input
                label="Slug"
                description="URL slug, auto-derived from the name. Editable."
                value={slug}
                onValueChange={(v) => {
                    setSlugTouched(true);
                    setSlug(v);
                }}
                placeholder="my-new-project"
            />
            {error && (
                <Text size="xs" style={{ color: 'var(--rose-500)' }}>
                    {error}
                </Text>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <Action variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
                    Cancel
                </Action>
                <Action
                    color="blue"
                    size="sm"
                    icon="check"
                    onClick={submit}
                    disabled={submitting || !name.trim()}
                >
                    {submitting ? 'Creating…' : 'Create project'}
                </Action>
            </div>
        </Card>
    );
}

function Footer({
    onCancel,
    onSubmit,
    submitting,
    label,
    disabled,
}: {
    onCancel: () => void;
    onSubmit: () => void;
    submitting: boolean;
    label: string;
    disabled: boolean;
}) {
    return (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <Action variant="ghost" onClick={onCancel} disabled={submitting}>
                Cancel
            </Action>
            <Action color="blue" onClick={onSubmit} disabled={submitting || disabled} icon="check">
                {submitting ? 'Working…' : label}
            </Action>
        </div>
    );
}
