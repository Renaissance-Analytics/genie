import fs from 'fs';
import { simpleGit } from 'simple-git';
import { getWorkspace, touchWorkspace, setSettings } from '../db';
import { rebuildMenu } from '../tray';
import { broadcastLocal } from '../remote';
import { workspaceActivated } from './activate';
import { detectFolder } from './detect';

/**
 * "Open" a registered workspace — FOCUS it in Genie (no external process, and no
 * editor auto-open; terminals are Genie's main surface):
 *   1. (`.agi` only) `git submodule update --init --recursive` if repos/ is
 *      empty but .gitmodules has entries.
 *   2. Make it the ACTIVE workspace — persist `active_workspace` (so a fresh /
 *      relaunching master window opens to it) AND broadcast `workspace:open`
 *      (so an already-open master focuses it live).
 *   3. Touch `last_opened_at` + rebuild the tray menu.
 *
 * The old "launch an external editor + a terminal" flow (and the `default_editor`
 * setting that drove it) was removed — Genie has its own editor + terminals. The
 * caller surfaces the master window (e.g. `showMainWindow()`); this just prepares
 * + signals the workspace to focus.
 */

// Tracks in-flight openWorkspace calls so rapid double-clicks (or HMR re-fires)
// can't stack duplicate work for the same row. Entry is removed when the call
// resolves; concurrent calls for OTHER workspaces are unaffected.
const opening = new Set<string>();

export async function openWorkspace(id: string): Promise<void> {
    if (opening.has(id)) return;
    opening.add(id);
    try {
        await openWorkspaceInner(id);
    } finally {
        opening.delete(id);
    }
}

async function openWorkspaceInner(id: string): Promise<void> {
    const row = getWorkspace(id);
    if (!row) throw new Error(`Workspace not found: ${id}`);
    if (!fs.existsSync(row.path)) {
        throw new Error(`Workspace folder missing: ${row.path}`);
    }

    if (row.shape === 'agi') {
        const det = detectFolder(row.path);
        if (det.has_gitmodules && det.repos.length === 0) {
            const git = simpleGit(row.path);
            await git.submoduleUpdate(['--init', '--recursive']);
        }
    }

    // Focus it in Genie's own UI: persist as the active workspace (covers a
    // fresh / relaunching master, which reads `active_workspace` on mount) and
    // broadcast so an already-open master activates it live. LOCAL-only: a host
    // window must NOT navigate on a local nav (workspaceId is the shared Tynn
    // project.id — it would jump every host window to that project, or blank it
    // if the host lacks it). No external editor or terminal is spawned.
    setSettings({ active_workspace: id });
    broadcastLocal('workspace:open', { workspaceId: id });

    touchWorkspace(id);
    rebuildMenu();

    // Warm the Dev Server sandbox (#234 P4). Fire-and-forget: this talks to a
    // container daemon, and the workspace must appear the instant it is clicked
    // whether or not Docker answers. It no-ops for a workspace that defines no
    // dev site or service, and it never downloads an image — see
    // `dev-server/lifecycle.ts`.
    //
    // Through the same door every OTHER activation now takes (genie#597), not a
    // direct call. Two consequences worth knowing:
    //
    //  - An open that MOVES the active workspace has ALREADY started this pass,
    //    from the `setSettings` above — the write is what announces the change
    //    now, so the hook no longer waits for the focus below. It is a handful
    //    of synchronous sqlite reads before the hook's first await, not a
    //    daemon round-trip, so the broadcast is not held up by it. This call
    //    then coalesces into that one rather than starting a second.
    //  - It is still made explicitly, because an open of the workspace you are
    //    ALREADY in changes nothing and so announces nothing — and re-warming a
    //    sandbox that had exited is exactly what a tray open is for.
    workspaceActivated(id);
}
