export type AddWorkspaceSourceId = 'new' | 'tynn' | 'git';

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
    if (!project.isWorkspace) return null;
    const envelope = project.repositories?.find(
        (repository) => repository.kind === 'envelope' && repository.url.trim(),
    );
    return envelope
        ? { url: envelope.url, branch: envelope.defaultBranch?.trim() || 'main' }
        : null;
}
