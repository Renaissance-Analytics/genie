import { api } from './genie';

/**
 * The shortest gap between two nudges.
 *
 * Deliberately small. Its only job is to collapse a BURST — window focus fires on
 * every alt-tab, in every window, and Stage windows load the same master page, so
 * an ungated handler turns drumming alt-tab into drumming Tynn. It is emphatically
 * not a poll interval: anything long enough to swallow a real "flip the flag in
 * Tynn, switch straight back" round trip would re-create the bug this feature
 * exists to fix.
 */
export const NUDGE_MIN_GAP_MS = 3_000;

/**
 * PURE. May a nudge go out now, given when the last one did?
 *
 * Fails OPEN when the clock moves backwards (a correction, a resume from sleep):
 * one extra request is a cheaper mistake than a sync that stays locked until the
 * clock catches up.
 */
export function shouldNudgeGappDevSync(
    now: number,
    last: number | null,
    minGapMs: number = NUDGE_MIN_GAP_MS,
): boolean {
    if (last === null) return true;
    if (now < last) return true;
    return now - last >= minGapMs;
}

let lastNudge: number | null = null;

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
 * WHEN TO CALL IT: right after something changed which Tynn project a workspace
 * points at — creating a workspace, linking one, unlinking one. Those are
 * deliberate, one-at-a-time acts, so this one is NOT rate-limited: the user just
 * did the thing, and the chrome has to agree with them immediately.
 * {@link nudgeGappDevSyncOnFocus} is the throttled sibling for the ambient case.
 *
 * Failure is silent by design: this is a convergence hint, never the thing that
 * makes an action succeed. The next nudge (or the next focus) picks it up.
 */
export function nudgeGappDevSync(): void {
    lastNudge = Date.now();
    void api()
        .tynn.projects()
        .catch(() => {});
}

/**
 * The same nudge, rate-limited — for window focus.
 *
 * Focus is the ambient case: it covers "the user flipped the flag in Tynn and
 * came back", but it fires on every alt-tab, in every window, and Stage windows
 * load the same master page. {@link NUDGE_MIN_GAP_MS} collapses that burst
 * without being long enough to swallow the round trip it exists to catch.
 */
export function nudgeGappDevSyncOnFocus(): void {
    if (!shouldNudgeGappDevSync(Date.now(), lastNudge)) return;
    nudgeGappDevSync();
}
