import type { WorkspaceRow } from '../db';
import {
    cloneAgiEnvelope,
    convertToAgiPlan,
    createAgiEnvelope,
    deriveRepoName,
} from './create-agi';
import type {
    AddWorkspaceContent,
    AddWorkspacePlan,
    AddWorkspaceRepo,
} from './add-workspace-types';

export type {
    AddWorkspaceContent,
    AddWorkspacePlan,
    AddWorkspaceRepo,
} from './add-workspace-types';

/**
 * ADDING A WORKSPACE — the whole of it, once, for every entry point there is.
 *
 * THE RULE. A workspace is a NAME and a FOLDER. Repositories, a Tynn project, a
 * container repo on GitHub, a GitHub connection: all optional, and **none of
 * them may gate creation.** Every defect this module was written to end was the
 * same defect wearing a different hat — something optional treated as a
 * precondition:
 *
 *   - importing a Tynn project with no `.agi` repo asked the user to go and
 *     find a folder to convert, for the one entry point that already knew
 *     exactly which workspace was meant;
 *   - "new workspace" was routed through a scanner that had nothing to scan;
 *   - a governed Ops child with no repository could not be provisioned at all,
 *     because provisioning meant cloning and there was nothing to clone.
 *
 * Each of those lived in its own orchestration, so each had to learn the rule
 * separately and none of them did. There is one orchestration now. The five
 * entry points differ ONLY in what they already know, which is why they hand in
 * a plan rather than a procedure: a name, a folder, and whatever content they
 * happen to have — including none.
 *
 * WHAT IS NOT HERE. Inspecting an existing folder (reading it to find its repos
 * and notes) stays in the interactive wizard, because it is a conversation with
 * the user about what is on their disk, not a way of making a workspace. What it
 * produces is a {@link AddWorkspaceContent} of kind `repos`, which comes back
 * through here like everything else.
 */

/** The row shape {@link addWorkspace} accepts — the registrar's input. */
export type AddWorkspaceRow = Omit<
    WorkspaceRow,
    | 'sort_order'
    | 'mcp_enabled'
    | 'process_approval'
    | 'terminal_approval'
    | 'schedule_approval'
    | 'assignment_managed'
    | 'agent_access'
    | 'sacred_name'
> &
    Partial<
        Pick<
            WorkspaceRow,
            | 'sort_order'
            | 'mcp_enabled'
            | 'process_approval'
            | 'terminal_approval'
            | 'schedule_approval'
            | 'assignment_managed'
            | 'agent_access'
            | 'sacred_name'
        >
    >;

/**
 * The effects, injected — so the decision above is assertable against a real
 * folder on a real disk without a database or an Electron runtime. Defaults are
 * lazily required for the same reason `ops-provision` does it: this module must
 * stay import-clean.
 */
export interface AddWorkspaceDeps {
    register?: (row: AddWorkspaceRow) => WorkspaceRow;
    defaultEnvFile?: () => string;
    createEnvelope?: typeof createAgiEnvelope;
    cloneEnvelope?: typeof cloneAgiEnvelope;
    buildEnvelope?: typeof convertToAgiPlan;
}

function defaultRegister(row: AddWorkspaceRow): WorkspaceRow {
    const { addWorkspace } = require('../db') as typeof import('../db');
    return addWorkspace(row);
}

function defaultEnvFile(): string {
    const { getAllSettings } = require('../db') as typeof import('../db');
    return getAllSettings().default_env_file ?? '.env';
}

/**
 * Make (or bring down) the workspace this plan describes, register it, and
 * return the saved row.
 *
 * The only two things it refuses are the two things a workspace cannot do
 * without. Everything else missing is a workspace with less in it.
 */
export async function createWorkspace(
    plan: AddWorkspacePlan,
    deps: AddWorkspaceDeps = {},
): Promise<WorkspaceRow> {
    const name = plan.name.trim();
    if (!name) throw new Error('Give the workspace a name.');
    const parentPath = plan.parentPath.trim();
    if (!parentPath) throw new Error('Choose where the workspace should live.');
    const slug = plan.slug.trim() || workspaceSlug(name);
    if (!slug) throw new Error('Give the workspace a name it can be a folder for.');

    const create = deps.createEnvelope ?? createAgiEnvelope;
    const clone = deps.cloneEnvelope ?? cloneAgiEnvelope;
    const build = deps.buildEnvelope ?? convertToAgiPlan;

    let workspacePath: string;
    // `created_by_genie` records whether this envelope is Genie's own work. A
    // cloned container existed before Genie saw it, and surfaces that offer to
    // delete "a workspace Genie created" must not offer to delete it.
    let createdByGenie = 1;

    switch (plan.content.kind) {
        case 'envelope': {
            const cloned = await clone({
                url: plan.content.url,
                parent_path: parentPath,
                folder: slug,
            });
            workspacePath = cloned.path;
            createdByGenie = 0;
            break;
        }
        case 'repos': {
            const built = await build({
                slug,
                name,
                parent_path: parentPath,
                repos: plan.content.repos.map((repo) => ({
                    source: repo.url,
                    is_local: repo.is_local ?? false,
                    submodule_name: submoduleName(repo),
                })),
                knowledge: [],
                remote: plan.remote,
            });
            workspacePath = built.path;
            break;
        }
        default: {
            const made = await create({
                slug,
                name,
                parent_path: parentPath,
                suffix: plan.suffix,
                remote: plan.remote,
            });
            workspacePath = made.path;
            break;
        }
    }

    const projectId = plan.link?.projectId?.trim() ?? '';
    const register = deps.register ?? defaultRegister;
    return register({
        // The linked project IS the identity. `unlinkedId` is consulted only
        // when there is no project, so the two can never disagree.
        id: projectId || plan.unlinkedId,
        backend: plan.link?.backend ?? 'tynn',
        project_id: projectId,
        project_name: plan.link?.projectName?.trim() || name,
        tynn_project_id: projectId,
        // Mirrors the project link, and stays EMPTY when there is none — the
        // display name lives in `project_name`, which is never empty.
        tynn_project_name: projectId ? plan.link?.projectName?.trim() || name : '',
        shape: 'agi',
        path: workspacePath,
        editor: null,
        editor_cmd: null,
        start_cmd: null,
        env_file: (deps.defaultEnvFile ?? defaultEnvFile)(),
        last_opened_at: null,
        created_by_genie: createdByGenie,
        gapp_dev: plan.link?.gappDev ? 1 : 0,
    });
}

/** Folder name for a repo under `repos/`, sanitised the way git needs it. */
function submoduleName(repo: AddWorkspaceRepo): string {
    const raw = repo.name?.trim() || deriveRepoName(repo.url);
    const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return cleaned || 'repo';
}

/**
 * The folder slug a name yields. Mirrors `workspaceSlug` in the renderer's
 * `workspace-onboarding` (which is the preview the form shows while typing);
 * this is the one that decides, for callers — agents, Ops provisioning — that
 * never went through a form.
 */
export function workspaceSlug(name: string): string {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9.]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '');
}
