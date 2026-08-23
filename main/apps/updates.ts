/**
 * PURE. Is there a newer version of an installed GApp — and may it be applied?
 * (Tynn #250)
 *
 * A GitHub install pins a commit, deliberately — "main" is whatever happens to be
 * there later, and what was reviewed was one commit. The cost of pinning is that an
 * app can sit for months on a version whose author fixed a bug the same week, and
 * nothing ever says so. {@link appUpdateState} answers whether that has happened.
 *
 * ## Applying one — the owner's requirement, and the model already built
 *
 * The owner: "GApps do have integrity checking and should be able to detect and
 * install updates without Genie receiving any updates. GApps will have their own
 * development lifecycle." The security model says the opposite-looking thing: an
 * update goes back through review and consent, because a new version can ask for
 * more than the user granted. Anything that quietly pulled a new commit would be
 * an escalation path with a friendly name.
 *
 * Both hold, because {@link decideAppUpdate} decides FROM THE MANIFEST which of
 * the two an arriving version is. The decision is re-run inside the installer
 * rather than passed to it: a "skip consent" flag would be exactly the friendly
 * name warned about above, while a decision made from data cannot be asserted by
 * a caller that is wrong.
 *
 * ## Why the quiet path is safe
 *
 * A quiet update NEVER changes the grant. The app keeps precisely the capabilities
 * and the reach the user already agreed to, so its authority cannot grow by
 * updating, whatever its new manifest declares. Consent is therefore not a lock on
 * the code changing — the code changes with every commit either way. It is how the
 * user is shown something NEW being asked of them.
 *
 * Integrity is what makes that safety mean anything on the wire: a git sha is a
 * hash of the whole tree, so verifying that what arrived is the commit Genie
 * resolved is content integrity against the recorded version. Publisher SIGNING is
 * a further step and waits on a store that does not exist yet; this does not.
 */

import type { AppGrantSource } from '../db';
import type { AppManifest, AppScope } from './manifest';

export type AppUpdateState =
    /** Pinned to what the repo has. */
    | 'current'
    /** The repo has moved on; the user can review the new version. */
    | 'update-available'
    /** Nothing to compare against — no upstream, or Genie could not reach it. */
    | 'unknown'
    /** Not from a repo at all, so there is no such question. */
    | 'not-tracked';

/**
 * Two commit ids for the same commit.
 *
 * `git ls-remote` returns the full sha; what was recorded may be either form, and a
 * length mismatch must never read as "a new version is available".
 */
function sameCommit(a: string, b: string): boolean {
    const [x, y] = [a.trim().toLowerCase(), b.trim().toLowerCase()];
    if (!x || !y) return false;
    const shortest = Math.min(x.length, y.length);
    return x.slice(0, shortest) === y.slice(0, shortest);
}

export function appUpdateState(
    source: AppGrantSource | null | undefined,
    remoteHead: string | null | undefined,
): AppUpdateState {
    // A local folder has no upstream, and calling one "up to date" would be a
    // claim Genie cannot make.
    if (!source || source.kind !== 'github') return 'not-tracked';
    // Unknown, NOT current. A network failure that read as "up to date" would be
    // Genie quietly promising something it never checked.
    if (!source.commit || !remoteHead) return 'unknown';
    return sameCommit(source.commit, remoteHead) ? 'current' : 'update-available';
}

export interface UpdatableApp {
    id: string;
    origin: string;
    commit: string;
}

/**
 * The apps worth asking GitHub about, and where to ask.
 *
 * Callers should resolve each distinct ORIGIN once: a monorepo can hold several
 * apps, and hitting the same remote once per app is a rate limit waiting to happen.
 */
export function updatableApps(
    apps: ReadonlyArray<{ id: string; source: AppGrantSource | null | undefined }>,
): UpdatableApp[] {
    return apps.flatMap((app) =>
        app.source?.kind === 'github' && app.source.commit
            ? [{ id: app.id, origin: app.source.origin, commit: app.source.commit }]
            : [],
    );
}


/* -------------------------------------------------------------------------- */
/* Applying one                                                               */
/* -------------------------------------------------------------------------- */

/** The installed copy, and what the user actually agreed to. */
export interface InstalledAppVersion {
    id: string;
    source: AppGrantSource | null;
    /**
     * What the user GRANTED — never what the old manifest asked for. This is the
     * authority a quiet update carries forward unchanged.
     */
    capabilities: string[];
    scope: AppScope;
    workspaces: string[];
    /**
     * The manifest recorded at install: the declaration the user was SHOWN.
     *
     * Kept alongside the grant because the two answer different questions. The
     * grant says what the app may do; this says what it has already been seen
     * asking for, and consent exists to show the user something new.
     */
    declared: AppManifest;
    /** Runs from a folder the developer controls, not a copy Genie made. */
    devMode: boolean;
    /**
     * The user has turned this app's permissions off without removing it.
     *
     * Carried so an update cannot switch them back on. Otherwise revocation would
     * last exactly until the app's next commit — which is not a revocation, it is
     * a pause.
     */
    revoked: boolean;
}

/** The version that has just been fetched. */
export interface ArrivingVersion {
    origin: string;
    /** The commit Genie resolved and told the user about BEFORE fetching. */
    announcedCommit: string;
    /** The commit that actually landed on disk. */
    commit: string;
    manifest: AppManifest;
}

export type AppUpdateDecision =
    /** Apply it in place, carrying the existing grant. No modal. */
    | { kind: 'quiet' }
    /** It asks for something new: the full review and the consent modal. */
    | { kind: 'consent'; reasons: string[] }
    /** Genie will not apply this at all, and says why. */
    | { kind: 'blocked'; reasons: string[] };

/** self < workspaces < workstation. */
const SCOPE_RANK: Record<AppScope, number> = { self: 0, workspaces: 1, workstation: 2 };

/**
 * Everything the user has already been SHOWN being asked for.
 *
 * The union of what they granted and what the installed manifest declared. A
 * capability in the old declaration was on the consent screen at install — the
 * user read it and chose not to tick it, which is an answer, not an absence.
 *
 * Re-asking every update for something already declined would make such an app
 * permanently un-updatable and would train its user to click through the one
 * screen that matters. It stays safe because the grant is carried forward
 * UNCHANGED: what was declined is still not granted, and the app gains nothing by
 * asking again.
 */
function alreadySeen(installed: InstalledAppVersion): {
    capabilities: Set<string>;
    scope: AppScope;
    workspaces: Set<string>;
    browserExposed: boolean;
} {
    const previous = installed.declared;
    const scope =
        SCOPE_RANK[previous.permissions.scope] > SCOPE_RANK[installed.scope]
            ? previous.permissions.scope
            : installed.scope;
    return {
        capabilities: new Set([...installed.capabilities, ...previous.permissions.capabilities]),
        scope,
        workspaces: new Set([...installed.workspaces, ...(previous.permissions.workspaces ?? [])]),
        browserExposed: previous.frontend.browserExposed === true,
    };
}

/**
 * May this arriving version be applied without asking again?
 *
 * Fail-closed at every branch: unverifiable blocks, unrecognised blocks, and
 * anything that cannot be shown to ask for nothing new goes back through consent
 * rather than through.
 */
export function decideAppUpdate(
    installed: InstalledAppVersion,
    arriving: ArrivingVersion,
): AppUpdateDecision {
    // --- Things Genie will not do at all -------------------------------------
    if (installed.devMode) {
        // A dev-mode app's workspace IS the folder being edited. Overwriting it
        // would destroy uncommitted work, and the developer already has git.
        return {
            kind: 'blocked',
            reasons: [
                'This app runs from a folder you control, in dev mode. Update it there — ' +
                    'Genie will not overwrite a working directory.',
            ],
        };
    }

    const source = installed.source;
    if (!source || source.kind !== 'github' || !source.commit) {
        // No upstream, or nothing pinned: there is no recorded version to verify
        // what arrived against, so the quiet path has nothing to stand on.
        return {
            kind: 'blocked',
            reasons: [
                'Genie has no recorded version for this app to check an update against. ' +
                    'Install it again from its repository to track updates.',
            ],
        };
    }

    // --- Integrity: is this the version Genie announced? ---------------------
    // The gap being closed is a ref moving between the check and the fetch — the
    // user is shown one commit and a different one lands.
    if (!arriving.commit.trim() || !arriving.announcedCommit.trim()) {
        return {
            kind: 'blocked',
            reasons: ['Genie could not identify the version that arrived, so it was not applied.'],
        };
    }
    if (!sameCommit(arriving.commit, arriving.announcedCommit)) {
        return {
            kind: 'blocked',
            reasons: [
                `The version that arrived (${arriving.commit.slice(0, 7)}) is not the one Genie ` +
                    `checked (${arriving.announcedCommit.slice(0, 7)}). Nothing was applied.`,
            ],
        };
    }
    if (arriving.manifest.id !== installed.id) {
        // Not a newer version of this app; a different app wearing its repo.
        return {
            kind: 'blocked',
            reasons: [
                `That version declares itself as ${arriving.manifest.id}, not ${installed.id}. ` +
                    'It is not an update to this app.',
            ],
        };
    }

    // --- Does it ask for anything the user has not seen? ---------------------
    const reasons: string[] = [];
    const seen = alreadySeen(installed);

    if (arriving.origin !== source.origin) {
        // An app id is claimed by whoever writes the manifest, so a fork stepping
        // into the shoes of an app the user installed on purpose is a takeover.
        // It is the loudest thing on the install screen, and an update must not
        // be a way around it.
        reasons.push(
            `It comes from ${arriving.origin}, and the installed copy came from ${source.origin}.`,
        );
    }

    const asking = arriving.manifest.permissions;
    const newCapabilities = asking.capabilities.filter((c) => !seen.capabilities.has(c));
    if (newCapabilities.length > 0) {
        reasons.push(`It asks for permissions you have not seen: ${newCapabilities.join(', ')}.`);
    }

    if (SCOPE_RANK[asking.scope] > SCOPE_RANK[seen.scope]) {
        reasons.push(`It asks to reach further than before: ${asking.scope}.`);
    }
    const newWorkspaces = (asking.workspaces ?? []).filter((w) => !seen.workspaces.has(w));
    if (newWorkspaces.length > 0) {
        reasons.push(`It asks for workspaces it did not before: ${newWorkspaces.join(', ')}.`);
    }

    if (arriving.manifest.frontend.browserExposed === true && !seen.browserExposed) {
        // A certificate and a hosts-file edit — a one-time admin prompt the user
        // agreed to once, or not at all.
        reasons.push(
            'It asks to be reachable from your real browser, which installs a certificate ' +
                'and edits your hosts file.',
        );
    }

    return reasons.length > 0 ? { kind: 'consent', reasons } : { kind: 'quiet' };
}
