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
    type AddWorkspaceSource,
    type AddWorkspaceSourceId,
    type ContainerRepoPlan,
} from '../lib/workspace-onboarding';
import {
    addWorkspaceDraft,
    addWorkspacePlan,
    describeContent,
    type AddWorkspaceDraft,
} from '../lib/add-workspace';
import { tynnImportChoices, tynnImportRoute } from '../lib/tynn-import';
import { ImportedAgents } from './ImportedAgents';
import { importedAgentsOffer } from '../lib/imported-agents';
import type { AgentRosterEntry } from '../lib/ams-grid';

/**
 * ADD WORKSPACE — one flow, entered five ways.
 *
 * THE RULE. **All projects in Tynn are workspaces. A Genie workspace does not
 * require Tynn.** Nobody — user or agent — should have to make a Tynn project
 * or a repository in order to add a workspace. A workspace is a name and a
 * folder; repositories, a Tynn link, an `.agi` container and GitHub are all
 * optional, and none of them may gate creation.
 *
 * WHAT WAS WRONG, and why this is a rebuild rather than another fix. Each entry
 * point had its own route with its own idea of what a workspace needed, and the
 * scan-and-convert wizard was the fallback DESTINATION for four of them. So
 * importing a Tynn project with no `.agi` repo landed in "pick a folder to
 * convert" — the one entry point that knows exactly which workspace you mean,
 * asking you to go and find it on disk. Converting a folder into a container is
 * something you might want AFTER deciding what the workspace is. It was the
 * price of admission.
 *
 * WHAT IT IS NOW. Three questions — Identity (name + location), Content (which
 * repositories, if any) and Links (Tynn, container) — and the flow asks only
 * what the entry point has not already answered (`lib/add-workspace.ts`). An
 * entry point that has answered all three is a single confirm. Conversion is an
 * offer inside Content, reached only when there is a folder or repository to
 * READ, and it is not a stage anybody can be routed into.
 */

type Stage =
    /** Which of the five ways in. */
    | 'source'
    /** Choosing WHICH Tynn project — that is the Identity answer, not a route. */
    | 'tynn-pick'
    /** The one form: whatever is unanswered, plus the optional links. */
    | 'form'
    /** Content, for the two entry points with something on disk to read. */
    | 'inspect'
    /** This Tynn project already has a workspace here. */
    | 'open-existing'
    /**
     * Made, and it came with agents this machine has never registered
     * (genie#459). Reached ONLY when there are some — see {@link finish}.
     */
    | 'agents';

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
    const [primaryWorkspace, setPrimaryWorkspace] = useState('');
    const [draft, setDraft] = useState<AddWorkspaceDraft | null>(null);
    // The workspace that was just made, and what its `.agents/` folder turned
    // out to hold. Set only on the branch that stops for it.
    const [created, setCreated] = useState<{
        row: WorkspaceRow;
        roster: AgentRosterEntry[];
    } | null>(null);

    useEffect(() => {
        Promise.all([api().tynn.projects(), api().workspaces.list()])
            .then(([p, w]) => {
                setProjects(p);
                setWorkspaces(w);
            })
            .catch((cause) => setProjectsError(cause instanceof Error ? cause.message : String(cause)))
            .finally(() => setLoadingProjects(false));
        api()
            .settings.get()
            .then((s) => setPrimaryWorkspace(s.primary_workspace ?? ''))
            .catch(() => {
                /* no default destination; the flow asks for one */
            });
    }, []);

    // A project created inline from the "Create new project" affordance gets
    // appended to the shared list (so the picker can select it) and floated to
    // the top so it's the obvious pick.
    const onProjectCreated = (p: TynnProject) =>
        setProjects((prev) => [p, ...prev.filter((x) => x.id !== p.id)]);

    const start = (source: AddWorkspaceSourceId) => {
        if (source === 'tynn') {
            setStage('tynn-pick');
            return;
        }
        const next = addWorkspaceDraft(
            source === 'local'
                ? { source: 'local' }
                : source === 'git'
                    ? { source: 'git' }
                    : source === 'gapp'
                        ? { source: 'gapp' }
                        : { source: 'new' },
            { primaryWorkspace, workspaces },
        );
        setDraft(next);
        // Content is the only unanswered question for a folder or a repository,
        // and answering it means READING one — which is what the inspection is.
        setStage(next.content.kind === 'inspect' ? 'inspect' : 'form');
    };

    /**
     * The workspace exists. One question is left, and only sometimes: **did it
     * come with agents?**
     *
     * A project's agents travel as `.agents/<slug>/AGENT.md` and its
     * REGISTRATIONS do not — `workspace_agents` is in the local `genie.db` — so
     * an imported workspace lands with its agents on disk and none of them
     * registered here. Until this, the next thing on screen was an empty agent
     * grid whose one affordance is *create an agent*, which is the act that
     * discards the identity, the saved session and everything the agent knew
     * (genie#459).
     *
     * Asked HERE, once, and only stopped for when the answer is yes: a step that
     * lists nothing is worse than no step. A roster that cannot be read is not a
     * reason to hold the workspace hostage — the workspace opens, and the roster
     * is still in the workspace menu.
     */
    const finish = async (row: WorkspaceRow) => {
        try {
            const { roster } = await api().agents.roster(row.id);
            if (importedAgentsOffer(roster).offer) {
                setCreated({ row, roster });
                setStage('agents');
                return;
            }
        } catch {
            /* the workspace is made; opening it must not depend on this read */
        }
        onAdded(row);
        onClose();
    };

    return (
        // The inspection carries step tables — give it the widest modal so
        // nothing clips; the rest of the flow stays at lg.
        <Modal open onClose={onClose} size={stage === 'inspect' ? 'xl' : 'lg'}>
            <Modal.Header>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Icon name="folder-plus" size="sm" /> Add workspace
                </span>
            </Modal.Header>
            <Modal.Body>
                {stage === 'source' && <ManagedSourcePicker onPick={start} />}

                {stage === 'tynn-pick' && (
                    <TynnProjectStep
                        projects={projects}
                        workspaces={workspaces}
                        loading={loadingProjects}
                        loadError={projectsError}
                        onCancel={() => setStage('source')}
                        onChosen={(project) => {
                            const next = addWorkspaceDraft(
                                { source: 'tynn', project },
                                { primaryWorkspace, workspaces },
                            );
                            setDraft(next);
                            setStage(next.existingWorkspaceId ? 'open-existing' : 'form');
                        }}
                    />
                )}

                {stage === 'inspect' && draft?.content.kind === 'inspect' && (
                    <InteractiveUpgradeWizard
                        initialSourceMode={draft.content.mode}
                        initialSourceUrl={draft.content.sourceUrl}
                        initialProjectId={draft.links.tynnProjectId}
                        projects={projects}
                        loadingProjects={loadingProjects}
                        onCancel={() => setStage('source')}
                        onCreated={(row) => void finish(row)}
                    />
                )}

                {stage === 'form' && draft && (
                    <WorkspaceForm
                        draft={draft}
                        onDraftChange={setDraft}
                        projects={projects}
                        loadingProjects={loadingProjects}
                        onProjectCreated={onProjectCreated}
                        onCancel={() => setStage(draft.source === 'tynn' ? 'tynn-pick' : 'source')}
                        onCreated={(row) => void finish(row)}
                    />
                )}

                {stage === 'open-existing' && draft && (
                    <TynnAlreadyImported
                        name={draft.name}
                        workspace={
                            workspaces.find((w) => w.id === draft.existingWorkspaceId) ?? null
                        }
                        onBack={() => setStage('tynn-pick')}
                        onOpened={onClose}
                    />
                )}

                {stage === 'agents' && created && (
                    <WorkspaceBroughtAgents
                        workspace={created.row}
                        roster={created.roster}
                        onOpen={() => {
                            onAdded(created.row);
                            onClose();
                        }}
                    />
                )}
            </Modal.Body>
        </Modal>
    );
}

/**
 * WHICH Tynn project. That is all this step is: the Identity answer, taken from
 * a list. It used to also decide the ROUTE — envelope here, wizard there — and
 * that decision is what sent repo-less projects looking for a folder.
 */
function TynnProjectStep({
    projects,
    workspaces,
    loading,
    loadError,
    onCancel,
    onChosen,
}: {
    projects: TynnProject[];
    workspaces: WorkspaceRow[];
    loading: boolean;
    loadError: string | null;
    onCancel: () => void;
    onChosen: (project: TynnProject) => void;
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
                    Every project in Tynn is a workspace. Choose one and Genie brings it here —
                    with its container, with its repositories, or with neither, depending on what
                    the project has.
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
            {route?.stage === 'tynn-open-existing' && (
                <Text size="xs" className="text-amber-500">
                    This project is already a workspace on this machine.
                </Text>
            )}
            {route?.stage === 'tynn-workspace' && (
                <Text size="xs" className="text-zinc-500">
                    {describeContent(route.content)}
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
                    if (chosen) onChosen(chosen.project);
                }}
                submitting={false}
                label={route?.stage === 'tynn-open-existing' ? 'Open workspace' : 'Continue'}
                disabled={!chosen}
            />
        </div>
    );
}

/**
 * THE form — the only one. It shows what the entry point has not answered, says
 * what will happen, and creates the workspace.
 *
 * When `draft.asks` is empty there is nothing left to fill in, so it opens as a
 * confirmation rather than a form: that is what "the Tynn import asks nothing"
 * looks like on screen. The fields are one click away, because a pre-answer is
 * a default and not a lock.
 *
 * The container repository is DERIVED, never asked (`containerRepoPlan`): GitHub
 * connected means the workspace gets one, GitHub absent or unhappy means it does
 * not, and either way the workspace is created — a repository the user did not
 * ask for must never stop them making a folder. A container that already exists
 * (an imported one) is not offered a second.
 */
function WorkspaceForm({
    draft,
    onDraftChange,
    projects,
    loadingProjects,
    onProjectCreated,
    onCancel,
    onCreated,
}: {
    draft: AddWorkspaceDraft;
    onDraftChange: (draft: AddWorkspaceDraft) => void;
    projects: TynnProject[];
    loadingProjects: boolean;
    onProjectCreated: (p: TynnProject) => void;
    onCancel: () => void;
    onCreated: (row: WorkspaceRow) => void;
}) {
    const [owner, setOwner] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Created, but GitHub did not go to plan. The workspace EXISTS, so this is
    // not an error state — it is a finished one with something to say.
    const [partial, setPartial] = useState<{ row: WorkspaceRow; problem: string } | null>(null);
    const [expanded, setExpanded] = useState(draft.asks.length > 0);
    const account = useGitHubAccount();
    // Creating a repo needs the App's `contents` write permission. Without it
    // the workspace is local-only rather than a 403 halfway through the flow.
    const { caps: githubCaps } = useGithubCapabilities();

    // The container already exists for an imported one — Genie brings it down,
    // it does not make a second.
    const wantsContainerRepo = draft.content.kind !== 'envelope';
    const plan = containerRepoPlan({
        githubConnected: account.connected && wantsContainerRepo,
        githubCanProvision: !(
            githubCaps.connected && githubCaps.missing.includes('github.provision')
        ),
        owner: owner || account.username || '',
        slug: draft.name,
    });

    const folder = workspaceFolderName(draft.name);
    const ready = !!folder && !!draft.parentPath.trim();

    const submit = async () => {
        setSubmitting(true);
        setError(null);
        try {
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
                        description: `Genie workspace for ${draft.name.trim()}`,
                        private: true,
                    });
                    remote = { kind: 'paste', url: created.clone_url };
                } catch (cause) {
                    problem = `Genie could not create ${plan.owner ? `${plan.owner}/` : ''}${
                        plan.repo
                    } on GitHub: ${cause instanceof Error ? cause.message : String(cause)}`;
                }
            }

            const saved = await api().workspaces.create(
                addWorkspacePlan(draft, { id: ulid(), remote }),
            );

            if (remote.kind === 'paste') {
                try {
                    await api().agi.push(saved.path, 'main');
                } catch (cause) {
                    problem = `The workspace is on this machine, but Genie could not push it to ${
                        remote.url
                    }: ${cause instanceof Error ? cause.message : String(cause)}`;
                }
            }

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
                        {partial.row.project_name || draft.name.trim()} is ready
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
                    {draft.links.gappDev
                        ? 'New GApp workspace'
                        : draft.name.trim()
                            ? `Add ${draft.name.trim()}`
                            : 'New workspace'}
                </Heading>
                <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 4 }}>
                    {describeContent(draft.content)}
                    {draft.links.gappDev
                        ? ' Set up to build and preview a Genie App.'
                        : ''}
                </Text>
            </div>

            {/* Everything already known, said once. The fields below fill in
                what is missing — and open on demand when nothing is. */}
            <Summary
                name={draft.name}
                folder={folder}
                parentPath={draft.parentPath}
                expanded={expanded}
                onExpand={() => setExpanded(true)}
            />

            {expanded && (
                <>
                    <Input
                        label="Workspace name"
                        // The Fancy `label` prop draws the caption; the accessible
                        // name is set explicitly so it matches what is on screen.
                        aria-label="Workspace name"
                        value={draft.name}
                        onValueChange={(v: string) => onDraftChange({ ...draft, name: v })}
                        placeholder="Acme Storefront"
                    />

                    <FolderRow
                        folder={draft.parentPath}
                        onChoose={async () => {
                            const p = await pickPath({
                                mode: 'directory',
                                title: 'Choose where the workspace should live',
                            });
                            if (p) onDraftChange({ ...draft, parentPath: p });
                        }}
                        description={
                            folder && draft.parentPath
                                ? `Lands at ${workspacePathPreview(draft.parentPath, folder)}`
                                : 'Pick the folder your workspaces live in.'
                        }
                    />

                    <ContainerRepoNote
                        plan={plan}
                        account={account}
                        owner={owner}
                        onOwnerChange={setOwner}
                        imported={!wantsContainerRepo}
                    />

                    {/* The Tynn link, OFFERED — during creation, optional, and
                        skipping it costs the workspace nothing. */}
                    <ProjectPicker
                        value={draft.links.tynnProjectId}
                        onChange={(id: string) => {
                            const project = projects.find((p) => p.id === id);
                            onDraftChange({
                                ...draft,
                                name: draft.name.trim() || project?.name || '',
                                links: {
                                    ...draft.links,
                                    tynnProjectId: id,
                                    tynnProjectName: project?.name ?? '',
                                    backend: project?.backend ?? null,
                                },
                            });
                        }}
                        projects={projects}
                        loading={loadingProjects}
                        isGapp={draft.links.gappDev}
                        onProjectCreated={(p: TynnProject) => {
                            onProjectCreated(p);
                            onDraftChange({
                                ...draft,
                                name: draft.name.trim() || p.name,
                                links: {
                                    ...draft.links,
                                    tynnProjectId: p.id,
                                    tynnProjectName: p.name,
                                    backend: p.backend ?? null,
                                },
                            });
                        }}
                    />
                </>
            )}

            {error && <GitHubErrorNotice message={error} />}
            <Footer
                onCancel={onCancel}
                onSubmit={submit}
                submitting={submitting}
                label={draft.content.kind === 'envelope' ? 'Clone & add workspace' : 'Create workspace'}
                disabled={!ready}
            />
        </div>
    );
}

/** What is about to happen, in one block — name, folder, and the path it lands at. */
function Summary({
    name,
    folder,
    parentPath,
    expanded,
    onExpand,
}: {
    name: string;
    folder: string;
    parentPath: string;
    expanded: boolean;
    onExpand: () => void;
}) {
    if (expanded) return null;
    return (
        <Card style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Text size="sm" style={{ fontWeight: 600 }}>{name}</Text>
            <Text size="xs" className="text-zinc-500">
                <code>{folder && parentPath ? workspacePathPreview(parentPath, folder) : parentPath}</code>
            </Text>
            <div>
                <Action variant="ghost" size="sm" icon="pencil" onClick={onExpand}>
                    Change details
                </Action>
            </div>
        </Card>
    );
}

/**
 * THE LAST STEP OF AN IMPORT, and only when there is one (genie#459).
 *
 * The workspace is made. What it came with that this machine has never seen is
 * the one thing the flow can say here and nowhere else — after this the modal is
 * gone and the agent grid is empty, which reads as "this project has no agents"
 * when the truth is "their files are right there, unregistered".
 *
 * Exported so it can be rendered in a test. The renderer test env has no DOM but
 * the server renderer runs every component function and throws where the browser
 * would, and a screen that only appears after a real clone is exactly the one
 * that should not first be rendered on a user's machine.
 */
export function WorkspaceBroughtAgents({
    workspace,
    roster,
    onOpen,
}: {
    workspace: WorkspaceRow;
    roster: AgentRosterEntry[];
    onOpen: () => void;
}) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
                <Heading as="h3" size="sm">
                    {workspace.project_name || 'The workspace'} is ready — and it came with agents
                </Heading>
                <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 4 }}>
                    It is at <code>{workspace.path}</code>. Adopt an agent to have it back as it
                    was; skip and the same list is in the workspace menu under Agents.
                </Text>
            </div>
            {/* `keepOpen`: this screen exists BECAUSE there was something to
                adopt, so adopting the last one must leave the list on screen —
                it is the only confirmation the act worked. */}
            <ImportedAgents workspaceId={workspace.id} roster={roster} keepOpen />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
                <Action color="blue" onClick={onOpen} icon="check">
                    Open workspace
                </Action>
            </div>
        </div>
    );
}

/**
 * The project already has a workspace here. Importing again would clone a second
 * copy of the same envelope and leave two rows pointing at one project, so the
 * offer is to open the one that exists.
 */
function TynnAlreadyImported({
    name,
    workspace,
    onBack,
    onOpened,
}: {
    name: string;
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
                <Heading as="h3" size="sm">{name} is already here</Heading>
                <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 4 }}>
                    A workspace on this machine is already linked to this Tynn project
                    {workspace ? <> at <code>{workspace.path}</code></> : null}. Open it instead of
                    cloning a second copy.
                </Text>
            </div>
            {/* Already here is not the same as already SET UP. A workspace that
                was re-added, or whose agents were pulled in after it, carries
                agent files with no registration on this machine — and this is
                the screen the human is on when they are looking for them
                (genie#459). Draws nothing when there are none. */}
            {workspace && <ImportedAgents workspaceId={workspace.id} />}
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
            {/* Two groups, because there are two acts — and a flat row of five
                cards would say they were all the same one. */}
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
 * What happens on GitHub, stated rather than asked. There is no "No remote /
 * Auto-create / Paste URL" choice: the answer follows from whether an account is
 * connected, so the form reports the consequence and, when there is more than
 * one account to land in, asks the only question left — which.
 */
function ContainerRepoNote({
    plan,
    account,
    owner,
    onOwnerChange,
    imported,
}: {
    plan: ContainerRepoPlan;
    account: ReturnType<typeof useGitHubAccount>;
    owner: string;
    onOwnerChange: (v: string) => void;
    /** The container already exists on a remote — nothing to create. */
    imported?: boolean;
}) {
    if (imported) {
        return (
            <Text size="xs" className="text-zinc-500">
                <Icon name="github" size="xs" /> This workspace already has its container
                repository — Genie clones it rather than making a new one.
            </Text>
        );
    }

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
                Genie&apos;s GitHub App is missing <strong>repository contents</strong> write access, so
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
    isGapp,
    onProjectCreated,
}: {
    value: string;
    onChange: (v: string) => void;
    projects: TynnProject[];
    loading: boolean;
    /** A GApp workspace creates a GApp project, when one is created at all. */
    isGapp?: boolean;
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
                isGapp={isGapp}
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
                        : 'Optionally link this workspace to a Tynn project. Not required, and not required later either — the workspace works the same without one.'
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
 * Inline "Create new project" form. Creates a Tynn project (POST
 * /api/v1/projects) and hands the result back so the picker selects it. Owner
 * defaults to the personal account; orgs/teams the user can create under are
 * offered when available (from /api/v1/projects/owner-options). The slug is
 * auto-derived from the name and stays editable.
 *
 * It is reached from the OPTIONAL project picker, and only from there: making a
 * Tynn project is one thing you can do while adding a workspace, never a step
 * on the way to one.
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
                    {isGapp ? 'Create GApp project' : 'Create new project'}
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
