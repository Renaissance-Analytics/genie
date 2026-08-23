/**
 * Installing a GApp (Tynn #250).
 *
 * The sequence matters more than any single step. An install creates a workspace,
 * copies third-party code onto the machine, writes hosting config and records an
 * authority grant — so the ORDER, and what survives a refusal or a failure
 * halfway through, is the feature:
 *
 *   1. Validate. A bad manifest is rejected before anything is asked of anyone —
 *      consenting to an app that cannot install wastes the user's attention, and
 *      the errors belong to the developer anyway.
 *   2. Resolve what the machine can provide, so the prompt can be honest about
 *      what the user will have to install themselves.
 *   3. ASK. Dismissal or refusal creates nothing at all.
 *   4. Create (or reuse) the workspace, copy the source, write the site, record
 *      the grant — with what the user TICKED, never what the manifest asked for.
 *
 * The I/O is injected. Partly for testability, but mostly because the assertions
 * that matter are about calls that must NOT happen — no workspace on a refusal, no
 * grant on a failure — and those are only assertable if the calls are visible.
 */

import { appInstallPlan, type AppProcessPlan } from './install-plan';
import {
    decideAppUpdate,
    type ArrivingVersion,
    type InstalledAppVersion,
} from './updates';
import { buildConsentPlan, readConsent } from './consent-plan';
import { decideStorageOnInstall } from './data-retention';
import { validateAppManifest, APP_MANIFEST_FILENAME, type AppManifest } from './manifest';
import {
    resolveAppRequirements,
    type RequirementMachine,
    type ResolvedRequirement,
} from './requirements';
import type { DevSites } from '../dev-server/sites-config';
import type { AppScope } from './manifest';
import type { ForceAnswer, ForceQuestion } from '../mcp/protocol';

/**
 * WHERE an installed app came from.
 *
 * Recorded, because provenance has to outlive the review. The GitHub review is a
 * screen that closes; "what is this thing on my machine and who gave it to me?" is
 * a question asked weeks later, and an app that cannot answer it is an app nobody
 * can audit.
 */
export type AppSource =
    | { kind: 'folder'; origin: string }
    | { kind: 'github'; origin: string; commit?: string };

export interface AppGrantInput {
    appId: string;
    workspaceId: string;
    name: string;
    version: string;
    slug: string;
    scope: AppScope;
    workspaces: string[];
    capabilities: string[];
    manifestJson: string;
    installPath: string;
    source: AppSource;
    revoked: boolean;
    /**
     * Running from a folder Genie does not control, with dev tools on.
     *
     * Stored rather than inferred: both the window and the Apps panel have to say
     * so, and a flag is harder to lose than a heuristic about paths.
     */
    devMode: boolean;
}

export interface AppInstallIO {
    /** The raw `genie-app.json`, or null when the folder has none. */
    readManifest: (folder: string) => string | null;
    /**
     * The machine's facts for the tools this app names. A resolver rather than a
     * value: only the required tools are probed, and probing is I/O.
     */
    machine: (required: readonly string[]) => Promise<RequirementMachine>;
    ask: (
        questions: ForceQuestion[],
    ) => Promise<{ cancelled: boolean; answers: ForceAnswer[] }>;
    /** The workspace an already-installed copy of this app lives in, and where it came from. */
    existingApp: (
        appId: string,
    ) => { workspaceId: string; path: string; source?: AppSource } | null;
    createWorkspace: (
        manifest: AppManifest,
    ) => Promise<{ workspaceId: string; path: string }>;
    /**
     * DEV MODE: register the developer's OWN folder as the app's workspace.
     *
     * No new workspace, no copy — the app runs from the folder being edited, which
     * is the only way an edit is visible without reinstalling.
     */
    adoptFolder: (
        folder: string,
        manifest: AppManifest,
    ) => Promise<{ workspaceId: string; path: string }>;
    /** Copy the app's source into its workspace. */
    copyAppSource: (sourceFolder: string, workspacePath: string, manifest: AppManifest) => void;
    /**
     * Wipe everything stored under this app id's browser partition.
     *
     * The partition is keyed by APP ID, and an app id is claimed by whoever wrote
     * the manifest. Uninstalling one app and installing a DIFFERENT one that
     * claims the same id would otherwise hand the newcomer the old app's cookies,
     * tokens and localStorage.
     *
     * Optional so a caller with no browser session (a headless probe, a test that
     * is not about this) is not forced to fake one.
     */
    clearAppStorage?: (appId: string) => Promise<void>;
    /**
     * Data kept when this app id was last uninstalled, and the origin it belonged
     * to. Null when nothing was kept.
     */
    retainedData?: (appId: string) => { origin: string } | null;
    /** Forget the retention record, once it has been restored or wiped. */
    forgetRetainedData?: (appId: string) => void;
    persistSites: (workspaceId: string, sites: DevSites) => void;
    recordGrant: (grant: AppGrantInput) => void;
    /**
     * Supervise one of the app's declared backends, as an ordinary Genie process.
     *
     * Optional so a caller that has no supervisor (a test, a headless probe) is
     * not forced to fake one — an app with no services never needs it either.
     */
    createService?: (
        workspaceId: string,
        service: AppProcessPlan,
    ) => Promise<{ ok: boolean; error?: string }>;
    /** Bring the app's site up at `<slug>.gen`. */
    startSite?: (
        workspaceId: string,
        siteName: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    /** Undo a workspace THIS install created. */
    removeWorkspace: (workspaceId: string) => void;
}

export interface AppInstallResult {
    ok: boolean;
    appId?: string;
    workspaceId?: string;
    /** Where the app will be served — what the caller opens a window on. */
    homeUrl?: string;
    errors?: string[];
    /**
     * The app is installed, but something did not come UP. Distinct from
     * `errors`, which mean it is not installed at all — an app whose backend is
     * missing is a working install with a broken part, and conflating the two
     * would either roll back a good install or hide a dead service.
     */
    warnings?: string[];
    /**
     * Runtimes the user must provide themselves.
     *
     * Carried back rather than left in the consent modal that closed: the Apps
     * panel has to keep saying it, or a permanently-unstartable service reads as
     * a bug in Genie rather than a missing tool.
     */
    userProvides?: ResolvedRequirement[];
}

export interface InstallOptions {
    /**
     * Install the app IN PLACE, for someone building it.
     *
     * The developer loop is otherwise broken: a normal install copies the source
     * into a new workspace, so every edit needs a reinstall before it is visible.
     * In dev mode the folder being edited IS the workspace.
     *
     * It does NOT skip consent. Building an app is not a reason to grant it
     * anything — and a developer who never sees their own consent screen never
     * finds out how it reads.
     */
    devMode?: boolean;
    /** Where this copy came from. Defaults to the local folder it was read from. */
    source?: AppSource;
}

/**
 * Start the app's services and its site, reporting what would not come up.
 *
 * Shared by install and update on purpose. An updated app has to come up the same
 * way a freshly installed one does — same processes, same site, same order — and a
 * second implementation of "bring it up" is a second place for the two to diverge
 * over a release.
 *
 * Nothing here fails the caller. The owner's rule for a missing runtime applies to
 * all of it: the app lands, and whatever cannot start is REPORTED with its reason
 * rather than taking a good install down with it.
 */
async function bringUp(
    io: AppInstallIO,
    workspaceId: string,
    manifest: AppManifest,
    plan: { processes: AppProcessPlan[] },
): Promise<string[]> {
    const warnings: string[] = [];
    const attempt = async (
        what: string,
        run: () => Promise<{ ok: boolean; error?: string }>,
    ): Promise<void> => {
        try {
            const r = await run();
            if (!r.ok) warnings.push(`${what} did not start: ${r.error ?? 'no reason given'}`);
        } catch (e) {
            // A supervisor that throws must not be worse than one that says no.
            warnings.push(`${what} did not start: ${(e as Error).message}`);
        }
    };

    // Services first, and each independently: an app whose backend is missing
    // should still serve its front end, which is where it can EXPLAIN that.
    for (const service of plan.processes) {
        if (!io.createService) break;
        await attempt(`The service “${service.label}”`, () =>
            io.createService!(workspaceId, service),
        );
    }
    if (io.startSite) {
        await attempt(`The site “${manifest.slug}”`, () => io.startSite!(workspaceId, manifest.slug));
    }
    return warnings;
}

export async function installAppFromFolder(
    sourceFolder: string,
    io: AppInstallIO,
    options: InstallOptions = {},
): Promise<AppInstallResult> {
    const raw = io.readManifest(sourceFolder);
    if (raw === null) {
        return {
            ok: false,
            errors: [`No ${APP_MANIFEST_FILENAME} in this folder — it is not a Genie App.`],
        };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return {
            ok: false,
            errors: [`${APP_MANIFEST_FILENAME} is not valid JSON: ${(e as Error).message}`],
        };
    }

    const validated = validateAppManifest(parsed);
    if (!validated.ok) return { ok: false, errors: validated.errors };
    const manifest = validated.value;

    const requires = manifest.requires ?? [];
    const requirements = resolveAppRequirements(
        requires,
        await io.machine(requires.map((r) => r.tool)),
    );

    const source: AppSource = options.source ?? { kind: 'folder', origin: sourceFolder };
    const alreadyInstalled = io.existingApp(manifest.id);
    // An app id is claimed by whoever writes the manifest, so replacing an
    // installed app with one from a DIFFERENT origin is a takeover of something
    // the user already trusts. This is the only moment it can be caught.
    const replacing =
        alreadyInstalled?.source && alreadyInstalled.source.origin !== source.origin
            ? alreadyInstalled.source
            : undefined;

    const consentPlan = buildConsentPlan(manifest, requirements, {
        ...(replacing ? { replacing, source } : {}),
    });
    const outcome = readConsent(consentPlan, await io.ask(consentPlan.questions));
    if (!outcome.install) {
        return { ok: false, errors: ['Installation was declined, so nothing was created.'] };
    }

    // Reuse the workspace an installed copy already has: reinstalling must land on
    // the same place rather than orphaning the old one beside it. What is NOT
    // reused is the grant — a new version can ask for more than the last one did,
    // and inheriting it would let an update escalate without anyone being asked.
    const devMode = options.devMode === true;
    const existing = alreadyInstalled;
    const created = existing
        ? null
        : devMode
          ? await io.adoptFolder(sourceFolder, manifest)
          : await io.createWorkspace(manifest);
    const workspace = existing ?? created!;

    const plan = appInstallPlan(workspace.workspaceId, manifest);
    try {
        // Whether this app inherits the storage sitting under its id.
        //
        // Decided in `data-retention.ts`, where the reasoning lives: data is kept
        // for an app FROM A PARTICULAR ORIGIN, so a reinstall from the same place
        // gets it back and an app that merely claims the same id does not. The
        // decision is made at ARRIVAL because uninstall can fail and an install
        // cannot be skipped.
        const retained = io.retainedData?.(manifest.id) ?? null;
        const storage = decideStorageOnInstall({
            stillInstalled: Boolean(existing),
            retained,
            incoming: { origin: source.origin },
        });
        if (storage.clear) await io.clearAppStorage?.(manifest.id);
        if (retained) io.forgetRetainedData?.(manifest.id);

        // Source next: a site pointed at a directory that is not there yet serves
        // a 404 the user reads as a broken app. In dev mode there is nothing to
        // copy — the source and the workspace are the same folder.
        if (!devMode) io.copyAppSource(sourceFolder, workspace.path, manifest);

        io.persistSites(workspace.workspaceId, { [plan.siteId]: plan.site });

        io.recordGrant({
            appId: manifest.id,
            workspaceId: workspace.workspaceId,
            name: manifest.name,
            version: manifest.version,
            slug: manifest.slug,
            scope: outcome.scope,
            workspaces: outcome.workspaces ?? [],
            capabilities: outcome.capabilities,
            manifestJson: raw,
            installPath: workspace.path,
            source,
            revoked: false,
            devMode,
        });
    } catch (e) {
        // Roll back only what THIS install created — and NEVER in dev mode, where
        // "what was created" is the developer's own folder.
        if (created && !devMode) io.removeWorkspace(created.workspaceId);
        return { ok: false, errors: [(e as Error).message] };
    }

    // --- Bring it UP ---------------------------------------------------------
    // Past this line the app IS installed: the grant is recorded and nothing
    // below rolls it back. The owner's rule for a missing runtime applies to
    // everything here — the app lands, and whatever cannot start is REPORTED with
    // the reason rather than taking the install down with it.
    const warnings = await bringUp(io, workspace.workspaceId, manifest, plan);

    return {
        ok: true,
        appId: manifest.id,
        workspaceId: workspace.workspaceId,
        homeUrl: `https://${manifest.slug}.gen/`,
        ...(warnings.length > 0 ? { warnings } : {}),
        userProvides: requirements.userProvides,
    };
}


/* -------------------------------------------------------------------------- */
/* Updating one                                                               */
/* -------------------------------------------------------------------------- */

export interface AppUpdateResult extends AppInstallResult {
    /** Which of the three paths this version took. */
    applied: 'quiet' | 'consent' | 'blocked';
}

export interface AppUpdateContext {
    /** The installed copy and what the user actually granted it. */
    installed: InstalledAppVersion;
    /** Where this version came from and the commit Genie announced before fetching. */
    arriving: Omit<ArrivingVersion, 'manifest'>;
}

/**
 * Apply a fetched version to an app that is already installed (Tynn #250).
 *
 * The owner's requirement is that a GApp updates on its own development lifecycle,
 * with no Genie release involved. The security model's requirement is that a
 * version asking for more than the user granted goes back through consent. This is
 * where they meet, and the shape is: DECIDE, then act on the decision.
 *
 * The decision is made HERE, from the manifest that arrived — never handed in by
 * the caller. A `skipConsent` argument would put a security decision somewhere it
 * cannot be reviewed and would be one bug away from being wrong; the whole point
 * of `decideAppUpdate` is that a caller cannot assert its way past it.
 *
 * NOT WIRED TO ANYTHING YET, on purpose (owner, 2026-08-22): this is a dev-preview
 * release in which GApps can be built but not published, so there is nowhere for a
 * new version to come from. The mechanism lands first so that the eventual trigger
 * — the user pressing Update in the Store — has nothing to invent. See the header
 * of `updates.ts`.
 *
 * What the quiet path does NOT do is the load-bearing half:
 *
 *   - it never calls `io.ask`, because there is nothing new to ask,
 *   - it carries the EXISTING grant forward untouched — same capabilities, same
 *     reach, same revoked flag — so the app's authority cannot grow by updating,
 *   - and it stays in the workspace the app already has, because a second
 *     workspace would orphan the first with the user's data inside it.
 */
export async function updateAppFromFolder(
    sourceFolder: string,
    io: AppInstallIO,
    context: AppUpdateContext,
): Promise<AppUpdateResult> {
    const { installed, arriving } = context;

    const raw = io.readManifest(sourceFolder);
    if (raw === null) {
        return {
            ok: false,
            applied: 'blocked',
            errors: [`The version that arrived has no ${APP_MANIFEST_FILENAME}.`],
        };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return {
            ok: false,
            applied: 'blocked',
            errors: [`${APP_MANIFEST_FILENAME} is not valid JSON: ${(e as Error).message}`],
        };
    }

    const validated = validateAppManifest(parsed);
    if (!validated.ok) return { ok: false, applied: 'blocked', errors: validated.errors };
    const manifest = validated.value;

    const decision = decideAppUpdate(installed, { ...arriving, manifest });

    if (decision.kind === 'blocked') {
        // Not a decision to put to the user: there is nothing they could usefully
        // say yes to, so the modal never opens.
        return { ok: false, applied: 'blocked', errors: decision.reasons };
    }

    const source: AppSource = {
        kind: 'github',
        origin: arriving.origin,
        commit: arriving.commit,
    };

    if (decision.kind === 'consent') {
        // The ordinary install path, unchanged — review, consent, and a grant made
        // of what the user ticks THIS time. `installAppFromFolder` already reuses
        // the existing workspace and already refuses to inherit the old grant.
        const result = await installAppFromFolder(sourceFolder, io, { source });
        return {
            ...result,
            applied: 'consent',
            ...(result.errors ? { errors: result.errors } : {}),
            // Why it had to ask, so the caller can say so rather than presenting a
            // consent screen out of nowhere.
            warnings: [...(result.warnings ?? []), ...decision.reasons],
        };
    }

    // --- The quiet path ------------------------------------------------------
    const existing = io.existingApp(manifest.id);
    if (!existing) {
        // The caller said this app is installed and the registry disagrees. Doing
        // nothing is the only safe reading of that.
        return {
            ok: false,
            applied: 'blocked',
            errors: ['That app is no longer installed, so there was nothing to update.'],
        };
    }

    const plan = appInstallPlan(existing.workspaceId, manifest);
    try {
        io.copyAppSource(sourceFolder, existing.path, manifest);
        io.persistSites(existing.workspaceId, { [plan.siteId]: plan.site });
        io.recordGrant({
            appId: manifest.id,
            workspaceId: existing.workspaceId,
            // The NEW name and version: this is what is on the machine now.
            name: manifest.name,
            version: manifest.version,
            slug: manifest.slug,
            // The OLD authority, every field of it. This is the line that makes a
            // quiet update safe, and it is the one to look at first if this ever
            // has to be re-audited.
            scope: installed.scope,
            workspaces: installed.workspaces,
            capabilities: installed.capabilities,
            // A revoked app stays revoked. Updating is not a way to switch its
            // permissions back on.
            revoked: installed.revoked,
            manifestJson: raw,
            installPath: existing.path,
            // The verified commit, so the NEXT update has a real version to
            // compare against rather than the one before it.
            source,
            devMode: false,
        });
    } catch (e) {
        return { ok: false, applied: 'blocked', errors: [(e as Error).message] };
    }

    const warnings = await bringUp(io, existing.workspaceId, manifest, plan);

    return {
        ok: true,
        applied: 'quiet',
        appId: manifest.id,
        workspaceId: existing.workspaceId,
        homeUrl: `https://${manifest.slug}.gen/`,
        ...(warnings.length > 0 ? { warnings } : {}),
    };
}
