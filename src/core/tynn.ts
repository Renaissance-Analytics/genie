import { workspaceFolderName } from './add-workspace.js';
import { slugOf } from './repo-registry.js';
import type { FolderKind, PlanStep } from './workspace-model.js';

/**
 * ADD A WORKSPACE FROM TYNN (§6.1) — the pure half.
 *
 * Signed in (main/tynn-account.ts), Genie lists the person's projects (Genie 1's `GET /api/v1/projects`, over the session)
 * and the person picks one, as in Genie 1. That list says what each project CONTAINS (Tynn's MeApiController::projectRow,
 * confirmed 2026-10-21): `repositories[]` {id, url, default_branch, kind}, `is_workspace`, and the `envelope` block
 * {clone_url, default_branch, repo_owner, repo_name, …} with `envelope_status` 'present' | 'none'. Tynn NAMES the
 * container (Story #267 / genie#355); Genie never guesses it.
 *
 * So "from Tynn" brings that content, in Genie 1's order (renderer/lib/tynn-import.ts, main/workspace/add-workspace.ts):
 * the envelope Tynn names, cloned with its submodules on its branch; else a new envelope with each of the project's repos
 * a submodule under `repos/`; else a new, empty envelope. Every new one gets its first commit, as New's does. The folder is
 * `<parent>/<slug>.agi`; `project.json` carries the `tynn` link the envelope schema defines (`host`, `project`,
 * `projectId`; `owner` only when known — never guessed). A project already added here (a workspace whose `tynn.projectId`
 * is this one) is opened, never cloned twice. The plan is shown before anything is written, like every other source.
 */

/** One of the project's repositories, as Tynn lists it. A missing branch or kind is `null`, never a guess. */
export interface TynnRepository {
    readonly url: string;
    readonly defaultBranch: string | null;
    readonly kind: string | null;
}

/** The envelope repository Tynn names for the project (`envelope_status: 'present'`). */
export interface TynnEnvelope {
    /** The https form, cloneable with a GitHub App token (Tynn's `clone_url`). */
    readonly cloneUrl: string;
    readonly defaultBranch: string | null;
    readonly owner: string | null;
    readonly name: string | null;
}

export interface TynnProject {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly vision: string | null;
    readonly isWorkspace: boolean;
    readonly repositories: readonly TynnRepository[];
    readonly envelope: TynnEnvelope | null;
}

/**
 * WHERE TYNN IS (the owner, 2026-10-21: "tynn is not a changeable host"). Testing reaches a local Tynn through the test
 * VM's hosts file (tynn.ai → this machine's tynn.gen), never through a product setting.
 */
export const TYNN_HOST = 'https://tynn.ai';

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

function parseRepository(raw: unknown): TynnRepository | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const url = text(r.url);
    return url === null ? null : { url, defaultBranch: text(r.default_branch), kind: text(r.kind) };
}

/** The envelope block, only when Tynn's own status says it is present and it names something to clone. */
function parseEnvelope(status: unknown, raw: unknown): TynnEnvelope | null {
    if (status !== 'present' || typeof raw !== 'object' || raw === null) return null;
    const e = raw as Record<string, unknown>;
    const cloneUrl = text(e.clone_url) ?? text(e.url);
    return cloneUrl === null ? null : { cloneUrl, defaultBranch: text(e.default_branch), owner: text(e.repo_owner), name: text(e.repo_name) };
}

/** The project endpoint's own shape, and nothing it did not say. Null for anything that is not a project. */
export function parseTynnProject(raw: unknown): TynnProject | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'number' ? String(r.id) : typeof r.id === 'string' ? r.id : null;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    const slug = typeof r.slug === 'string' ? r.slug.trim() : '';
    if (id === null || name.length === 0 || !SLUG.test(slug) || slug.includes('..')) return null;
    return {
        id,
        name,
        slug,
        vision: text(r.vision),
        isWorkspace: r.is_workspace === true,
        repositories: Array.isArray(r.repositories) ? r.repositories.map(parseRepository).filter((x): x is TynnRepository => x !== null) : [],
        envelope: parseEnvelope(r.envelope_status, r.envelope),
    };
}

/** A repository the new envelope takes as a submodule, and the folder under `repos/` it lands in. */
export interface TynnSubmodule {
    readonly url: string;
    readonly branch: string | null;
    readonly name: string;
}

/** What the workspace starts with. `empty` is an answer, not a fallback: a project with no repositories is complete. */
export type TynnContent =
    | { readonly kind: 'envelope'; readonly url: string; readonly branch: string | null }
    | { readonly kind: 'repos'; readonly repos: readonly TynnSubmodule[] }
    | { readonly kind: 'empty' };

/**
 * The folder a repository takes under `repos/` — Genie 1's `submoduleName` over `deriveRepoName`: the URL's last segment
 * without `.git`, anything git would not take as a name turned to a dash; `repo` when nothing is left.
 */
export function submoduleName(url: string): string {
    const leaf = url.trim().replace(/[/\\]+$/, '').split(/[/\\:]/).pop() ?? '';
    const cleaned = leaf.replace(/\.git$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'repo' : cleaned;
}

/** What the project brings, in Genie 1's order: the envelope Tynn names; else its repositories; else nothing. */
export function tynnContent(project: TynnProject): TynnContent {
    if (project.envelope) return { kind: 'envelope', url: project.envelope.cloneUrl, branch: project.envelope.defaultBranch };
    // An envelope is never a submodule: an envelope-kind repository with no envelope named is not something to nest.
    const repos = project.repositories.filter((r) => r.kind !== 'envelope').map((r) => ({ url: r.url, branch: r.defaultBranch, name: submoduleName(r.url) }));
    return repos.length > 0 ? { kind: 'repos', repos } : { kind: 'empty' };
}

export interface TynnLink {
    readonly host: string;
    readonly project: string;
    readonly projectId: string;
}

export function tynnLink(project: Pick<TynnProject, 'id' | 'slug'>, host: string): TynnLink {
    return { host: host.replace(/\/+$/, ''), project: project.slug, projectId: project.id };
}

/**
 * Where a Tynn project's envelope is made: `<parent>/<slug>.agi`, the `.agi` folder New makes (parity row 30; Genie 2 made a
 * bare `<parent>/<slug>`). The workspace's id stays the slug, as New's id is its folder without `.agi`.
 */
export function tynnEnvelopePath(parent: string, project: TynnProject): string {
    return `${parent.replace(/[\\/]+$/, '')}/${workspaceFolderName(project.slug)}`;
}

export type TynnAddPlan =
    | {
          ok: true;
          source: 'tynn';
          project: TynnProject;
          host: string;
          parent: string;
          path: string;
          /** The workspace's id: the folder without `.agi`, as New's is. */
          id: string;
          kind: FolderKind;
          content: TynnContent;
          steps: PlanStep[];
          manifest: { name: string; description: string; tynn: TynnLink };
      }
    /** `workspaceId`: the project is already here, as that workspace — open it instead. */
    | { ok: false; reason: string; workspaceId?: string };

/** The plan for the chosen project; nothing written here. Every refusal comes before anything would be. */
export function tynnAddPlan(input: { project: TynnProject; parent: string; folderExists: boolean; host: string; addedAs?: string | null }): TynnAddPlan {
    const { project } = input;
    if (input.addedAs) return { ok: false, reason: `${project.name} is already added here, as the workspace ${input.addedAs}. Open that workspace instead.`, workspaceId: input.addedAs };
    const parent = input.parent.replace(/[\\/]+$/, '');
    const path = tynnEnvelopePath(parent, project);
    if (input.folderExists) return { ok: false, reason: `${path} already exists; add that folder instead of creating the Tynn envelope over it` };
    const content = tynnContent(project);
    if (content.kind === 'repos') {
        // By the registry's slug (repo-registry.ts), which also folds case: `API` and `api` are one folder on Windows.
        const seen = new Map<string, string>();
        for (const r of content.repos) {
            const other = seen.get(slugOf(r.name));
            if (other !== undefined) return { ok: false, reason: `Tynn lists two repositories that would both be repos/${r.name} (${other} and ${r.url}); rename one on Tynn first` };
            seen.set(slugOf(r.name), r.url);
        }
    }
    const link = tynnLink(project, input.host);
    const step = (action: string, writes = true): PlanStep => ({ action, path, writes });
    const linkStep = step(`link to Tynn project ${project.name} (${link.host})`);
    const steps: PlanStep[] =
        content.kind === 'envelope'
            ? [step(`clone ${content.url}${content.branch ? ` (branch ${content.branch})` : ''} with its submodules into ${path}`), linkStep]
            : [
                  step(`create ${path}`),
                  step('write project.json'),
                  step('write README.md, RULES.md, AGENTS.md, CLAUDE.md and .gitignore'),
                  step('create repos/, .ai/, sandbox/ and .trash/'),
                  linkStep,
                  step('make the first commit on main'),
                  ...(content.kind === 'repos'
                      ? [
                            ...content.repos.map((r) => step(`add ${r.url} as the submodule repos/${r.name}, tracking ${r.branch ?? 'its default branch'}`)),
                            step(`commit the ${content.repos.length} submodule${content.repos.length === 1 ? '' : 's'}`),
                        ]
                      : []),
              ];
    steps.push(step('register in Genie', false));
    return {
        ok: true,
        source: 'tynn',
        project,
        host: link.host,
        parent,
        path,
        id: workspaceFolderName(project.slug).replace(/\.agi$/, ''),
        kind: content.kind === 'envelope' ? 'full-envelope' : 'empty',
        content,
        steps,
        manifest: { name: project.name, description: project.vision ?? '', tynn: link },
    };
}
