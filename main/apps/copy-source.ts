/**
 * Copying a GApp's source into the workspace it will run from (Tynn #250).
 *
 * Split out of `ipc.ts` so the RULE it applies can be asserted. What it decides —
 * where each declared component sits in the source folder — is the same question
 * the install gate and the testing suite answer, and the three disagreeing is not
 * a cosmetic problem: a component the gate finds and the copier does not is an
 * install that throws PARTWAY THROUGH, after the workspace already exists. `ipc.ts`
 * imports `electron`, so nothing in it can be unit-tested; the answer was
 * unverifiable exactly where it mattered most.
 *
 * The filesystem is injected for the same reason it is a probe in `validate.ts`:
 * so every branch is asserted rather than depending on what happens to be on the
 * box running the tests.
 */

import path from 'path';
import { appCopyPlan, componentSourceDir, gappSourceLayout } from './install-plan';
import type { AppManifest } from './manifest';

export interface CopyFs {
    exists: (absolutePath: string) => boolean;
    /** Recursive copy, creating `to` and overwriting what is already there. */
    copyDir: (from: string, to: string) => void;
}

/**
 * Copy the app's source into its workspace.
 *
 * A workspace is an envelope, so each declared component LANDS under `repos/<name>`
 * whatever the source looked like — that is what lets the site config and the
 * process `cwd` from `appInstallPlan` point at real directories.
 *
 * Where it comes FROM is the source folder's business, and the two are not the
 * same question. A scaffolded staging folder keeps components flat; a converted
 * `.agi` envelope already keeps them at `repos/<name>`. Reading the source as
 * always-flat made installing from an envelope impossible — it threw on a folder
 * that was plainly there, one directory further down.
 */
export function copyAppSource(
    sourceFolder: string,
    workspacePath: string,
    manifest: AppManifest,
    io: CopyFs,
): void {
    const plan = appCopyPlan(manifest);

    // An app with no named components is a single-folder app: the whole thing is
    // the workspace root, envelope paths included.
    if (plan.wholeFolder) {
        io.copyDir(sourceFolder, workspacePath);
        return;
    }

    const layout = gappSourceLayout(sourceFolder, io.exists);

    for (const component of plan.components) {
        const from = componentSourceDir(sourceFolder, layout, component);
        if (!io.exists(from)) {
            throw new Error(
                `The manifest names "${component}", but there is no such folder in ${sourceFolder}.`,
            );
        }
        io.copyDir(from, path.join(workspacePath, 'repos', component));
    }

    // Envelope-level paths belong to no component, so nothing above carries them —
    // the manifest itself, and `.agents/` when the app declared agents. Which ones
    // is decided in `appCopyPlan` and asserted there; this only moves them.
    //
    // These are envelope-level in BOTH layouts — they sit beside the manifest
    // either way — so they are never resolved through the component resolver.
    for (const relative of plan.envelopePaths) {
        const from = path.join(sourceFolder, relative);
        if (!io.exists(from)) {
            throw new Error(
                `The app declares "${relative}", but there is no such path in ${sourceFolder}.`,
            );
        }
        io.copyDir(from, path.join(workspacePath, relative));
    }
}
