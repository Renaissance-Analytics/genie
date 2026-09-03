import { tynnProjectImportSource, tynnWorkspaceSource } from './workspace-onboarding';
import type { BackendKind, WorkspaceRow } from './genie';

/**
 * WHERE A TYNN IMPORT GOES, and why (genie#355).
 *
 * Importing from Tynn used to end, unconditionally, in the scan-and-convert
 * upgrade wizard. That wizard exists to turn a folder that is NOT an `.agi`
 * envelope into one — so pointing an already-enveloped project at it made the
 * owner pick a repo, clone it, and then walk a conversion with nothing to
 * convert. An envelope carries its repos as submodules: the envelope IS the
 * unit, which is also why a repo picker is the wrong question for it.
 *
 * The decision lives here, as a pure function, so the renderer READS a route
 * rather than containing one — and so both halves of it can be tested without a
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

export type TynnImportRoute =
    | {
          /** Already here. Offer to open it rather than import a second copy. */
          stage: 'tynn-open-existing';
          reason: 'already-registered';
          workspaceId: string;
      }
    | {
          /** Ask where to put it, clone the envelope, register. Nothing else. */
          stage: 'tynn-envelope';
          reason: 'envelope-repo';
          source: { url: string; branch: string };
      }
    | {
          /** Not an envelope (or Tynn never said where it is) — scan and convert. */
          stage: 'agi-interactive';
          reason: 'no-envelope-repo' | 'envelope-repo-undeclared';
          mode: 'local' | 'remote';
          sourceUrl: string;
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

    // The `envelope`-kind repository is the whole branch: it is what Tynn's
    // `is_envelope` is derived FROM, and unlike the flag it also says which repo
    // to clone. Genie has been given it on `/api/v1/projects` all along.
    const envelope = tynnWorkspaceSource(project);
    if (envelope) {
        return { stage: 'tynn-envelope', reason: 'envelope-repo', source: envelope };
    }

    // No envelope to clone, so the wizard is still the right answer. `isWorkspace`
    // separates the two ways to get here: an ordinary non-envelope project, versus
    // a project Tynn marks as an envelope while declaring no repository for it —
    // a gap on Tynn's side that the UI should name rather than silently absorb.
    const fallback = tynnProjectImportSource(project);
    return {
        stage: 'agi-interactive',
        reason: project.isWorkspace ? 'envelope-repo-undeclared' : 'no-envelope-repo',
        mode: fallback ? 'remote' : 'local',
        sourceUrl: fallback?.url ?? '',
    };
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

/** The effects the envelope import needs, injected so the contract is testable. */
export interface TynnEnvelopeImportDeps {
    /** Clones recursively — the envelope's submodules come down with it. */
    clone: (url: string, parentPath: string) => Promise<{ path: string }>;
    defaultEnvFile: () => Promise<string>;
    addWorkspace: (row: WorkspaceRow) => Promise<WorkspaceRow>;
}

/**
 * The whole envelope import: clone the declared envelope into the folder the
 * user chose and register THAT as the workspace. No scan, no repo picker, no
 * conversion — the envelope already is one.
 */
export async function importTynnEnvelopeWorkspace(
    input: {
        project: TynnImportProject;
        source: { url: string; branch: string };
        parentPath: string;
    },
    deps: TynnEnvelopeImportDeps,
): Promise<WorkspaceRow> {
    const parentPath = input.parentPath.trim();
    if (!parentPath) throw new Error('Choose where to put the workspace.');

    const url = input.source.url.trim();
    if (!url) throw new Error('This Tynn project declares no envelope repository.');

    const cloned = await deps.clone(url, parentPath);
    const envFile = await deps.defaultEnvFile();

    return deps.addWorkspace({
        id: input.project.id,
        backend: input.project.backend ?? 'tynn',
        project_id: input.project.id,
        project_name: input.project.name ?? '',
        tynn_project_id: input.project.id,
        tynn_project_name: input.project.name ?? '',
        shape: 'agi',
        path: cloned.path,
        editor: null,
        editor_cmd: null,
        start_cmd: null,
        env_file: envFile,
        last_opened_at: null,
        // Genie did not CREATE this envelope — it brought an existing one down.
        created_by_genie: 0,
    });
}
