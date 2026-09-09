import { mobileEmit } from '../mobile/bus';
import { broadcastLocal } from '../remote';

/**
 * Tell every window a workspace's lists moved — this machine's own, and any
 * REMOTE window driving this machine.
 *
 * Two audiences, exactly like `broadcastAgentsChanged` and
 * `broadcastDevServerChanged`:
 *
 *  - `broadcastLocal` fans to this client's own windows and deliberately SKIPS
 *    host-bound ones. A host window's lists belong to the HOST's database, so
 *    pushing a LOCAL change into it would overwrite what it shows with counts
 *    from a different machine.
 *  - `mobileEmit` puts the same event on `/ws/events`, which is how a remote
 *    window driving THIS host learns its lists changed. The client re-emits it
 *    onto the local `lists:changed` channel via PASSTHROUGH_EVENTS, so the
 *    remote panel and header badge refresh push-style like a local one. No-op
 *    when nothing is connected.
 *
 * It lives here rather than in `main/ipc.ts` because both callers need it: the
 * IPC handlers AND the host's `/api/desktop/lists/*` routes, whose module graph
 * must never reach `../ipc` (that drags the Electron app bootstrap into every
 * mobile unit test). Keeping it in a leaf also makes the two-audience contract
 * assertable on its own.
 */
export function broadcastListsChanged(workspaceId: string): void {
    broadcastLocal('lists:changed', { workspaceId });
    mobileEmit('lists:changed', { workspaceId });
}
