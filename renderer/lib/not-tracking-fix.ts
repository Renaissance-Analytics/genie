/**
 * The way OUT of "Tynn isn't tracking this workspace yet".
 *
 * The message used to be advice and nothing else — *check that it's linked to a
 * Tynn project and that the project has repositories registered* — while Genie
 * already held both answers. It asked the owner to verify facts it was holding,
 * offered no button for either, and on a workspace that IS linked with repos
 * ticked it named two causes that were both false.
 *
 * A state a user can reach and cannot act on is a bug. This picks the cause that
 * actually applies from what Genie knows, and every branch returns something to
 * click.
 *
 * PURE.
 */

export type NotTrackingAction =
    | 'reconnect-github'
    | 'open-workspace-settings'
    | 'focus-repos'
    | 'force-refresh';

export interface NotTrackingFix {
    cause: 'github-disconnected' | 'unlinked' | 'no-repos' | 'server-has-not-polled';
    /** What is actually true, stated rather than guessed at. */
    message: string;
    action: NotTrackingAction;
    actionLabel: string;
}

export function notTrackingFix({
    linked,
    enabledRepoCount,
    needsReauth,
}: {
    linked: boolean;
    enabledRepoCount: number;
    needsReauth: boolean;
}): NotTrackingFix {
    // FIRST, because nothing downstream can succeed without it. Offering a
    // refresh here would send the owner round a loop that cannot work.
    if (needsReauth) {
        return {
            cause: 'github-disconnected',
            message:
                'Your GitHub session has expired, so nothing can be read for this workspace.',
            action: 'reconnect-github',
            actionLabel: 'Reconnect GitHub',
        };
    }
    if (!linked) {
        return {
            cause: 'unlinked',
            message:
                'This workspace is not linked to a Tynn project yet, and IssueWatch is tracked per project.',
            action: 'open-workspace-settings',
            actionLabel: 'Open workspace settings',
        };
    }
    if (enabledRepoCount === 0) {
        return {
            cause: 'no-repos',
            message:
                'This workspace is linked, but no repositories are being watched yet — tick the ones you want.',
            action: 'focus-repos',
            actionLabel: 'Choose repositories',
        };
    }
    // Linked, repos ticked, and Tynn still has nothing. The old copy could not
    // describe this at all, and its advice was actively wrong here.
    return {
        cause: 'server-has-not-polled',
        message:
            `This workspace is linked and ${enabledRepoCount} ${
                enabledRepoCount === 1 ? 'repository is' : 'repositories are'
            } being watched, but Tynn has not sent a snapshot yet. It polls on its own schedule — you can ask it to read GitHub now.`,
        action: 'force-refresh',
        actionLabel: 'Refresh now',
    };
}
