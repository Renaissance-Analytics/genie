/**
 * Opening and closing a GApp preview (Tynn #250).
 *
 * The sequence is the feature, exactly as it is for `installAppFromFolder`, and it
 * is deliberately the same sequence minus the parts that make an install permanent:
 *
 *   1. Validate the manifest, then CHECK THE FOLDER. A folder whose front end was
 *      never built serves a blank page, and a blank page inside a real-looking
 *      window is the most misleading thing a previewer could show.
 *   2. Ask — unless this folder already answered the same question. Dismissal
 *      creates nothing at all.
 *   3. A throwaway workspace on the developer's own folder, the declared panels
 *      laid out in it, a site at the preview address, and the real window.
 *
 * And then the part an install never has to do: undo all of it when the window
 * closes, and undo it again at boot for the case where the window never got the
 * chance to close.
 *
 * The I/O is injected for the same reason the installer's is. The assertions that
 * matter here are about calls that must NOT happen — no workspace on a refusal, no
 * `removeWorkspace` on a row this preview does not own — and a call that did not
 * happen is only assertable if the call is visible.
 */

import { ensureAgentPanels, type PlannedPanel } from './panels';
import { gappHomeUrl } from './hostname';
import { buildConsentPlan, readConsent } from './consent-plan';
import { resolveAppRequirements, type RequirementMachine } from './requirements';
import { validateAppFolder } from './validate';
import { APP_MANIFEST_FILENAME, validateAppManifest, type AppManifest } from './manifest';
import {
    mayTearDownPreviewWorkspace,
    orphanedPreviewWorkspaces,
    previewGrant,
    previewIdentityFor,
    previewManifest,
    previewSitePlan,
    type PreviewConsent,
    type PreviewWorkspaceRow,
} from './preview';
import { forgetPreview, livePreview, rememberPreview } from './preview-registry';
import { callerIdForApp } from '../mcp/caller-identity';
import type { DevSites } from '../dev-server/sites-config';
import type { ForceAnswer, ForceQuestion } from '../mcp/protocol';

export interface RememberedConsent {
    /** What the app was asking for when this answer was given. */
    fingerprint: string;
    consent: PreviewConsent;
}

export interface PreviewIO {
    /** The raw `genie-app.json`, or null when the folder has none. */
    readManifest: (folder: string) => string | null;
    exists: (absolutePath: string) => boolean;
    machine: (required: readonly string[]) => Promise<RequirementMachine>;
    /** The OS modal, drawn OUTSIDE any app window — what makes it unfakeable. */
    ask: (questions: ForceQuestion[]) => Promise<{ cancelled: boolean; answers: ForceAnswer[] }>;

    rememberedConsent: (folder: string) => RememberedConsent | null;
    recordConsent: (folder: string, remembered: RememberedConsent) => void;

    /**
     * A BRAND NEW throwaway workspace on the developer's folder.
     *
     * Never an existing row, even when one already points at this exact path.
     * Dev-mode install adopts a matching workspace and that is right for an
     * install; here it would be catastrophic, because closing the preview window
     * removes the workspace it created — and it must never be the developer's own.
     */
    createWorkspace: (input: {
        /** The PREVIEW app id — what this workspace is for. */
        appId: string;
        name: string;
        path: string;
    }) => { workspaceId: string };
    workspaceRow: (workspaceId: string) => PreviewWorkspaceRow | null;
    removeWorkspace: (workspaceId: string) => void;
    listWorkspaceRows: () => PreviewWorkspaceRow[];

    /** Panels already in this workspace. Background processes are not panels. */
    countPanels: (workspaceId: string) => number;
    /**
     * Write one panel. `appId` is the PREVIEW app id — a bound agent panel records
     * which app it belongs to, and a preview's agents belong to the preview.
     */
    createPanel: (appId: string, workspaceId: string, panel: PlannedPanel) => void;
    /**
     * May this workspace start `n` more agent terminals (Tynn #117)? A preview
     * starts REAL agents, so it meets the real cap.
     */
    mayStartAgents: (workspaceId: string, n: number) => { allowed: boolean; reason?: string };
    /** Drop every panel this preview's workspace holds, ptys included. */
    removePanels: (workspaceId: string) => void;
    panelsChanged: () => void;

    persistSites: (workspaceId: string, sites: DevSites) => void;
    startSite: (
        workspaceId: string,
        siteName: string,
        callerId: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    stopSite: (workspaceId: string, siteName: string, callerId: string) => Promise<void>;

    clearStorage: (appId: string) => Promise<void>;
    openWindow: (opts: {
        appId: string;
        slug: string;
        name: string;
        homeUrl: string;
        devMode: boolean;
        manifest: AppManifest;
        /**
         * The workspace THIS window's preview owns.
         *
         * Carried so the window's close callback can scope its teardown to the
         * preview it actually belongs to — see the race in {@link closePreview}.
         */
        workspaceId: string;
    }) => void;
    closeWindow: (appId: string) => void;
}

export interface PreviewResult {
    ok: boolean;
    appId?: string;
    workspaceId?: string;
    /** `https://<slug>.preview.gen/` — the address this preview serves at. */
    homeUrl?: string;
    errors?: string[];
    /** It opened, but something did not come up. Distinct from `errors`. */
    warnings?: string[];
}

/**
 * PURE. What this app is ASKING FOR, as a comparable string.
 *
 * The whole reason to remember a preview's answer is that re-asking on every
 * preview is friction on the loop this feature exists to speed up. The whole
 * reason to forget one is that a changed permission set is exactly when the screen
 * has something new to say — and the moment a developer most wants to see how
 * their own ask reads.
 *
 * Sorted, so reordering the array in the manifest is not a different question.
 */
export function permissionsFingerprint(manifest: AppManifest): string {
    const { scope, capabilities, workspaces } = manifest.permissions;
    return JSON.stringify({
        scope,
        capabilities: [...capabilities].sort(),
        workspaces: [...(workspaces ?? [])].sort(),
    });
}

/** The folder probe, over the injected filesystem. */
function probeFor(io: PreviewIO, folder: string) {
    return {
        readManifest: () => io.readManifest(folder),
        exists: io.exists,
        // A preview does NOT claim `<slug>.gen` — it serves at `<slug>.preview.gen`
        // — so an installed app holding that address is not a collision. Reporting
        // one would make "preview the app I already have installed" impossible,
        // which is the most likely thing a developer wants to do.
        slugTaken: () => false,
    };
}

export async function openPreview(folder: string, io: PreviewIO): Promise<PreviewResult> {
    const raw = io.readManifest(folder);
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

    // The same check the developer can run by hand, run for them. Previewing is
    // where it earns its keep: an unbuilt `dist` is invisible until something
    // tries to serve it, and by then it looks like the app is broken.
    const report = validateAppFolder(folder, probeFor(io, folder));
    if (!report.ok) return { ok: false, errors: report.errors };

    const identity = previewIdentityFor(manifest);
    const preview = previewManifest(manifest);

    // --- Consent -------------------------------------------------------------
    const fingerprint = permissionsFingerprint(manifest);
    const remembered = io.rememberedConsent(folder);
    let consent: PreviewConsent;
    if (remembered && remembered.fingerprint === fingerprint) {
        consent = remembered.consent;
    } else {
        const requires = manifest.requires ?? [];
        const plan = buildConsentPlan(
            preview,
            resolveAppRequirements(requires, await io.machine(requires.map((r) => r.tool))),
            { preview: true },
        );
        const outcome = readConsent(plan, await io.ask(plan.questions));
        if (!outcome.install) {
            return { ok: false, errors: ['The preview was declined, so nothing was created.'] };
        }
        consent = {
            scope: outcome.scope,
            capabilities: outcome.capabilities,
            ...(outcome.workspaces ? { workspaces: outcome.workspaces } : {}),
        };
        io.recordConsent(folder, { fingerprint, consent });
    }

    // Past this line things get created — so anything this app was previewing
    // before is torn down FIRST. Re-previewing is the ordinary case (it is what
    // "I changed the manifest" looks like), and a second throwaway workspace
    // stacked on the first is the leak this whole module exists to avoid.
    await closePreview(identity.appId, io);

    // --- Create --------------------------------------------------------------
    const { workspaceId } = io.createWorkspace({
        appId: identity.appId,
        name: `${manifest.name} (preview)`,
        // The developer's OWN folder. A preview shows live source, not a copy —
        // which is also why teardown has to be so careful about what it deletes.
        path: folder,
    });

    // The panels the manifest declared, laid out BEFORE the window loads, so the
    // Agent tab's first read of the workspace already has them. The workspace was
    // created a moment ago, so the idempotency has nothing to do here — but this is
    // the same seeder the installed path uses, roster and cap included, which is
    // what makes a preview's Agent tab the app's real one rather than a mock-up of
    // it that behaves differently on the day it ships.
    const warnings: string[] = [];
    const seeded = ensureAgentPanels(
        {
            countPanels: () => io.countPanels(workspaceId),
            createPanel: (panel) => io.createPanel(identity.appId, workspaceId, panel),
            mayStartAgents: (n) => io.mayStartAgents(workspaceId, n),
        },
        manifest.panels,
        manifest.agents,
    );
    io.panelsChanged();
    // A WARNING, not a failure. The developer still needs the window — seeing why
    // their agents did not come up is most of the value of previewing at all.
    if (seeded.refused) warnings.push(seeded.refused);

    // --- Serve ---------------------------------------------------------------
    const site = previewSitePlan(workspaceId, preview);
    io.persistSites(workspaceId, { [site.siteId]: site.site });
    // A site that will not come up is a WARNING, never a failure. The Agent tab is
    // Genie's own and needs no hosting at all, so a machine with no dev-server
    // stack still gets the half of this feature the panels live in — and the
    // reason the app's tabs are empty is said out loud rather than left looking
    // like a bug in the app being built.
    try {
        const started = await io.startSite(workspaceId, site.site.name, callerIdForApp(identity.appId));
        if (!started.ok) {
            warnings.push(`The preview site did not start: ${started.error ?? 'no reason given'}`);
        }
    } catch (e) {
        // A supervisor that throws must not be worse than one that says no.
        warnings.push(`The preview site did not start: ${(e as Error).message}`);
    }

    if (manifest.services?.length) {
        // Stated, not silently skipped. A preview starts no background services:
        // they outlive a window, and "closing the window is the whole cleanup"
        // stops being true the moment one is running. An app whose front end sits
        // waiting on a backend needs to know WHY rather than conclude its own code
        // is broken.
        warnings.push(
            `${manifest.services.length} background service(s) are not started in a preview — ` +
                'install the app for development to run them.',
        );
    }

    rememberPreview({
        identity,
        source: manifest,
        manifest: preview,
        folder,
        workspaceId,
        grant: previewGrant(manifest, identity, workspaceId, consent),
        siteId: site.siteId,
        warnings,
    });

    const homeUrl = gappHomeUrl(preview.slug);
    io.openWindow({
        appId: identity.appId,
        slug: preview.slug,
        name: manifest.name,
        homeUrl,
        workspaceId,
        // A preview is a place an app is being BUILT, so dev tools are on for the
        // same reason they are in a dev install: you have to be able to inspect
        // what you are looking at. Nothing else about the isolation moves.
        devMode: true,
        manifest: preview,
    });

    return {
        ok: true,
        appId: identity.appId,
        workspaceId,
        homeUrl,
        ...(warnings.length > 0 ? { warnings } : {}),
    };
}

/**
 * Undo a preview, entirely.
 *
 * Order matters and mirrors the workspace-remove IPC: the site goes FIRST,
 * because stopping it reads the workspace's own site config to release what it
 * holds, and a deleted row answers nothing.
 *
 * Every step is attempted even if an earlier one failed. A preview that could not
 * be half-removed is worse than one removed in the wrong order — the whole promise
 * is that closing the window leaves nothing behind.
 */
export async function closePreview(
    appId: string,
    io: PreviewIO,
    /**
     * Only tear down if the live preview is still THIS one.
     *
     * Passed by a window's own close callback, and it closes a real race.
     * Re-previewing tears the previous preview down first, which asks Electron to
     * close its window — and `closed` fires ASYNCHRONOUSLY, while `openPreview`
     * awaits the site start in between. So the old window's callback routinely
     * runs AFTER the new preview has been registered under the same app id.
     * Unscoped, it would find the new preview and dismantle it: the developer
     * presses preview, the window appears, and its panels and workspace vanish
     * underneath it for no visible reason.
     *
     * Omitted by a caller acting on "whatever is being previewed now" — the Store
     * drawer's Close button, which means exactly that.
     */
    onlyWorkspaceId?: string,
): Promise<void> {
    const live = livePreview(appId);
    if (!live) return;
    if (onlyWorkspaceId !== undefined && live.workspaceId !== onlyWorkspaceId) return;

    // Forget it FIRST. Everything below can fail, and a preview whose window is
    // going away must stop answering as the app the moment that is decided — a
    // grant left in the registry would keep a dead window's identity alive.
    forgetPreview(appId);

    try {
        await io.stopSite(live.workspaceId, live.manifest.slug, callerIdForApp(appId));
    } catch {
        // A site that will not stop must not strand the workspace row behind it.
    }

    io.removePanels(live.workspaceId);
    io.panelsChanged();

    // The load-bearing guard. A preview's workspace points at the DEVELOPER'S OWN
    // FOLDER, and Genie may already hold a real workspace row on that same path.
    // The row is re-read and re-checked here rather than trusted from the record
    // this preview wrote, because the whole failure mode is a record that has
    // stopped being true.
    if (mayTearDownPreviewWorkspace(io.workspaceRow(live.workspaceId), live.workspaceId)) {
        io.removeWorkspace(live.workspaceId);
    }

    // The partition is the preview's own — derived from an app id no installed app
    // can hold — so clearing it cannot reach an installed copy's cookies.
    await io.clearStorage(appId).catch(() => {});

    io.closeWindow(appId);
}

/**
 * Remove preview workspaces left behind by a crash. Called once at boot.
 *
 * A preview cannot outlive its window and a window cannot outlive the process, so
 * a preview workspace present at STARTUP has nothing behind it. Sweeping is what
 * keeps "closing the window is the whole cleanup" true in the case where the
 * window never got the chance to close.
 */
export function sweepPreviewWorkspaces(io: PreviewIO): void {
    for (const id of orphanedPreviewWorkspaces(io.listWorkspaceRows())) {
        io.removePanels(id);
        io.removeWorkspace(id);
    }
}
