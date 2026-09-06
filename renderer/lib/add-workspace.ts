import {
    tynnImportContent,
    tynnImportRoute,
    type TynnImportContent,
    type TynnImportProject,
    type TynnImportWorkspaceLink,
} from './tynn-import';
import { workspaceSlug, type AddWorkspaceSourceId } from './workspace-onboarding';
import type { BackendKind } from './genie';
import type { AddWorkspacePlan } from '../../main/workspace/add-workspace-types';

/**
 * ADD WORKSPACE — one flow, three questions, most of them already answered.
 *
 * THE RULE. **All projects in Tynn are workspaces. A Genie workspace does not
 * require Tynn.** A user or an agent must not have to create a Tynn project, or
 * a repository, or a GitHub connection, in order to add a workspace. A workspace
 * is a NAME and a FOLDER; everything else is optional, and nothing optional may
 * gate creation, hosting, listing or management.
 *
 * THE SHAPE. Every entry point answers the same three questions, just not the
 * same subset of them:
 *
 *   1. **Identity** — its name, and where it lives on disk.
 *   2. **Content** — which repositories, if any, belong in it.
 *   3. **Links** — a Tynn project, a container repo. Both optional, both
 *      derived where they can be, neither ever blocking.
 *
 * So the flow does not branch by entry point. It asks {@link addWorkspaceAsks}
 * what is still unanswered and puts exactly that on screen — which is why an
 * entry point that knows everything is a single confirm, and why fixing the
 * Tynn import took nothing but letting it answer all three.
 *
 * WHAT THIS REPLACES. Five routes, each with its own idea of what a workspace
 * needed, and a conversion wizard as the fallback destination for four of them.
 * Conversion is not a route: it is one thing you might want to do to a folder
 * you already have, offered inside Content, and never the price of admission.
 */

export type AddWorkspaceEntry =
    /** Make one. Nothing exists yet, so there is nothing to read. */
    | { source: 'new' }
    /** The same, plus the scaffolding a Genie App is built with. */
    | { source: 'gapp'; project?: TynnImportProject }
    /** Adopt a folder on this machine. It is READ before anything is written. */
    | { source: 'local'; folder?: string }
    /** Adopt a repository. Cloned, then read. */
    | { source: 'git'; url?: string }
    /** A project in Tynn, which IS a workspace — whatever it contains. */
    | { source: 'tynn'; project: TynnImportProject };

/**
 * What the workspace starts with. `inspect` is the one that is not an answer
 * but a step: a folder or repository has to be READ before anyone knows what is
 * in it, and that reading is Content's job rather than a route of its own.
 */
export type AddWorkspaceContent =
    | TynnImportContent
    | { kind: 'inspect'; mode: 'local' | 'remote'; sourceUrl: string };

/** The three questions, named — and only the unanswered ones are asked. */
export type AddWorkspaceAsk = 'name' | 'location' | 'content';

export interface AddWorkspaceLinks {
    /** A Tynn project. OPTIONAL — its absence changes nothing. */
    tynnProjectId: string;
    tynnProjectName: string;
    backend: BackendKind | null;
    /** This workspace is where a Genie App is developed. */
    gappDev: boolean;
}

export interface AddWorkspaceDraft {
    source: AddWorkspaceSourceId;
    name: string;
    parentPath: string;
    content: AddWorkspaceContent;
    links: AddWorkspaceLinks;
    /** What the entry point has NOT answered. Empty means: one confirm. */
    asks: AddWorkspaceAsk[];
    /**
     * The workspace already here for this Tynn project. Set only when importing
     * one that has been imported before — the offer is to open it, not to clone
     * a second copy.
     */
    existingWorkspaceId: string | null;
}

export interface AddWorkspaceContext {
    /**
     * Settings' `primary_workspace` — "the default destination for NEW projects
     * created from Genie". A DEFAULT, not a constraint: the user can always
     * point somewhere else, and every entry point starts from it so that "where
     * should this go?" is a question the machine has usually already answered.
     */
    primaryWorkspace?: string;
    /** Registered workspaces, for spotting a Tynn project already imported. */
    workspaces?: readonly TynnImportWorkspaceLink[];
}

/**
 * What this entry point already knows, and what is left to ask.
 *
 * Nothing here reads the disk or the network: it is the pure statement of which
 * of the three questions each entry point pre-answers, so the answer can be
 * asserted without a window.
 */
export function addWorkspaceDraft(
    entry: AddWorkspaceEntry,
    ctx: AddWorkspaceContext = {},
): AddWorkspaceDraft {
    const parentPath = ctx.primaryWorkspace?.trim() ?? '';
    const blank: AddWorkspaceLinks = {
        tynnProjectId: '',
        tynnProjectName: '',
        backend: null,
        gappDev: false,
    };

    const draft = ((): Omit<AddWorkspaceDraft, 'asks'> => {
        switch (entry.source) {
            case 'tynn': {
                const route = tynnImportRoute(entry.project, ctx.workspaces ?? []);
                return {
                    source: 'tynn',
                    // Tynn named the project, so the workspace has a name. This
                    // is the whole of what the import used to be missing.
                    name: entry.project.name?.trim() ?? '',
                    parentPath,
                    content: tynnImportContent(entry.project),
                    links: {
                        ...blank,
                        tynnProjectId: entry.project.id,
                        tynnProjectName: entry.project.name?.trim() ?? '',
                        backend: entry.project.backend ?? null,
                    },
                    existingWorkspaceId:
                        route.stage === 'tynn-open-existing' ? route.workspaceId : null,
                };
            }
            case 'gapp':
                return {
                    source: 'gapp',
                    name: entry.project?.name?.trim() ?? '',
                    parentPath,
                    content: { kind: 'empty', reason: 'no-repositories' },
                    links: {
                        ...blank,
                        tynnProjectId: entry.project?.id ?? '',
                        tynnProjectName: entry.project?.name?.trim() ?? '',
                        backend: entry.project?.backend ?? null,
                        gappDev: true,
                    },
                    existingWorkspaceId: null,
                };
            case 'local':
                return {
                    source: 'local',
                    name: '',
                    parentPath,
                    content: { kind: 'inspect', mode: 'local', sourceUrl: entry.folder ?? '' },
                    links: blank,
                    existingWorkspaceId: null,
                };
            case 'git':
                return {
                    source: 'git',
                    name: '',
                    parentPath,
                    content: { kind: 'inspect', mode: 'remote', sourceUrl: entry.url ?? '' },
                    links: blank,
                    existingWorkspaceId: null,
                };
            default:
                return {
                    source: 'new',
                    name: '',
                    parentPath,
                    content: { kind: 'empty', reason: 'no-repositories' },
                    links: blank,
                    existingWorkspaceId: null,
                };
        }
    })();

    return { ...draft, asks: addWorkspaceAsks(draft) };
}

/**
 * The unanswered questions, in the order they are asked.
 *
 * A folder or repository being inspected answers `name` on the way through, so
 * it is not asked for twice — which is why `content` alone is listed for those
 * two entry points.
 */
export function addWorkspaceAsks(draft: Omit<AddWorkspaceDraft, 'asks'>): AddWorkspaceAsk[] {
    const asks: AddWorkspaceAsk[] = [];
    if (draft.content.kind === 'inspect') {
        asks.push('content');
        return asks;
    }
    if (!draft.name.trim()) asks.push('name');
    if (!draft.parentPath.trim()) asks.push('location');
    return asks;
}

/**
 * The plan handed to main — the SAME type main executes, imported rather than
 * restated so the two halves of the contract cannot drift apart.
 */
export type AddWorkspacePlanInput = AddWorkspacePlan;

/**
 * Turn a completed draft into the plan main executes.
 *
 * THE ID is NOT resolved here. A Tynn-linked workspace is keyed by its project
 * id — that is how every other surface finds the link — and `createWorkspace`
 * is the one place that decides it. Resolving it here as well would put one
 * fact in two homes, which is the shape of bug this whole rebuild is about.
 */
export function addWorkspacePlan(
    draft: Omit<AddWorkspaceDraft, 'asks'> & { asks?: AddWorkspaceAsk[] },
    opts: {
        /** Used when no Tynn project supplies one. */
        id: string;
        /** A container repo to point `origin` at. Never required. */
        remote?: { kind: 'none' } | { kind: 'paste'; url: string };
    },
): AddWorkspacePlanInput {
    const name = draft.name.trim();
    if (!name) throw new Error('Give the workspace a name.');
    const parentPath = draft.parentPath.trim();
    if (!parentPath) throw new Error('Choose where the workspace should live.');
    if (draft.content.kind === 'inspect') {
        throw new Error(
            'This folder has not been inspected yet, so there is no plan for what is in it.',
        );
    }

    const slug = workspaceSlug(name);
    if (!slug) throw new Error('Give the workspace a name it can be a folder for.');

    return {
        unlinkedId: opts.id,
        name,
        slug,
        parentPath,
        content:
            draft.content.kind === 'envelope'
                ? { kind: 'envelope', url: draft.content.url, branch: draft.content.branch }
                : draft.content.kind === 'repos'
                    ? {
                          kind: 'repos',
                          repos: draft.content.repos.map((repo) => ({
                              url: repo.url,
                              name: repo.name,
                          })),
                      }
                    : { kind: 'empty' },
        link: {
            projectId: draft.links.tynnProjectId,
            projectName: draft.links.tynnProjectName || name,
            backend: draft.links.backend ?? undefined,
            gappDev: draft.links.gappDev,
        },
        remote: opts.remote,
    };
}

/** What the confirm screen says will happen, in the user's words. */
export function describeContent(content: AddWorkspaceContent): string {
    switch (content.kind) {
        case 'envelope':
            return `Clones ${content.url} and everything in it.`;
        case 'repos':
            return content.repos.length === 1
                ? `Brings in ${content.repos[0].name}.`
                : `Brings in ${content.repos.length} repositories: ${content.repos
                      .map((repo) => repo.name)
                      .join(', ')}.`;
        case 'inspect':
            return 'Genie reads what is there and shows you the plan before writing anything.';
        default:
            return content.reason === 'container-undeclared'
                ? 'Tynn marks this as a workspace but does not say which repository holds it, so Genie makes a new one. Repositories can be added at any time.'
                : 'An empty workspace. Repositories can be added at any time.';
    }
}
