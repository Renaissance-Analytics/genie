import { issueChannel, issueRingIds, ISSUES_LIVE } from '../core/tynn-issues.js';
import type { TynnLiveFeed } from './tynn-board-live.js';

/**
 * THE LIVE ISSUE QUEUE (genie#1295 row I1, workspace-ux 0.7.0 `issues.data.live`).
 *
 * The same follower as the board (TynnBoardLive: one socket, a catch-up ring on every (re)subscription, backoff, "off"
 * when Tynn will not sign), on the queue's own channel: `private-project-issues.{id}`, which Tynn admits exactly whoever
 * may open the Issues page and signs for the app at `POST /api/v1/projects/{id}/issues/broadcasting-auth`. The ring
 * names the issue; the tab asks what changed since its cursor.
 */
export const TYNN_ISSUES_FEED: TynnLiveFeed = {
    channel: issueChannel,
    authPath: ISSUES_LIVE.auth.path,
    events: new Set(ISSUES_LIVE.events),
    ringIds: issueRingIds,
};
