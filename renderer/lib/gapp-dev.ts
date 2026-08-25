import { api } from './genie';

/**
 * Ask main to re-derive which workspaces are GApp Development Workspaces
 * (genie#245).
 *
 * WHY A NUDGE AND NOT A CALL OF ITS OWN: `is_gapp` reaches Genie on the project
 * row and nowhere else, so main reconciles it inside the `tynn:projects` handler
 * and broadcasts `workspaces:changed` when something moved. Fetching the project
 * list IS the sync — this just asks for it at a moment main cannot see coming,
 * and throws the answer away.
 *
 * WHEN TO CALL IT: after something changes which Tynn project a workspace points
 * at — creating a workspace, linking one, unlinking one. The master window
 * already nudges on focus, which covers "the user flipped the flag in Tynn and
 * came back", but a link made INSIDE that window never fires a focus event, so
 * the chrome would sit stale until the user switched apps and returned.
 *
 * Failure is silent by design: this is a convergence hint, never the thing that
 * makes an action succeed. The next nudge (or the next focus) picks it up.
 */
export function nudgeGappDevSync(): void {
    void api()
        .tynn.projects()
        .catch(() => {});
}
