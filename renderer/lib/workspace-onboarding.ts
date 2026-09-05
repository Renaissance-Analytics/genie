export type AddWorkspaceSourceId = 'new' | 'gapp' | 'local' | 'git' | 'tynn';

/** MAKE a workspace, or ADOPT something that already exists. */
export type AddWorkspaceGroup = 'create' | 'adopt';

export interface AddWorkspaceSource {
    id: AddWorkspaceSourceId;
    group: AddWorkspaceGroup;
    title: string;
    description: string;
    icon: string;
}

/**
 * The ways a workspace can start. Two of them MAKE one and three of them ADOPT
 * something that already exists — and that is the whole distinction (genie#431).
 *
 * It used to be one distinction short. `new` returned the same `{ mode: 'local' }`
 * an import returns, so "New workspace" opened the scanner and asked which
 * folder to inspect; there was nothing to inspect, because the workspace did not
 * exist yet, and so an empty workspace could not be created at all. The scanner
 * is right for a folder and right for a repository — it reads what is there
 * before it writes anything — and it has no job on a workspace that is about to
 * be conjured out of a name.
 */
export const ADD_WORKSPACE_SOURCES: readonly AddWorkspaceSource[] = [
    {
        id: 'new',
        group: 'create',
        title: 'New workspace',
        description: 'Name it, say where it lives. Genie makes the folder and its first commit.',
        icon: 'sparkles',
    },
    {
        id: 'gapp',
        group: 'create',
        title: 'New GApp workspace',
        description: 'The same, set up to build and preview a Genie App.',
        icon: 'blocks',
    },
    {
        id: 'local',
        group: 'adopt',
        title: 'Open existing folder',
        description: 'Point Genie at a folder you already have. It reads what is there and shows the plan before writing.',
        icon: 'folder-open',
    },
    {
        id: 'git',
        group: 'adopt',
        title: 'Import from Git',
        description: 'Start from a GitHub repository now; more Git providers can plug into this route later.',
        icon: 'git-branch',
    },
    {
        id: 'tynn',
        group: 'adopt',
        title: 'Import from Tynn',
        description: 'Choose one of your Tynn projects and bring its repositories to this machine.',
        icon: 'cloud-download',
    },
] as const;

export function workspaceWizardEntry(source: AddWorkspaceSourceId): {
    mode: 'create' | 'local' | 'remote' | 'tynn' | 'gapp';
} {
    if (source === 'gapp') return { mode: 'gapp' };
    if (source === 'local') return { mode: 'local' };
    if (source === 'git') return { mode: 'remote' };
    if (source === 'tynn') return { mode: 'tynn' };
    return { mode: 'create' };
}

/**
 * The folder a workspace named `name` gets. Lower-case, dashes for spaces, and
 * only characters that survive a filesystem, a git remote and a URL.
 *
 * The user types a NAME ("Acme Storefront"); they are not asked to invent a
 * slug, because there is exactly one sensible answer and asking for it is a
 * question with a right answer, which is the definition of a question not worth
 * asking.
 */
export function workspaceSlug(name: string): string {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9.]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '');
}

/**
 * The on-disk folder name — the slug plus the storage suffix, mirroring
 * `envelopeFolderName` in `main/workspace/create-agi.ts` (which is where the
 * folder is actually made; this is the preview the form shows while typing).
 * Idempotent, so a name that already carries the suffix is not given a second.
 */
export function workspaceFolderName(name: string): string {
    const slug = workspaceSlug(name);
    if (!slug) return '';
    return /\.(agi|gapp)$/i.test(slug) ? slug : `${slug}.agi`;
}

/**
 * Where the workspace folder will end up, for the form to show while the name is
 * still being typed. The renderer has no `node:path`, and the separator is taken
 * from the parent so the preview reads as a path on the machine it describes.
 */
export function workspacePathPreview(parent: string, folder: string): string {
    const sep = parent.includes('\\') ? '\\' : '/';
    return `${parent.replace(/[\\/]+$/, '')}${sep}${folder}`;
}

export type ContainerRepoPlan =
    | { kind: 'github'; owner: string; repo: string }
    | { kind: 'local-only'; reason: 'not-connected' | 'missing-permission' | 'unnamed' };

/**
 * Whether a new workspace also gets its container repository on GitHub.
 *
 * DERIVED, never asked (genie#431). The owner: "Workspace still get the
 * {workspace}.agi if github is connected." A connected account means the
 * container repo happens; no connection means it does not. It was a three-way
 * "No remote / Auto-create / Paste URL" picker, which turned a consequence of
 * account state into a question, and put a GitHub decision in front of someone
 * who only wanted a folder.
 *
 * `missing-permission` is the same fallback rather than an error: Genie's App
 * can be connected but without `contents` write, and a workspace must never be
 * blocked on GitHub — creating one is a local act that GitHub can only add to.
 */
export function containerRepoPlan(input: {
    githubConnected: boolean;
    githubCanProvision: boolean;
    owner: string;
    slug: string;
}): ContainerRepoPlan {
    const folder = workspaceFolderName(input.slug);
    if (!folder) return { kind: 'local-only', reason: 'unnamed' };
    if (!input.githubConnected) return { kind: 'local-only', reason: 'not-connected' };
    if (!input.githubCanProvision) return { kind: 'local-only', reason: 'missing-permission' };
    return { kind: 'github', owner: input.owner, repo: folder };
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
 * Tynn is the project catalog, not merely a repository catalog: every project the
 * signed-in user can access appears in the import picker.
 *
 * WHICH projects the picker offers, and what it does with an already-linked one,
 * now lives in `./tynn-import` — `tynnImportChoices` KEEPS the linked ones and
 * labels them, so the modal can offer to open the workspace that exists rather
 * than dropping the project out of the list as though Tynn had lost it
 * (genie#355).
 */
