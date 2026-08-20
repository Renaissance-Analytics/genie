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

import { appInstallPlan } from './install-plan';
import { buildConsentPlan, readConsent } from './consent-plan';
import { validateAppManifest, APP_MANIFEST_FILENAME, type AppManifest } from './manifest';
import { resolveAppRequirements, type RequirementMachine } from './requirements';
import type { DevSites } from '../dev-server/sites-config';
import type { AppScope } from './manifest';
import type { ForceAnswer, ForceQuestion } from '../mcp/protocol';

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
    revoked: boolean;
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
    /** The workspace an already-installed copy of this app lives in. */
    existingApp: (appId: string) => { workspaceId: string; path: string } | null;
    createWorkspace: (
        manifest: AppManifest,
    ) => Promise<{ workspaceId: string; path: string }>;
    /** Copy the app's source into its workspace. */
    copyAppSource: (sourceFolder: string, workspacePath: string, manifest: AppManifest) => void;
    persistSites: (workspaceId: string, sites: DevSites) => void;
    recordGrant: (grant: AppGrantInput) => void;
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
}

export async function installAppFromFolder(
    sourceFolder: string,
    io: AppInstallIO,
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
    const consentPlan = buildConsentPlan(manifest, requirements);
    const outcome = readConsent(consentPlan, await io.ask(consentPlan.questions));
    if (!outcome.install) {
        return { ok: false, errors: ['Installation was declined, so nothing was created.'] };
    }

    // Reuse the workspace an installed copy already has: reinstalling must land on
    // the same place rather than orphaning the old one beside it. What is NOT
    // reused is the grant — a new version can ask for more than the last one did,
    // and inheriting it would let an update escalate without anyone being asked.
    const existing = io.existingApp(manifest.id);
    const created = existing ? null : await io.createWorkspace(manifest);
    const workspace = existing ?? created!;

    try {
        // Source first: a site pointed at a directory that is not there yet serves
        // a 404 the user reads as a broken app.
        io.copyAppSource(sourceFolder, workspace.path, manifest);

        const plan = appInstallPlan(workspace.workspaceId, manifest);
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
            revoked: false,
        });
    } catch (e) {
        // Roll back only what THIS install created. Deleting the workspace a
        // working app was already living in would turn a failed update into data
        // loss.
        if (created) io.removeWorkspace(created.workspaceId);
        return { ok: false, errors: [(e as Error).message] };
    }

    return {
        ok: true,
        appId: manifest.id,
        workspaceId: workspace.workspaceId,
        homeUrl: `https://${manifest.slug}.gen/`,
    };
}
