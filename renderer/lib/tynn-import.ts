import type { BackendKind } from './genie';

/**
 * WHAT A TYNN PROJECT RESOLVES TO, and why it is never a question.
 *
 * **All projects in Tynn are workspaces.** So importing one is not a search for
 * something to clone or something to convert — it is bringing a workspace that
 * already has a name and an identity onto this machine. What it CONTAINS varies:
 * a published `.agi` container, some ordinary repositories, or nothing at all.
 * None of those three is a failure to be one of the others.
 *
 * It used to ask a different question — "what is there here to clone or
 * convert?" — and answer `agi-interactive` whenever the answer was "nothing",
 * which is the scan-and-convert wizard in `mode: 'local'`: *go and find a folder
 * to convert.* The one entry point that knows exactly which workspace you mean
 * was the one that sent you looking for it on disk.
 *
 * The decision lives here as a pure function so the renderer READS a route
 * rather than containing one, and so both halves of it can be tested without a
 * window (the way `provider-settings.ts` and `setting-tiers.ts` are).
 */

/** The subset of a `TynnProject` the route depends on. */
export interface TynnImportProject {
    id: string;
    name?: string;
    backend?: BackendKind;
    /** Tynn's `is_envelope`, mirrored onto the project row as `is_workspace`. */
    isWorkspace?: boolean;
    repositories?: Array<{ url: string; defaultBranch?: string; kind?: string }>;
}

/** The subset of a `WorkspaceRow` that says which Tynn project it is linked to. */
export interface TynnImportWorkspaceLink {
    id: string;
    project_id?: string | null;
    tynn_project_id?: string | null;
}

/** A repository the workspace will contain, as Tynn declares it. */
export interface TynnImportRepo {
    url: string;
    branch: string;
    /** The folder it takes under `repos/`. */
    name: string;
}

/**
 * What the imported workspace starts with. `empty` is an ANSWER, not a
 * fallback: a Tynn project with no repositories is a workspace with no
 * repositories, and it is complete.
 */
export type TynnImportContent =
    | { kind: 'envelope'; url: string; branch: string }
    | { kind: 'repos'; repos: TynnImportRepo[] }
    | {
          kind: 'empty';
          /**
           * `container-undeclared` is the Tynn-side gap worth NAMING on screen:
           * the project is marked an envelope while declaring no repository for
           * it, so Genie has nothing to bring down. It still gets a workspace —
           * it just gets a new one, and the UI says so.
           */
          reason: 'no-repositories' | 'container-undeclared';
      };

export type TynnImportRoute =
    | {
          /** Already here. Offer to open it rather than import a second copy. */
          stage: 'tynn-open-existing';
          reason: 'already-registered';
          workspaceId: string;
      }
    | {
          /** A workspace, whatever it happens to contain. */
          stage: 'tynn-workspace';
          content: TynnImportContent;
      };

function linkedWorkspace(
    projectId: string,
    workspaces: readonly TynnImportWorkspaceLink[],
): TynnImportWorkspaceLink | null {
    return (
        workspaces.find((workspace) =>
            [workspace.tynn_project_id, workspace.project_id].some(
                (id) => !!id?.trim() && id.trim() === projectId,
            ),
        ) ?? null
    );
}

/**
 * The repo folder name a URL yields — its basename, minus `.git`. Mirrors
 * `deriveRepoName` in `main/workspace/create-agi.ts`, which is what actually
 * names the folder; this is the preview, and the name the plan carries so the
 * confirm screen can show where each repository will land.
 */
export function repoFolderName(url: string): string {
    const leaf = url.trim().replace(/[/\\]+$/, '').split(/[/\\:]/).pop() ?? '';
    return leaf.replace(/\.git$/i, '') || 'repo';
}

/**
 * WHAT the project contains. The `envelope`-kind repository wins when there is
 * one: it is what Tynn's `is_envelope` is derived FROM, and unlike the flag it
 * also says which repo to clone. Genie has been given it on `/api/v1/projects`
 * all along.
 */
export function tynnImportContent(project: TynnImportProject): TynnImportContent {
    const declared = (project.repositories ?? []).filter((repo) => repo.url.trim());

    const envelope = declared.find((repo) => repo.kind === 'envelope');
    if (envelope) {
        return {
            kind: 'envelope',
            url: envelope.url.trim(),
            branch: envelope.defaultBranch?.trim() || 'main',
        };
    }

    const repos = declared
        .filter((repo) => repo.kind !== 'envelope')
        .map((repo) => ({
            url: repo.url.trim(),
            branch: repo.defaultBranch?.trim() || 'main',
            name: repoFolderName(repo.url),
        }));
    if (repos.length > 0) return { kind: 'repos', repos };

    return {
        kind: 'empty',
        reason: project.isWorkspace ? 'container-undeclared' : 'no-repositories',
    };
}

export function tynnImportRoute(
    project: TynnImportProject,
    workspaces: readonly TynnImportWorkspaceLink[],
): TynnImportRoute {
    const existing = linkedWorkspace(project.id, workspaces);
    if (existing) {
        return {
            stage: 'tynn-open-existing',
            reason: 'already-registered',
            workspaceId: existing.id,
        };
    }

    return { stage: 'tynn-workspace', content: tynnImportContent(project) };
}

/**
 * Every project the signed-in user can reach, each carrying the id of the local
 * workspace already linked to it (or null). Unlike `availableTynnProjects`, which
 * DROPS the linked ones, this keeps them so the picker can say "already added"
 * and offer to open it — the alternative being a project that silently is not in
 * the list, which reads as Tynn having lost it.
 */
export function tynnImportChoices<T extends { id: string }>(
    projects: readonly T[],
    workspaces: readonly TynnImportWorkspaceLink[],
): Array<{ project: T; linkedWorkspaceId: string | null }> {
    return projects.map((project) => ({
        project,
        linkedWorkspaceId: linkedWorkspace(project.id, workspaces)?.id ?? null,
    }));
}
