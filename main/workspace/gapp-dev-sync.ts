import { listWorkspaces, setWorkspaceGappDev } from '../db';
import { resolveTynnLinkForRow } from './tynn-link';
import { planGappDevSync, type GappDevProject, type GappDevWorkspace } from './gapp-dev';

/**
 * Mirror Tynn's `is_gapp` onto every linked workspace (genie#245).
 *
 * The impure half of `gapp-dev.ts`: read the rows, resolve each one's Tynn link,
 * apply the plan. The decisions live next door and are tested without any of
 * this; what is worth reading here is WHEN it runs.
 *
 * It runs on the existing project fetch — `tynn:projects`, the one IPC handler
 * every surface that needs project data already goes through — rather than on a
 * timer of its own. That was deliberate: `is_gapp` changes about as often as a
 * project is created, a poll would spend a request a minute to learn nothing,
 * and this codebase already prefers push and on-demand reads to polling.
 */
export function syncGappDevWorkspaces(projects: readonly GappDevProject[]): number {
    const rows = listWorkspaces();
    const reduced: GappDevWorkspace[] = rows.map((row) => ({
        id: row.id,
        gapp_dev: row.gapp_dev,
        // `resolveTynnLinkForRow` honours project.json over the durable row —
        // including the empty `tynn: {}` an explicit unlink writes — and returns
        // null for a workspace whose backend is not Tynn. That last part is what
        // keeps installed-app workspaces out: they are `backend: 'aionima'` and
        // their `tynn_project_id` holds a MANIFEST id, not a Tynn ULID.
        tynnProjectId: resolveTynnLinkForRow(row)?.projectId ?? null,
    }));

    const changes = planGappDevSync(reduced, projects);
    for (const c of changes) setWorkspaceGappDev(c.id, c.next);
    return changes.length;
}
