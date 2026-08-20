/**
 * PURE. Does a reinstalled GApp get its data back? (Tynn #250, owner-directed)
 *
 * The owner's rule: **uninstall PROMPTS to clear the data store and settings, and
 * reinstalling RESTORES the app's access to them.** That is plainly right — losing
 * everything because you removed an app for a fortnight is hostile — and it is in
 * direct tension with the rule shipped the night before, which wiped an app id's
 * storage on every fresh install.
 *
 * The tension is real. An app id is claimed by whoever writes the manifest, so
 * "give the data to whatever installs under this id next" is exactly how a
 * stranger's fork walks off with somebody's session.
 *
 * PROVENANCE resolves it. Data is retained for an app FROM A PARTICULAR ORIGIN.
 * Come back from the same place and it is restored; arrive from somewhere else and
 * it is wiped, because that is not the same app — it merely claims the same name.
 *
 * Anything unproven is wiped. Data left by an app installed before Genie recorded
 * provenance has nothing to vouch for it, and unmatched means unproven.
 */

import type { ForceQuestion } from '../mcp/protocol';

export interface RetainedAppData {
    /** The origin the data belonged to. Empty means Genie cannot vouch for it. */
    origin: string;
}

export interface StorageDecisionInput {
    /** True when the app is still installed — this is an UPDATE, not an arrival. */
    stillInstalled?: boolean;
    /** Data kept from a previous uninstall, if any. */
    retained: RetainedAppData | null;
    /** Where this copy is arriving from. */
    incoming: { origin: string } | null;
}

export interface StorageDecision {
    clear: boolean;
    /** Why — carried into the log, and into anything the user is shown. */
    reason: string;
}

export function decideStorageOnInstall(input: StorageDecisionInput): StorageDecision {
    if (input.stillInstalled) {
        // Wiping a user's data because they updated an app would be far worse than
        // the bug any of this guards against.
        return { clear: false, reason: 'This is an update to an app that is still installed.' };
    }

    if (!input.retained) {
        return { clear: true, reason: 'A fresh app id — nothing was kept for it.' };
    }

    const kept = input.retained.origin.trim();
    const arriving = input.incoming?.origin.trim() ?? '';
    if (!kept || !arriving) {
        return {
            clear: true,
            reason:
                'The kept data cannot be matched to where this copy came from, so it is not restored.',
        };
    }

    if (kept === arriving) {
        return { clear: false, reason: `Restoring the data kept from ${kept}.` };
    }

    return {
        clear: true,
        reason:
            `The kept data belongs to the app from ${kept}; this one is from a different place ` +
            `(${arriving}), so it does not inherit it.`,
    };
}

/**
 * What uninstall asks before it removes an app.
 *
 * Keeping LEADS, and says that reinstalling brings the data back — otherwise
 * "keep" reads as "leave junk on my disk" and everyone picks delete. Dismissing
 * the modal must never be the thing that destroys somebody's data.
 */
export function uninstallDataQuestion(appName: string): ForceQuestion {
    return {
        header: 'Its data',
        question:
            `**${appName}** is being removed. What should happen to its data and settings?\n\n` +
            'This is everything it stored in its own browser storage — signed-in sessions, ' +
            'preferences, anything it saved locally.',
        options: [
            {
                label: 'Keep it',
                description:
                    `If you reinstall ${appName} from the same place, it picks up exactly where it left off. ` +
                    'An app from anywhere else never gets it.',
            },
            {
                label: 'Delete it',
                description: 'Everything it stored is erased now. This cannot be undone.',
            },
        ],
    };
}
