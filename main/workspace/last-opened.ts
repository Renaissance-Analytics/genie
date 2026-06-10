import { listWorkspaces, getAllSettings } from '../db';

/**
 * Used by the capture popup to pre-select a project. Order of preference:
 *   1. Most-recently-opened workspace.
 *   2. Workspace at the primary path.
 *   3. First workspace.
 *   4. Nothing — picker asks the user.
 */
export function getLastOpenedProject(): {
    id: string;
    name: string;
    backend: 'tynn' | 'aionima';
} | null {
    const all = listWorkspaces();
    if (all.length === 0) return null;

    const recent = all.find((w) => w.last_opened_at);
    if (recent) {
        return {
            id: recent.project_id ?? recent.tynn_project_id,
            name: recent.project_name ?? recent.tynn_project_name,
            backend: (recent.backend ?? 'tynn') as 'tynn' | 'aionima',
        };
    }

    const settings = getAllSettings();
    if (settings.primary_workspace) {
        const match = all.find((w) => w.path === settings.primary_workspace);
        if (match) {
            return {
                id: match.project_id ?? match.tynn_project_id,
                name: match.project_name ?? match.tynn_project_name,
                backend: (match.backend ?? 'tynn') as 'tynn' | 'aionima',
            };
        }
    }

    const first = all[0];
    return {
        id: first.project_id ?? first.tynn_project_id,
        name: first.project_name ?? first.tynn_project_name,
        backend: (first.backend ?? 'tynn') as 'tynn' | 'aionima',
    };
}
