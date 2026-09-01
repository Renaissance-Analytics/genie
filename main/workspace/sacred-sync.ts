import { listWorkspaces, setWorkspaceSacredName } from '../db';
import { resolveTynnLinkForRow } from './tynn-link';
import { planSacredSync, type SacredProject, type SacredWorkspace } from './sacred';

/**
 * Mirror Tynn's sacred marking onto every linked workspace (Tynn story #262).
 *
 * The impure half of `sacred.ts`: read the rows, resolve each one's Tynn link,
 * apply the plan. The decisions live next door and are tested without any of
 * this; what is worth reading here is WHEN it runs.
 *
 * It runs on the existing project fetch — `tynn:projects`, the handler every
 * surface that needs project data already goes through — rather than on a timer
 * of its own, exactly as `syncGappDevWorkspaces` does. A sacred marking changes
 * about as often as a project is created, a poll would spend a request a minute
 * to learn nothing, and this codebase prefers push and on-demand reads.
 */
export function syncSacredWorkspaces(projects: readonly SacredProject[]): number {
    const rows = listWorkspaces();
    const reduced: SacredWorkspace[] = rows.map((row) => ({
        id: row.id,
        sacred_name: row.sacred_name ?? null,
        // `resolveTynnLinkForRow` honours project.json over the durable row --
        // including the empty `tynn: {}` an explicit unlink writes -- and returns
        // null for a workspace whose backend is not Tynn, which keeps
        // installed-app workspaces out: they are `backend: 'aionima'` and their
        // `tynn_project_id` holds a MANIFEST id, not a Tynn ULID.
        tynnProjectId: resolveTynnLinkForRow(row)?.projectId ?? null,
    }));

    const changes = planSacredSync(reduced, projects);
    for (const c of changes) setWorkspaceSacredName(c.id, c.next);
    return changes.length;
}
