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
 *
 * The ACCOUNT is read before the name, so the form can say "this stays on your
 * machine" the moment it opens. The name only decides whether there is a
 * repository name to show, which is all `unnamed` means.
 */
export function containerRepoPlan(input: {
    githubConnected: boolean;
    githubCanProvision: boolean;
    owner: string;
    slug: string;
}): ContainerRepoPlan {
    if (!input.githubConnected) return { kind: 'local-only', reason: 'not-connected' };
    if (!input.githubCanProvision) return { kind: 'local-only', reason: 'missing-permission' };
    const folder = workspaceFolderName(input.slug);
    if (!folder) return { kind: 'local-only', reason: 'unnamed' };
    return { kind: 'github', owner: input.owner, repo: folder };
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

/**
 * FIRST RUN IS TWO STEPS.
 *
 * It was seven, with Tynn sign-in and GitHub connect in front of ever seeing an agent work.
 * The plan's target: *"pick a folder; Genie verifies the one driver it needs and starts one agent
 * with a first prompt pre-filled… first agent reply in under 2 minutes, 2 decisions."*
 *
 * ## What happened to the other five, each confirmed in source before it was removed
 *
 *  - **Tynn** — `master.tsx` will not render the app signed out at all (`authChecked &&
 *    !signedIn` → `SignInPrompt`). The step asked for something the app cannot start without,
 *    which makes it a second door on the same wall.
 *  - **GitHub** — already optional, and `GitHubConnect` is in Settings.
 *  - **Toolchain** — `ToolchainSetupWizard` is mounted by `settings.tsx`. The one case that
 *    genuinely blocks a first agent, a machine with no driver at all, is checked in step 2 where
 *    it can be acted on rather than as a gate in front of everything.
 *  - **Genie OS** — its workspace is prepared automatically, and the optional GitHub backup is
 *    `syncGenieOs`, which `settings.tsx` already calls.
 *  - **Welcome** — a page whose only control was "Get started".
 *
 * A deferred prompt that does not exist is not deferred, it is deleted — so each of those was
 * located somewhere a person can still reach it, not assumed to be reachable.
 */
export type FirstRunStepId = 'workspace' | 'agent';

export interface FirstRunStep {
    id: FirstRunStepId;
    title: string;
    optional: boolean;
}

export const FIRST_RUN_STEPS: readonly FirstRunStep[] = [
    { id: 'workspace', title: 'Pick a folder', optional: false },
    { id: 'agent', title: 'Meet your first agent', optional: false },
] as const;

/** One of the three first prompts "New agent" offers. */
export interface FirstAgentPreset {
    id: string;
    label: string;
    /** The prompt, pre-filled and editable. */
    prompt: string;
}

/**
 * THE THREE FIRST PROMPTS, from the plan, each ending the way every Genie turn should.
 *
 * *"each instructing the agent to finish with `imDone` + a handoff — so first run teaches the
 * whole loop by construction."* That instruction is the load-bearing part: a first agent that
 * answers and stops teaches that Genie is a chat window, while one that files a handoff teaches
 * the loop the whole product is built on, on the very first run.
 */
const FINISH = 'When you are done, call imDone with a handoff note saying what you found and what the next run should pick up.';

export const FIRST_AGENT_PRESETS: readonly FirstAgentPreset[] = [
    {
        id: 'orientation',
        label: 'Learn this codebase',
        prompt: `Learn this codebase and write me an orientation: what it is, how it is laid out, how to run it, and the three things you would want to know before changing anything. ${FINISH}`,
    },
    {
        id: 'failing-test',
        label: 'Fix the top failing test',
        prompt: `Run the test suite, find the top failing test, and fix it at the root cause rather than the symptom. Write the failing test first if there is not one. ${FINISH}`,
    },
    {
        id: 'review-commits',
        label: 'Review my last 5 commits',
        prompt: `Review my last 5 commits. Tell me what is wrong, what is risky, and what you would have done differently — specifically, with file and line references. ${FINISH}`,
    },
] as const;

/**
 * THE ONE DRIVER the first agent needs, or a report that there is none.
 *
 * The old flow asked which of twenty-one TUIs to enable before anything had run — a question
 * nobody can answer on first launch, and a decision Settings owns anyway. This asks the only
 * question that blocks a first agent: is there something on this machine that can run one?
 *
 * Falling back to any installed driver is deliberate. A configured default that is not installed
 * is a stale setting, and refusing on its behalf would strand a user whose machine demonstrably
 * has a working CLI.
 */
export function firstAgentDriver(input: {
    configured: string | null;
    installed: readonly string[];
}): { ready: true; driver: string } | { ready: false } {
    if (input.installed.length === 0) return { ready: false };
    if (input.configured && input.installed.includes(input.configured)) {
        return { ready: true, driver: input.configured };
    }
    // `claude` before the list's own order: it is the provider Genie supports most completely
    // (ACP, resume, rate limits), so it is the best first experience when nothing was chosen.
    if (input.installed.includes('claude')) return { ready: true, driver: 'claude' };
    return { ready: true, driver: input.installed[0]! };
}

export function nextIncompleteFirstRunStep(
    completed: Partial<Record<FirstRunStepId, boolean>>,
): FirstRunStepId | null {
    return FIRST_RUN_STEPS.find((step) => !step.optional && !completed[step.id])?.id ?? null;
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
