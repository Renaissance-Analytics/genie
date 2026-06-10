import React, { useEffect, useMemo, useState } from 'react';
import {
    Action,
    Badge,
    Card,
    Heading,
    Icon,
    Input,
    Modal,
    Select,
    Text,
} from '@particle-academy/react-fancy';
import { api, ulid } from '../lib/genie';
import type { DetectResult, TynnProject, WorkspaceRow } from '../lib/genie';
import InteractiveUpgradeWizard from './InteractiveUpgradeWizard';

type Stage =
    | 'shape'
    | 'simple'
    | 'agi-pick'
    | 'agi-create'
    | 'agi-import'
    | 'agi-convert'
    | 'agi-interactive'
    | 'done';

interface Props {
    onClose: () => void;
    onAdded: (row: WorkspaceRow) => void;
}

export default function AddWorkspaceModal({ onClose, onAdded }: Props) {
    const [stage, setStage] = useState<Stage>('shape');
    const [projects, setProjects] = useState<TynnProject[]>([]);
    const [loadingProjects, setLoadingProjects] = useState(true);

    useEffect(() => {
        api()
            .tynn.projects()
            .then((p) => setProjects(p))
            .finally(() => setLoadingProjects(false));
    }, []);

    return (
        <Modal open onClose={onClose} size="lg">
            <Modal.Header>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Icon name="folder-plus" size="sm" /> Add workspace
                </span>
            </Modal.Header>
            <Modal.Body>
                {stage === 'shape' && <ShapePicker onPick={setStage} />}
                {stage === 'simple' && (
                    <SimpleWizard
                        projects={projects}
                        loadingProjects={loadingProjects}
                        onCancel={() => setStage('shape')}
                        onCreated={(row) => {
                            onAdded(row);
                            setStage('done');
                            onClose();
                        }}
                    />
                )}
                {stage === 'agi-pick' && (
                    <AgiPicker
                        onCreate={() => setStage('agi-create')}
                        onImport={() => setStage('agi-import')}
                        onConvert={() => setStage('agi-convert')}
                        onInteractive={() => setStage('agi-interactive')}
                        onBack={() => setStage('shape')}
                    />
                )}
                {stage === 'agi-interactive' && (
                    <InteractiveUpgradeWizard
                        projects={projects}
                        loadingProjects={loadingProjects}
                        onCancel={() => setStage('agi-pick')}
                        onCreated={(row) => {
                            onAdded(row);
                            setStage('done');
                            onClose();
                        }}
                    />
                )}
                {stage === 'agi-convert' && (
                    <AgiConvertWizard
                        projects={projects}
                        loadingProjects={loadingProjects}
                        onCancel={() => setStage('agi-pick')}
                        onCreated={(row) => {
                            onAdded(row);
                            setStage('done');
                            onClose();
                        }}
                    />
                )}
                {stage === 'agi-create' && (
                    <AgiCreateWizard
                        projects={projects}
                        loadingProjects={loadingProjects}
                        onCancel={() => setStage('agi-pick')}
                        onCreated={(row) => {
                            onAdded(row);
                            setStage('done');
                            onClose();
                        }}
                    />
                )}
                {stage === 'agi-import' && (
                    <AgiImportWizard
                        projects={projects}
                        loadingProjects={loadingProjects}
                        onCancel={() => setStage('agi-pick')}
                        onCreated={(row) => {
                            onAdded(row);
                            setStage('done');
                            onClose();
                        }}
                    />
                )}
            </Modal.Body>
        </Modal>
    );
}

function ShapePicker({ onPick }: { onPick: (s: Stage) => void }) {
    return (
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
            <Card
                style={{ padding: 16, cursor: 'pointer' }}
                onClick={() => onPick('simple')}
            >
                <Icon name="folder" size="lg" className="text-blue-500" />
                <Heading as="h3" size="sm" style={{ marginTop: 8 }}>
                    Simple
                </Heading>
                <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 4 }}>
                    Point Genie at any existing repo, monorepo, or folder. No
                    git scaffolding. Path can be anywhere on disk.
                </Text>
            </Card>

            <Card
                style={{
                    padding: 16,
                    cursor: 'pointer',
                    border: '1px solid var(--violet-500)',
                    position: 'relative',
                }}
                onClick={() => onPick('agi-pick')}
            >
                <Badge
                    color="violet"
                    variant="solid"
                    size="sm"
                    style={{ position: 'absolute', top: 12, right: 12 }}
                >
                    Preferred
                </Badge>
                <Icon name="box" size="lg" className="text-violet-500" />
                <Heading as="h3" size="sm" style={{ marginTop: 8 }}>
                    .agi envelope
                </Heading>
                <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 4 }}>
                    Aionima format: <code>{'{slug}.agi'}</code> git envelope
                    with submodules in <code>repos/</code> + shared knowledge
                    in <code>.ai/</code>. Compatible with the AGI gateway.
                </Text>
            </Card>
        </div>
    );
}

function SimpleWizard({
    projects,
    loadingProjects,
    onCancel,
    onCreated,
}: {
    projects: TynnProject[];
    loadingProjects: boolean;
    onCancel: () => void;
    onCreated: (row: WorkspaceRow) => void;
}) {
    const [folder, setFolder] = useState<string>('');
    const [projectId, setProjectId] = useState<string>('');
    const [editor, setEditor] = useState<string>('cursor');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Aionima upgrade — when checked, the chosen folder becomes a submodule
    // inside a fresh `{slug}.agi` envelope. The envelope is what Genie
    // registers as the workspace; the original folder is unchanged.
    const [upgradeToAgi, setUpgradeToAgi] = useState(false);
    const [agiSlug, setAgiSlug] = useState<string>('');
    const [agiParent, setAgiParent] = useState<string>('');
    const [agiSubName, setAgiSubName] = useState<string>('');
    const [primaryWorkspace, setPrimaryWorkspace] = useState<string | undefined>();

    useEffect(() => {
        api()
            .settings.get()
            .then((s) => {
                setPrimaryWorkspace(s.primary_workspace);
                if (!agiParent && s.primary_workspace) {
                    setAgiParent(s.primary_workspace);
                }
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Whenever the source folder or selected project changes, refresh the
    // auto-suggested slug + submodule name. We only overwrite if the user
    // hasn't typed something custom yet.
    useEffect(() => {
        const project = projects.find((p) => p.id === projectId);
        const folderLeaf = folder
            ? folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
            : '';
        if (project && !agiSlug) setAgiSlug(project.slug || folderLeaf || '');
        if (folderLeaf && !agiSubName) setAgiSubName(folderLeaf);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [folder, projectId]);

    const choose = async () => {
        const p = await api().settings.chooseFolder('Choose project folder');
        if (p) setFolder(p);
    };
    const chooseAgiParent = async () => {
        const p = await api().settings.chooseFolder(
            'Choose where the new .agi envelope folder will be created',
        );
        if (p) setAgiParent(p);
    };

    const submit = async () => {
        setSubmitting(true);
        setError(null);
        try {
            const project = projects.find((p) => p.id === projectId);
            if (!project) throw new Error('Pick a project to associate.');
            if (!folder) throw new Error('Pick a folder.');
            const settings = await api().settings.get();

            let workspacePath = folder;
            let shape: WorkspaceRow['shape'] = 'simple';
            let createdByGenie = 0;

            if (upgradeToAgi) {
                if (!agiSlug.trim()) throw new Error('Slug for the new envelope is required.');
                if (!agiParent.trim()) throw new Error('Pick a destination parent folder for the new envelope.');
                if (!agiSubName.trim()) throw new Error('Submodule directory name is required.');
                const res = await api().agi.convert({
                    slug: agiSlug.trim(),
                    name: project.name,
                    parent_path: agiParent.trim(),
                    source: { kind: 'local', path: folder },
                    sub_name: agiSubName.trim(),
                });
                workspacePath = res.path;
                shape = 'agi';
                createdByGenie = 1;
            }

            const row: WorkspaceRow = {
                id: project.id,
                backend: project.backend ?? 'tynn',
                project_id: project.id,
                project_name: project.name,
                tynn_project_id: project.id,
                tynn_project_name: project.name,
                shape,
                path: workspacePath,
                editor,
                editor_cmd: settings.default_editor_cmd ?? null,
                start_cmd: settings.default_start_cmd ?? null,
                env_file: settings.default_env_file ?? '.env',
                last_opened_at: null,
                created_by_genie: createdByGenie,
            };
            const saved = await api().workspaces.add(row);
            onCreated(saved);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <FolderRow folder={folder} onChoose={choose} />
            <ProjectPicker
                value={projectId}
                onChange={setProjectId}
                projects={projects}
                loading={loadingProjects}
            />
            <EditorPicker value={editor} onChange={setEditor} />

            <AgiUpgradeBlock
                checked={upgradeToAgi}
                onCheckedChange={setUpgradeToAgi}
                slug={agiSlug}
                onSlugChange={setAgiSlug}
                parent={agiParent}
                onParentChoose={chooseAgiParent}
                subName={agiSubName}
                onSubNameChange={setAgiSubName}
                primaryWorkspace={primaryWorkspace}
            />

            {error && <Text size="xs" style={{ color: 'var(--rose-500)' }}>{error}</Text>}
            <Footer
                onCancel={onCancel}
                onSubmit={submit}
                submitting={submitting}
                label={upgradeToAgi ? 'Upgrade and add' : 'Add workspace'}
                disabled={
                    !folder ||
                    !projectId ||
                    (upgradeToAgi && (!agiSlug.trim() || !agiParent.trim() || !agiSubName.trim()))
                }
            />
        </div>
    );
}

function AgiUpgradeBlock({
    checked,
    onCheckedChange,
    slug,
    onSlugChange,
    parent,
    onParentChoose,
    subName,
    onSubNameChange,
    primaryWorkspace,
}: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    slug: string;
    onSlugChange: (v: string) => void;
    parent: string;
    onParentChoose: () => void;
    subName: string;
    onSubNameChange: (v: string) => void;
    primaryWorkspace?: string;
}) {
    return (
        <Card style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label
                style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    cursor: 'pointer',
                }}
            >
                <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => onCheckedChange(e.target.checked)}
                    style={{ marginTop: 2 }}
                />
                <span style={{ flex: 1 }}>
                    <Text size="sm" style={{ display: 'block', fontWeight: 600 }}>
                        Upgrade to Aionima format (simple)
                    </Text>
                    <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 2 }}>
                        Wrap the folder above as a single submodule inside a new{' '}
                        <code>{'{slug}.agi'}</code> envelope. The original repo is
                        untouched. The envelope adds <code>repos/</code> (for
                        submodules) + <code>.ai/</code> (shared knowledge:{' '}
                        <code>plans</code>, <code>knowledge</code>,{' '}
                        <code>pm</code>, <code>chat</code>, <code>memory</code>,{' '}
                        <code>issues</code>), compatible with the AGI gateway.{' '}
                        <em>
                            For sources with multiple nested repos / existing
                            knowledge folders, cancel and use{' '}
                            <strong>.agi envelope → Interactive upgrade</strong>{' '}
                            instead.
                        </em>
                    </Text>
                </span>
            </label>

            {checked && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4 }}>
                    <Input
                        label="Envelope slug"
                        description={`Becomes the folder name: ${slug || '{slug}'}.agi`}
                        value={slug}
                        onValueChange={onSlugChange}
                        placeholder="brain-v2"
                    />
                    <FolderRow
                        folder={parent}
                        onChoose={onParentChoose}
                        description={
                            primaryWorkspace
                                ? `Default: ${primaryWorkspace}. Result: <parent>/${slug || '{slug}'}.agi/`
                                : `Pick where the .agi envelope will be created. Result: <parent>/${slug || '{slug}'}.agi/`
                        }
                    />
                    <Input
                        label="Submodule directory name"
                        description={`Source lands at repos/${subName || '…'}/ inside the envelope.`}
                        value={subName}
                        onValueChange={onSubNameChange}
                        placeholder="brain"
                    />
                </div>
            )}
        </Card>
    );
}

function AgiPicker({
    onCreate,
    onImport,
    onConvert,
    onInteractive,
    onBack,
}: {
    onCreate: () => void;
    onImport: () => void;
    onConvert: () => void;
    onInteractive: () => void;
    onBack: () => void;
}) {
    return (
        <div>
            <div className="grid grid-cols-2 gap-3">
                <Card className="cursor-pointer p-4" onClick={onCreate}>
                    <Icon name="sparkles" size="lg" className="text-emerald-500" />
                    <Heading as="h3" size="sm" className="mt-2">
                        Create new envelope
                    </Heading>
                    <Text size="xs" className="mt-1 block text-zinc-500">
                        Scaffold a fresh <code>{'{slug}.agi'}</code> folder
                        with the full Aionima skeleton + initial git commit.
                    </Text>
                </Card>
                <Card className="cursor-pointer p-4" onClick={onConvert}>
                    <Icon name="git-merge" size="lg" className="text-blue-500" />
                    <Heading as="h3" size="sm" className="mt-2">
                        Convert single project
                    </Heading>
                    <Text size="xs" className="mt-1 block text-zinc-500">
                        Wrap one local folder or remote git repo as a submodule
                        inside a brand-new <code>{'{slug}.agi'}</code>.
                    </Text>
                </Card>
                <Card
                    className="cursor-pointer p-4"
                    onClick={onInteractive}
                    style={{ borderColor: 'var(--agent)' }}
                >
                    <Icon name="layers" size="lg" className="text-indigo-500" />
                    <Heading as="h3" size="sm" className="mt-2">
                        Interactive upgrade
                        <span
                            style={{
                                marginLeft: 6,
                                fontSize: 10,
                                fontWeight: 600,
                                color: 'var(--agent)',
                                background: 'var(--agent-soft)',
                                borderRadius: 4,
                                padding: '1px 5px',
                            }}
                        >
                            new
                        </span>
                    </Heading>
                    <Text size="xs" className="mt-1 block text-zinc-500">
                        Source has multiple repos and loose knowledge folders.
                        Scan, pick which sub-repos become <code>repos/</code>
                        submodules and which folders move into{' '}
                        <code>.ai/</code>.
                    </Text>
                </Card>
                <Card className="cursor-pointer p-4" onClick={onImport}>
                    <Icon name="folder-input" size="lg" className="text-amber-500" />
                    <Heading as="h3" size="sm" className="mt-2">
                        Import existing envelope
                    </Heading>
                    <Text size="xs" className="mt-1 block text-zinc-500">
                        Folder already IS a <code>.agi</code>. Walk it, detect
                        repos, register as a workspace.
                    </Text>
                </Card>
            </div>
            <div className="mt-3">
                <Action variant="ghost" size="sm" onClick={onBack} icon="arrow-left">
                    Back
                </Action>
            </div>
        </div>
    );
}

function AgiConvertWizard({
    projects,
    loadingProjects,
    onCancel,
    onCreated,
}: {
    projects: TynnProject[];
    loadingProjects: boolean;
    onCancel: () => void;
    onCreated: (row: WorkspaceRow) => void;
}) {
    const [projectId, setProjectId] = useState('');
    const [slug, setSlug] = useState('');
    const [primaryWorkspace, setPrimaryWorkspace] = useState<string | undefined>();
    const [parentFolder, setParentFolder] = useState<string>('');
    const [sourceMode, setSourceMode] = useState<'local' | 'remote'>('local');
    const [sourcePath, setSourcePath] = useState<string>('');
    const [sourceUrl, setSourceUrl] = useState<string>('');
    const [subName, setSubName] = useState<string>('');
    const [remoteMode, setRemoteMode] = useState<'none' | 'paste'>('none');
    const [envelopeRemoteUrl, setEnvelopeRemoteUrl] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        api()
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
        const project = projects.find((p) => p.id === projectId);
        if (project && !slug) setSlug(project.slug);
    }, [projectId, projects, slug]);

    // Auto-suggest the submodule directory name from whichever source is active.
    useEffect(() => {
        const candidate = sourceMode === 'local' ? sourcePath : sourceUrl;
        if (!candidate || subName) return;
        const trimmed = candidate.replace(/[\\/]+$/, '');
        const last = trimmed.split(/[/\\:]/).pop() ?? '';
        const cleaned = last.replace(/\.git$/i, '');
        if (cleaned) setSubName(cleaned);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sourceMode, sourcePath, sourceUrl]);

    const chooseSource = async () => {
        const p = await api().settings.chooseFolder('Choose existing project folder');
        if (p) setSourcePath(p);
    };

    const chooseParent = async () => {
        const p = await api().settings.chooseFolder('Choose destination parent folder');
        if (p) setParentFolder(p);
    };

    const submit = async () => {
        setSubmitting(true);
        setError(null);
        try {
            const project = projects.find((p) => p.id === projectId);
            if (!project) throw new Error('Pick a Tynn project to associate.');
            if (!slug) throw new Error('Slug is required.');
            if (!parentFolder) throw new Error('Pick a destination parent folder.');
            const source =
                sourceMode === 'local'
                    ? sourcePath
                        ? { kind: 'local' as const, path: sourcePath }
                        : null
                    : sourceUrl.trim()
                        ? { kind: 'remote' as const, url: sourceUrl.trim() }
                        : null;
            if (!source) {
                throw new Error(
                    sourceMode === 'local'
                        ? 'Pick the source folder.'
                        : 'Enter the source remote URL.',
                );
            }

            const remote =
                remoteMode === 'paste'
                    ? { kind: 'paste' as const, url: envelopeRemoteUrl }
                    : { kind: 'none' as const };

            const res = await api().agi.convert({
                slug,
                name: project.name,
                parent_path: parentFolder,
                source,
                sub_name: subName || undefined,
                remote,
            });

            const settings = await api().settings.get();
            const row: WorkspaceRow = {
                id: project.id,
                backend: project.backend ?? 'tynn',
                project_id: project.id,
                project_name: project.name,
                tynn_project_id: project.id,
                tynn_project_name: project.name,
                shape: 'agi',
                path: res.path,
                editor: settings.default_editor ?? 'cursor',
                editor_cmd: settings.default_editor_cmd ?? null,
                start_cmd: settings.default_start_cmd ?? null,
                env_file: settings.default_env_file ?? '.env',
                last_opened_at: null,
                created_by_genie: 1,
            };
            const saved = await api().workspaces.add(row);
            onCreated(saved);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSubmitting(false);
        }
    };

    const disabled =
        !projectId ||
        !slug ||
        !parentFolder ||
        (sourceMode === 'local' ? !sourcePath : !sourceUrl.trim());

    return (
        <div className="flex flex-col gap-3">
            <ProjectPicker
                value={projectId}
                onChange={setProjectId}
                projects={projects}
                loading={loadingProjects}
            />

            <div>
                <Text size="xs" className="mb-1.5 block font-semibold">
                    Source project
                </Text>
                <div className="mb-2 flex gap-2">
                    {(['local', 'remote'] as const).map((m) => (
                        <Action
                            key={m}
                            size="sm"
                            variant={sourceMode === m ? 'default' : 'ghost'}
                            color={sourceMode === m ? 'blue' : undefined}
                            onClick={() => setSourceMode(m)}
                        >
                            {m === 'local' ? 'Local folder' : 'Remote URL'}
                        </Action>
                    ))}
                </div>
                {sourceMode === 'local' ? (
                    <FolderRow
                        folder={sourcePath}
                        onChoose={chooseSource}
                        description="Pick the project folder. Must already be a git repo (has .git). The folder is never modified."
                    />
                ) : (
                    <Input
                        label="Source remote URL"
                        description="The git URL Genie will register as a submodule (e.g. git@github.com:owner/repo.git)."
                        value={sourceUrl}
                        onValueChange={setSourceUrl}
                        placeholder="git@github.com:owner/repo.git"
                    />
                )}
            </div>

            <Input
                label="Submodule directory name"
                description={`Where the source lands inside the new envelope: repos/${subName || '…'}/`}
                value={subName}
                onValueChange={setSubName}
                placeholder="e.g. brain, web, api"
            />

            <Input
                label="New envelope slug"
                description="Becomes the folder name: {slug}.agi"
                value={slug}
                onValueChange={setSlug}
                placeholder="brain-v2"
            />

            <FolderRow
                folder={parentFolder}
                onChoose={chooseParent}
                description={
                    primaryWorkspace
                        ? `Default: ${primaryWorkspace}. The new envelope will be created at <parent>/${slug || '{slug}'}.agi/`
                        : `Pick where the new envelope folder will be created. Result: <parent>/${slug || '{slug}'}.agi/`
                }
            />

            <div>
                <Text size="xs" className="mb-1.5 block font-semibold">
                    Envelope remote (optional)
                </Text>
                <div className="flex gap-2">
                    {(['none', 'paste'] as const).map((m) => (
                        <Action
                            key={m}
                            size="sm"
                            variant={remoteMode === m ? 'default' : 'ghost'}
                            color={remoteMode === m ? 'blue' : undefined}
                            onClick={() => setRemoteMode(m)}
                        >
                            {m === 'none' ? 'No remote' : 'Paste URL'}
                        </Action>
                    ))}
                </div>
                {remoteMode === 'paste' && (
                    <div className="mt-2">
                        <Input
                            label="New envelope remote URL"
                            description="A git URL for the new {slug}.agi envelope itself (not the source)."
                            value={envelopeRemoteUrl}
                            onValueChange={setEnvelopeRemoteUrl}
                            placeholder="git@github.com:owner/{slug}.agi.git"
                        />
                    </div>
                )}
            </div>

            {error && (
                <Text size="xs" className="text-rose-500">
                    {error}
                </Text>
            )}
            <Footer
                onCancel={onCancel}
                onSubmit={submit}
                submitting={submitting}
                label="Create envelope"
                disabled={disabled}
            />
        </div>
    );
}

function AgiCreateWizard({
    projects,
    loadingProjects,
    onCancel,
    onCreated,
}: {
    projects: TynnProject[];
    loadingProjects: boolean;
    onCancel: () => void;
    onCreated: (row: WorkspaceRow) => void;
}) {
    const [projectId, setProjectId] = useState('');
    const [slug, setSlug] = useState('');
    const [primaryWorkspace, setPrimaryWorkspace] = useState<string | undefined>();
    const [parentFolder, setParentFolder] = useState<string>('');
    const [remoteMode, setRemoteMode] = useState<'none' | 'auto' | 'paste'>('none');
    const [remoteOwner, setRemoteOwner] = useState('');
    const [remoteUrl, setRemoteUrl] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        api()
            .settings.get()
            .then((s) => {
                setPrimaryWorkspace(s.primary_workspace);
                if (!parentFolder && s.primary_workspace) {
                    setParentFolder(s.primary_workspace);
                }
            });
    }, []);

    useEffect(() => {
        const project = projects.find((p) => p.id === projectId);
        if (project && !slug) setSlug(project.slug);
    }, [projectId, projects, slug]);

    const choose = async () => {
        const p = await api().settings.chooseFolder('Choose parent folder for new envelope');
        if (p) setParentFolder(p);
    };

    const submit = async () => {
        setSubmitting(true);
        setError(null);
        try {
            const project = projects.find((p) => p.id === projectId);
            if (!project) throw new Error('Pick a Tynn project.');
            if (!slug) throw new Error('Slug is required.');
            if (!parentFolder) throw new Error('Pick the parent folder.');

            const remote =
                remoteMode === 'none'
                    ? { kind: 'none' as const }
                    : remoteMode === 'paste'
                        ? { kind: 'paste' as const, url: remoteUrl }
                        : { kind: 'auto' as const, owner: remoteOwner };

            const res = await api().agi.create({
                slug,
                name: project.name,
                parent_path: parentFolder,
                remote,
            });

            const settings = await api().settings.get();
            const row: WorkspaceRow = {
                id: project.id,
                backend: project.backend ?? 'tynn',
                project_id: project.id,
                project_name: project.name,
                tynn_project_id: project.id,
                tynn_project_name: project.name,
                shape: 'agi',
                path: res.path,
                editor: settings.default_editor ?? 'cursor',
                editor_cmd: settings.default_editor_cmd ?? null,
                start_cmd: settings.default_start_cmd ?? null,
                env_file: settings.default_env_file ?? '.env',
                last_opened_at: null,
                created_by_genie: 1,
            };
            const saved = await api().workspaces.add(row);
            onCreated(saved);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <ProjectPicker
                value={projectId}
                onChange={setProjectId}
                projects={projects}
                loading={loadingProjects}
            />
            <Input
                label="Slug"
                description="Becomes the folder name and the {slug}.agi GitHub remote."
                value={slug}
                onValueChange={setSlug}
                placeholder="brain-v2"
            />
            <FolderRow
                folder={parentFolder}
                onChoose={choose}
                description={
                    primaryWorkspace
                        ? `Default: ${primaryWorkspace}`
                        : 'Pick where the envelope folder will be created.'
                }
            />

            <div>
                <Text size="xs" style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                    GitHub remote
                </Text>
                <div style={{ display: 'flex', gap: 8 }}>
                    {(['none', 'auto', 'paste'] as const).map((m) => (
                        <Action
                            key={m}
                            size="sm"
                            variant={remoteMode === m ? 'default' : 'ghost'}
                            color={remoteMode === m ? 'blue' : undefined}
                            onClick={() => setRemoteMode(m)}
                        >
                            {m === 'none'
                                ? 'No remote'
                                : m === 'auto'
                                    ? 'Auto-create'
                                    : 'Paste URL'}
                        </Action>
                    ))}
                </div>
                {remoteMode === 'auto' && (
                    <Input
                        label="GitHub owner / org"
                        value={remoteOwner}
                        onValueChange={setRemoteOwner}
                        placeholder="e.g. Renaissance-Analytics"
                        style={{ marginTop: 8 }}
                    />
                )}
                {remoteMode === 'paste' && (
                    <Input
                        label="Remote URL"
                        value={remoteUrl}
                        onValueChange={setRemoteUrl}
                        placeholder="git@github.com:owner/{slug}.agi.git"
                        style={{ marginTop: 8 }}
                    />
                )}
            </div>

            {error && <Text size="xs" style={{ color: 'var(--rose-500)' }}>{error}</Text>}
            <Footer
                onCancel={onCancel}
                onSubmit={submit}
                submitting={submitting}
                label="Create envelope"
                disabled={!projectId || !slug || !parentFolder}
            />
        </div>
    );
}

function AgiImportWizard({
    projects,
    loadingProjects,
    onCancel,
    onCreated,
}: {
    projects: TynnProject[];
    loadingProjects: boolean;
    onCancel: () => void;
    onCreated: (row: WorkspaceRow) => void;
}) {
    const [folder, setFolder] = useState<string>('');
    const [projectId, setProjectId] = useState('');
    const [detection, setDetection] = useState<DetectResult | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const choose = async () => {
        const p = await api().settings.chooseFolder('Choose existing folder');
        if (!p) return;
        setFolder(p);
        const d = await api().agi.detect(p);
        setDetection(d);
    };

    const submit = async () => {
        setSubmitting(true);
        setError(null);
        try {
            const project = projects.find((p) => p.id === projectId);
            if (!project) throw new Error('Pick a project.');
            if (!folder) throw new Error('Pick a folder.');

            const settings = await api().settings.get();
            const row: WorkspaceRow = {
                id: project.id,
                backend: project.backend ?? 'tynn',
                project_id: project.id,
                project_name: project.name,
                tynn_project_id: project.id,
                tynn_project_name: project.name,
                shape: 'agi',
                path: folder,
                editor: settings.default_editor ?? 'cursor',
                editor_cmd: settings.default_editor_cmd ?? null,
                start_cmd: settings.default_start_cmd ?? null,
                env_file: settings.default_env_file ?? '.env',
                last_opened_at: null,
                created_by_genie: 0,
            };
            const saved = await api().workspaces.add(row);
            onCreated(saved);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <FolderRow folder={folder} onChoose={choose} description="Pick the existing envelope (or pre-init) folder." />
            {detection && (
                <Card style={{ padding: 12 }}>
                    <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginBottom: 4 }}>
                        Detected
                    </Text>
                    <Badge
                        color={
                            detection.state === 'FULL_ENVELOPE'
                                ? 'emerald'
                                : detection.state === 'PRE_INIT'
                                    ? 'amber'
                                    : 'zinc'
                        }
                        variant="soft"
                    >
                        {detection.state}
                    </Badge>
                    <Text size="xs" style={{ display: 'block', marginTop: 6 }}>
                        Repos found: {detection.repos.length}
                    </Text>
                </Card>
            )}
            <ProjectPicker
                value={projectId}
                onChange={setProjectId}
                projects={projects}
                loading={loadingProjects}
            />
            {error && <Text size="xs" style={{ color: 'var(--rose-500)' }}>{error}</Text>}
            <Footer
                onCancel={onCancel}
                onSubmit={submit}
                submitting={submitting}
                label="Register"
                disabled={!projectId || !folder}
            />
        </div>
    );
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
}: {
    value: string;
    onChange: (v: string) => void;
    projects: TynnProject[];
    loading: boolean;
}) {
    const options = useMemo(
        () =>
            projects.map((p) => {
                const tag = (p.backend ?? 'tynn').toUpperCase();
                const owner = p.owner_name ?? '';
                return {
                    value: p.id,
                    label: `[${tag}] ${p.name}${owner ? ' · ' + owner : ''}`,
                };
            }),
        [projects],
    );
    return (
        <Select
            label="Project"
            description={loading ? 'Loading projects…' : 'Workspace associates with this project (Tynn or Aionima).'}
            value={value}
            onValueChange={onChange}
            list={options}
            required
        />
    );
}

function EditorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    return (
        <Select
            label="Editor"
            value={value}
            onValueChange={onChange}
            list={[
                { value: 'cursor', label: 'Cursor' },
                { value: 'vscode', label: 'VS Code' },
                { value: 'code-insiders', label: 'VS Code Insiders' },
            ]}
        />
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
