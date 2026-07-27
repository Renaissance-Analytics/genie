import type { TerminalSpec, ViewMeta } from './genie';

/**
 * The file a view is currently bound to, across the three ways a view records
 * one: the editor's active TAB, the legacy single `file_path`, and a plugin
 * editor's `file`.
 */
function openFileOf(meta: ViewMeta | undefined): string | null {
    return meta?.active_file ?? meta?.file_path ?? meta?.file ?? null;
}

/**
 * `resetKeys` for a panel's ErrorBoundary — the values that, when they change,
 * mean "the user navigated, so give this panel another chance".
 *
 * Keying on `spec.id` ALONE (what this used to be) never changes: a panel
 * instance is deliberately kept mounted across workspace switches so its pty
 * survives, so a crashed panel showed its error card forever, in every
 * workspace, until the app was reloaded. The active workspace and the open file
 * are the two things a user changes when they're trying to get out of that
 * state, so both belong here — switching either re-renders the panel and clears
 * the card if the crash is gone with them.
 *
 * `spec.id` stays in the list so two panels never share a reset.
 */
export function panelResetKeys(
    spec: TerminalSpec,
    activeWorkspaceId?: string | null,
): ReadonlyArray<unknown> {
    return [spec.id, activeWorkspaceId ?? null, openFileOf(spec.meta)];
}
