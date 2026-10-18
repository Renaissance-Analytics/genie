/**
 * THE FEEDBACK WINDOW, THE PURE HALF (Tynn #760; Genie 1's FeedbackModal, #249). What the person says goes to one of
 * THEIR Tynn projects — the ones their workspaces are linked to (project.json `tynn.projectId`), the workspace they
 * are in first — as an issue, through Tynn's `POST /api/v1/genie/feedback` with the token Genie already holds.
 */

/** What main sends the window to open it over whatever page is showing — not a page of its own. */
export const FEEDBACK_ROUTE = 'genie://feedback';

/** A place feedback can go: a workspace linked to a Tynn project. */
export interface FeedbackTarget {
    readonly workspaceId: string;
    readonly name: string;
    readonly projectId: string;
}

/** What a send did: the issue it became, in which workspace's project; or why it was not sent. */
export type FeedbackOutcome =
    | { readonly ok: true; readonly issueNumber: number | null; readonly target: string }
    | { readonly ok: false; readonly reason: string };

/** The window as the renderer draws it (FeatureData.feedback). */
export interface FeedbackView {
    readonly open: boolean;
    readonly signedIn: boolean;
    readonly targets: readonly FeedbackTarget[];
    readonly outcome: FeedbackOutcome | null;
}

/** The linked workspaces, the one the person is in first; an unlinked workspace has nowhere to send it and is not offered. */
export function feedbackTargets(
    workspaces: readonly { readonly id: string; readonly name: string }[],
    projectOf: (workspaceId: string) => string | null,
    current: string | null,
): FeedbackTarget[] {
    const linked = workspaces.flatMap((w) => {
        const projectId = projectOf(w.id);
        return projectId === null ? [] : [{ workspaceId: w.id, name: w.name, projectId }];
    });
    const here = linked.findIndex((t) => t.workspaceId === current);
    return here <= 0 ? linked : [linked[here]!, ...linked.slice(0, here), ...linked.slice(here + 1)];
}

/** The line the window shows after a send. */
export function feedbackOutcomeWords(outcome: FeedbackOutcome): string {
    if (!outcome.ok) return `Not sent: ${outcome.reason}`;
    return outcome.issueNumber === null
        ? `Sent to ${outcome.target}’s Tynn project.`
        : `Sent. It’s issue #${outcome.issueNumber} in ${outcome.target}’s Tynn project.`;
}
