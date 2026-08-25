/**
 * The `manageGappDev` tool — the IMPURE half of `workspace/gapp-dev-status.ts`.
 *
 * Resolves the caller's workspace, reads what is actually in its folder, and
 * runs the same first-party tools a human gets in Workspace Settings. The
 * decisions (may this action run, what does the agent read) live next door and
 * are tested without any of this.
 *
 * ## Two things this file is deliberately NOT
 *
 * It is **not a second implementation**. `check` runs `checkApp` over
 * `fsCheckProbe` — byte for byte the suite behind the Settings button and the
 * CLI. `preview` runs `openPreview` over the SAME `PreviewIO` the button uses.
 * A parallel implementation would disagree with the one the user sees the moment
 * either changed, and then the agent's answer would be a lie rather than a
 * duplicate.
 *
 * It is **not a way around the human**. `openPreview` raises the OS permission
 * modal itself, outside any app window, and that consent belongs to the user;
 * nothing here supplies or bypasses it. What the tool removes is the CLICKING,
 * not the consent — a human still cannot see this terminal, which is the whole
 * reason an agent needs its own path to these tools.
 *
 * ## The preview seam
 *
 * A preview needs a desktop window, and a headless host has none. Rather than
 * fail at call time with something that reads like a bug, the window half is an
 * INJECTED port: absent ⇒ `previewAvailable: false`, and the refusal names the
 * host as the reason.
 */

import fs from 'fs';
import path from 'path';
import { listAppGrants, listWorkspaces } from '../db';
import { checkApp } from '../apps/checkup';
import { fsCheckProbe } from '../apps/check-fs';
import { gappHomeUrl } from '../apps/hostname';
import { APP_MANIFEST_FILENAME, validateAppManifest } from '../apps/manifest';
import { isPreviewAppId } from '../apps/preview';
import { listPreviews } from '../apps/preview-registry';
import { isGappDevValue } from '../workspace/gapp-dev';
import {
    decideGappDevAction,
    type GappDevPreview,
    type GappDevStatus,
} from '../workspace/gapp-dev-status';
import { resolveTynnLinkForRow } from '../workspace/tynn-link';
import { callerWorkspaceIdFor } from './caller-workspace';
import type { ManageGappDevRequest, ManageGappDevResult } from './protocol';

/**
 * The desktop half — opening and closing a real GApp window.
 *
 * Injected because it is the ONE part of this tool that cannot exist headless.
 * Registered by the Electron shell at boot; a genie-cloud host simply never sets
 * it, and the tool says so instead of pretending the workspace is not a GDW.
 */
export interface GappPreviewPort {
    open: (folder: string) => Promise<{
        ok: boolean;
        appId?: string;
        homeUrl?: string;
        errors?: string[];
        warnings?: string[];
    }>;
    close: (appId: string) => Promise<void>;
}

let previewPort: GappPreviewPort | null = null;

/** Wire the desktop preview seam. Called once, by the Electron shell. */
export function setGappPreviewPort(port: GappPreviewPort | null): void {
    previewPort = port;
}

/** The workspace-root manifest, reduced to what an agent is told. */
function readAppFacts(root: string): GappDevStatus['app'] {
    const file = path.join(root, APP_MANIFEST_FILENAME);
    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // A manifest that will not parse is not "no app" — but `check` is the
        // tool that says so properly, with a finding that names the line. Here
        // it reads as absent, and `check` is offered either way.
        return null;
    }
    const validated = validateAppManifest(parsed);
    if (!validated.ok) return null;
    return {
        name: validated.value.name,
        slug: validated.value.slug,
        version: validated.value.version,
    };
}

/** Previews open on THIS folder — never somebody else's app. */
function previewsOfFolder(folder: string): GappDevPreview[] {
    const mine: GappDevPreview[] = [];
    for (const live of listPreviews()) {
        if (path.resolve(live.folder) !== path.resolve(folder)) continue;
        mine.push({
            appId: live.identity.appId,
            homeUrl: gappHomeUrl(live.manifest.slug),
        });
    }
    return mine;
}

/** Everything Genie can say about the caller's workspace as a place a GApp is BUILT. */
export function gappDevStatusFor(terminalId: string): GappDevStatus {
    const empty: GappDevStatus = {
        isGdw: false,
        root: null,
        workspaceName: null,
        tynnProjectId: null,
        app: null,
        previews: [],
        previewAvailable: previewPort !== null,
    };

    const workspaceId = callerWorkspaceIdFor(terminalId);
    if (!workspaceId) return empty;
    const row = listWorkspaces().find((w) => w.id === workspaceId);
    if (!row?.path) return empty;

    return {
        // Read through `isGappDevValue` rather than off the row, for the reason
        // it exists: a hand edit or a newer Genie's value falls back to the
        // ORDINARY workspace, never to the privileged one.
        isGdw: isGappDevValue(row.gapp_dev),
        root: row.path,
        workspaceName: row.project_name ?? null,
        tynnProjectId: resolveTynnLinkForRow(row)?.projectId ?? null,
        app: readAppFacts(row.path),
        previews: previewsOfFolder(row.path),
        previewAvailable: previewPort !== null,
    };
}

/**
 * Which preview `close-preview` means when the agent named none.
 *
 * Only ever a preview that is actually OPEN on this folder — never one derived
 * from the manifest. Deriving an id would let the tool try to close something
 * nobody opened, and report success for it.
 */
function defaultPreviewId(status: GappDevStatus): string | null {
    return status.previews.length === 1 ? status.previews[0]!.appId : null;
}

/** Run one `manageGappDev` action for the calling terminal. */
export async function manageGappDevForMcp(
    terminalId: string,
    req: ManageGappDevRequest,
): Promise<ManageGappDevResult> {
    const status = gappDevStatusFor(terminalId);
    const decision = decideGappDevAction(status, req.action);
    if (!decision.allowed) {
        return { ok: false, action: req.action, status, error: decision.reason };
    }

    if (req.action === 'status') return { ok: true, action: 'status', status };

    if (req.action === 'check') {
        const report = checkApp(status.root!, fsCheckProbe({
            // An app re-checking ITSELF must not report its own address as taken
            // — the same rule the Settings button's probe uses, for the same
            // reason: otherwise every reinstall looks like a collision.
            slugTaken: (slug, selfId) =>
                listAppGrants().some((g) => g.slug === slug && g.appId !== selfId),
        }));
        return { ok: true, action: 'check', status, check: report };
    }

    if (req.action === 'preview') {
        const result = await previewPort!.open(status.root!);
        return {
            ok: result.ok,
            action: 'preview',
            // RE-READ, so the status reports the preview that just opened rather
            // than the world as it was one line ago.
            status: gappDevStatusFor(terminalId),
            preview: {
                appId: result.appId,
                homeUrl: result.homeUrl,
                warnings: result.warnings,
            },
            ...(result.ok ? {} : { error: result.errors?.join(' ') ?? 'The preview did not open.' }),
        };
    }

    const appId = req.appId?.trim() || defaultPreviewId(status);
    if (!appId) {
        return {
            ok: false,
            action: 'close-preview',
            status,
            error: status.previews.length
                ? `${status.previews.length} previews are open on this folder, so pass \`appId\` to say which: ${status.previews.map((p) => `\`${p.appId}\``).join(', ')}.`
                : 'No preview is open for this workspace, so there is nothing to close.',
        };
    }
    // A preview id and an INSTALLED app id are different things, and closing is
    // teardown: the id must be one this tool could have created. Otherwise
    // `close-preview` becomes a way to shut down somebody's installed app.
    if (!isPreviewAppId(appId)) {
        return {
            ok: false,
            action: 'close-preview',
            status,
            error: `\`${appId}\` is not a preview. This closes previews only — an installed app is closed from its own window.`,
        };
    }
    await previewPort!.close(appId);
    return {
        ok: true,
        action: 'close-preview',
        status: gappDevStatusFor(terminalId),
        preview: { appId },
    };
}
