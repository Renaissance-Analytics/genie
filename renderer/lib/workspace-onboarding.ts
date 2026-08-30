export type AddWorkspaceSourceId = 'new' | 'gapp' | 'tynn' | 'git';

export interface AddWorkspaceSource {
    id: AddWorkspaceSourceId;
    title: string;
    description: string;
    icon: string;
}

/** Every route ends in the same inspect → review → apply managed-workspace wizard. */
export const ADD_WORKSPACE_SOURCES: readonly AddWorkspaceSource[] = [
    {
        id: 'new',
        title: 'New workspace',
        description: 'Create a managed workspace and its first repository.',
        icon: 'sparkles',
    },
    {
        id: 'gapp',
        title: 'New GApp workspace',
        description: 'Create a GApp Development Workspace and inspect its starting folder.',
        icon: 'blocks',
    },
    {
        id: 'tynn',
        title: 'Import from Tynn',
        description: 'Choose one of your Tynn workspaces and bring its repositories to this machine.',
        icon: 'cloud-download',
    },
    {
        id: 'git',
        title: 'Import from Git',
        description: 'Start from a GitHub repository now; more Git providers can plug into this route later.',
        icon: 'git-branch',
    },
] as const;

export function workspaceWizardEntry(source: AddWorkspaceSourceId): {
    mode: 'local' | 'remote' | 'tynn' | 'gapp';
} {
    if (source === 'gapp') return { mode: 'gapp' };
    if (source === 'git') return { mode: 'remote' };
    if (source === 'tynn') return { mode: 'tynn' };
    return { mode: 'local' };
}

export type WorkspaceDestinationKind = 'workspace' | 'gdw';

/** GDW is a destination contract, independent of where the source came from. */
export function gdwChoicesForSource(
    source: 'new' | 'git' | 'tynn',
): WorkspaceDestinationKind[] {
    return ['workspace', 'gdw'];
}

export function canFinishFirstRun(input: {
    existingWorkspaceCount: number;
    setupComplete: boolean;
}): boolean {
    return input.setupComplete && input.existingWorkspaceCount > 0;
}

export function scannedWorkspaceAction(scan: { has_project_json: boolean }): 'register' | 'convert' {
    return scan.has_project_json ? 'register' : 'convert';
}

export type FirstRunStepId =
    | 'welcome'
    | 'drivers'
    | 'tynn'
    | 'github'
    | 'verify'
    | 'workspace'
    | 'ready';

export interface FirstRunStep {
    id: FirstRunStepId;
    title: string;
    optional: boolean;
}

export const FIRST_RUN_STEPS: readonly FirstRunStep[] = [
    { id: 'welcome', title: 'Getting the Workstation Ready', optional: false },
    { id: 'drivers', title: 'Choose your model drivers', optional: false },
    { id: 'tynn', title: 'Sign in to Tynn', optional: false },
    { id: 'github', title: 'Connect GitHub', optional: true },
    { id: 'verify', title: 'Verify your drivers', optional: false },
    { id: 'workspace', title: 'Add your first workspace', optional: false },
    { id: 'ready', title: 'Ready', optional: false },
] as const;

export function nextIncompleteFirstRunStep(
    completed: Partial<Record<FirstRunStepId, boolean>>,
): FirstRunStepId | null {
    return FIRST_RUN_STEPS.find((step) => !step.optional && !completed[step.id])?.id ?? null;
}

export function tynnWorkspaceSource(project: {
    isWorkspace?: boolean;
    repositories?: Array<{ url: string; defaultBranch?: string; kind?: string }>;
}): { url: string; branch: string } | null {
    const envelope = project.repositories?.find(
        (repository) => repository.kind === 'envelope' && repository.url.trim(),
    );
    return envelope
        ? { url: envelope.url, branch: envelope.defaultBranch?.trim() || 'main' }
        : null;
}

export function tynnProjectImportSource(project: {
    isWorkspace?: boolean;
    repositories?: Array<{ url: string; defaultBranch?: string; kind?: string }>;
}): { kind: 'envelope' | 'project'; url: string; branch: string } | null {
    const envelope = tynnWorkspaceSource(project);
    if (envelope) return { kind: 'envelope', ...envelope };
    const repository = project.repositories?.find(
        (candidate) => candidate.kind === 'code' && candidate.url.trim(),
    );
    return repository
        ? {
            kind: 'project',
            url: repository.url,
            branch: repository.defaultBranch?.trim() || 'main',
        }
        : null;
}

/**
 * Tynn is the project catalog, not merely a repository catalog. Every project
 * the signed-in user can access is importable until a local Genie workspace is
 * already linked to it; projects without repositories continue in the local
 * source branch of the interactive wizard.
 */
export function availableTynnProjects<T extends { id: string }>(
    projects: readonly T[],
    workspaces: readonly { project_id?: string | null; tynn_project_id?: string | null }[],
): T[] {
    const linked = new Set(
        workspaces.flatMap((workspace) => [workspace.tynn_project_id, workspace.project_id])
            .map((id) => id?.trim())
            .filter((id): id is string => !!id),
    );
    return projects.filter((project) => !linked.has(project.id));
}
