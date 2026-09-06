/**
 * The ADD-WORKSPACE PLAN — the contract between the flow that collects it and
 * the one path that executes it (`./add-workspace.ts`).
 *
 * A LEAF module by design: no imports, so the renderer can share the exact type
 * it sends over IPC instead of restating it. Two copies of a wire contract drift
 * the first time either side changes, and the drift shows up as a workspace that
 * lands with the wrong shape rather than as a compile error. See
 * `renderer/lib/__tests__/renderer-main-boundary.test.ts` for why the leaf-ness
 * matters (a renderer import pulls the whole module graph into the renderer's
 * compilation, `import type` or not).
 */

/** A repository the workspace should contain, as the entry point knows it. */
export interface AddWorkspaceRepo {
    /** A remote URL, or an absolute path when `is_local`. */
    url: string;
    /** Folder name under `repos/`. Derived from the URL when omitted. */
    name?: string;
    /** True when `url` is a path on this machine rather than a remote. */
    is_local?: boolean;
}

/**
 * WHAT the workspace starts with.
 *
 * `empty` is a first-class answer, not a failure to resolve one of the others:
 * a workspace with a name and an empty folder is complete. That distinction is
 * the whole of this rebuild — treating "no repositories" as a missing
 * precondition is what sent a repo-less Tynn project into a folder picker.
 */
export type AddWorkspaceContent =
    /** Nothing yet. A name and a folder, which is all a workspace needs. */
    | { kind: 'empty' }
    /** A container that already exists on a remote — brought down, not made. */
    | { kind: 'envelope'; url: string; branch?: string }
    /** Repositories the entry point already knows; the container is built. */
    | { kind: 'repos'; repos: AddWorkspaceRepo[] };

export interface AddWorkspacePlan {
    /**
     * The workspace id to use when NOTHING is linked — and only then.
     *
     * A Tynn-linked workspace is keyed by its project id (`link.projectId`),
     * because that is how every other surface finds the link. The two used to be
     * separate fields with nothing keeping them equal, which is one fact with
     * two homes: a caller that set them differently would land a row whose `id`
     * and `project_id` disagreed, and the surfaces reading each half would then
     * disagree about whether the workspace existed. `createWorkspace` resolves
     * it, once, so there is no pair to keep in sync.
     */
    unlinkedId: string;
    name: string;
    /** Folder slug; `<slug>.agi` is the folder that lands under `parentPath`. */
    slug: string;
    parentPath: string;
    content: AddWorkspaceContent;
    /** OPTIONAL, every field of it. A workspace with no link is a workspace. */
    link?: {
        projectId?: string;
        projectName?: string;
        backend?: 'tynn' | 'aionima';
        gappDev?: boolean;
    };
    /** A container repo to point `origin` at. Never required. */
    remote?: { kind: 'none' } | { kind: 'paste'; url: string };
    /**
     * `.agi` unless this is a Genie App's own `.gapp` envelope. Mirrors
     * `EnvelopeSuffix` in `./create-agi.ts`, spelled out here so this module
     * keeps no imports.
     */
    suffix?: 'agi' | 'gapp';
}
