import { featureRingIds, featuresChannel, FEATURES_LIVE } from '../core/tynn-features.js';
import type { TynnLiveFeed } from './tynn-board-live.js';

/**
 * THE LIVE FEATURES PAGE (genie#1295 row F1, workspace-ux 0.10.0 `features.data.live`).
 *
 * The same follower as the board and the Issues queue (TynnBoardLive: one socket, a catch-up ring on every
 * (re)subscription, backoff, "off" when Tynn will not sign), on the page's own channel: `private-project-features.{id}`,
 * which Tynn admits exactly whoever may open the Features page and signs for the app at
 * `POST /api/v1/projects/{id}/features/broadcasting-auth`. A ring is a doorbell: the tab reads the page again.
 */
export const TYNN_FEATURES_FEED: TynnLiveFeed = {
    channel: featuresChannel,
    authPath: FEATURES_LIVE.auth.path,
    events: new Set(FEATURES_LIVE.events),
    ringIds: featureRingIds,
};
