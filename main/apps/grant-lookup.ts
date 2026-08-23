/**
 * WHO a GApp is, wherever the answer lives (Tynn #250).
 *
 * Two places in Genie need an app's grant, and until previews existed they each
 * read the row and converted it themselves, side by side: the bridge that answers
 * `me()` and gates `call()`, and the MCP caller resolver that decides which
 * workspace an allowed call lands in.
 *
 * Two copies of "who is this app?" is exactly the shape that breaks when a third
 * kind of app turns up — and a PREVIEW is a third kind: a real app, with a real
 * grant, that is not installed and has no row. Wiring it into one of the two would
 * have left the other failing closed for reasons no one could see from either
 * file: `me()` answering while `call()` refused, or the reverse.
 *
 * So it is one function, the decision it makes is pure and tested in
 * `preview-registry.ts`, and this is the binding that hands it Genie's two real
 * sources.
 */

import { getAppGrant } from '../db';
import { livePreview, resolveAppGrant } from './preview-registry';
import type { AppGrant } from './bridge-decision';

/** The installed app's grant row, as the decision layer wants to see it. */
function installedGrant(appId: string): AppGrant | null {
    const row = getAppGrant(appId);
    if (!row) return null;
    return {
        appId: row.appId,
        appName: row.name,
        workspaceId: row.workspaceId,
        scope: row.scope,
        workspaces: row.workspaces,
        capabilities: row.capabilities,
        revoked: row.revoked,
    };
}

/**
 * The grant this app id acts under — a live preview's, or an installed app's.
 *
 * Null means no authority at all, which every caller already treats as a refusal.
 */
export function appGrantFor(appId: string): AppGrant | null {
    return resolveAppGrant(appId, { preview: livePreview, installed: installedGrant });
}
