import { readProjectJson } from '../workspace/project-json';

/**
 * A display SLUG for a workspace, used to label whisper channels (`slug:purpose`)
 * and agent rows. Resolution order (all synchronous — no backend round-trip):
 *
 *   1. The Tynn project slug when the envelope is Tynn-linked — `project.json`'s
 *      `tynn.project` (written on link, the same slug Tynn shows).
 *   2. Otherwise the kebab of the workspace's project name (the envelope slug
 *      shape — matches how the backend derives a slug from a name).
 *
 * Two workspaces can share a slug (the broker keys channels by workspace id, not
 * slug, so this is display-only).
 */
export function workspaceSlug(ws: { project_name: string; path: string }): string {
    try {
        const tynn = readProjectJson(ws.path)?.tynn;
        const linked = tynn?.project?.trim();
        if (linked) return kebab(linked);
    } catch {
        /* no/broken project.json — fall back to the name */
    }
    return kebab(ws.project_name);
}

/** Kebab-case a name the way the backend derives an envelope/project slug. */
export function kebab(name: string): string {
    return (
        String(name ?? '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'workspace'
    );
}
