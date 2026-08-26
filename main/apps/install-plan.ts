import path from 'path';
import { devSiteIdFor, type DevSiteConfig } from '../dev-server/sites-config';
import { gappHostname } from './hostname';
import { APP_AGENTS_DIR, APP_MANIFEST_FILENAME, type AppManifest } from './manifest';

/**
 * PURE. What installing a GApp actually configures (Tynn #250).
 *
 * This is the step that makes "automated install with preconfigured hosting" true:
 * it produces exactly what a person would otherwise set up by hand in the Site
 * Manager, and nothing more.
 *
 * It emits the envelope's OWN {@link DevSiteConfig} rather than a GApp-specific
 * shape. That is the whole point — from the moment it is installed a GApp is an
 * ORDINARY Genie site: startable, restartable, loggable, visible in the Site
 * Manager, reachable at `.gen`. No parallel hosting path to keep working, and no
 * second set of bugs to fix. The two real target apps already run on exactly this
 * config; the installer just writes it for you.
 *
 * Kept pure so the mapping is asserted directly, instead of being inferred from a
 * workspace that got created somewhere with side effects.
 */

/** A backend service to supervise, in `manageProcess` terms. */
export interface AppProcessPlan {
    label: string;
    /** LITERAL argv — never a shell string (see the manifest's own rule). */
    command: string[];
    /** Envelope-relative working directory; '' is the workspace root. */
    cwd: string;
    port?: number;
}

export interface AppInstallPlan {
    siteId: string;
    site: DevSiteConfig;
    processes: AppProcessPlan[];
}

/** `repos/<name>`, or '' for the workspace root — the envelope's own spelling. */
function repoPath(repo: string | undefined): string {
    return repo ? `repos/${repo}` : '';
}

/**
 * The two shapes a GApp SOURCE folder legitimately has (genie#268).
 *
 * `staging` is what `scaffoldApp` writes, and what a developer assembling an app
 * by hand produces: the components sit FLAT beside the manifest, and the copier
 * moves each one to `repos/<name>` on its way into the workspace.
 *
 * `envelope` is a converted `.agi` workspace — a GApp Development Workspace. It is
 * not a folder that will BECOME an envelope on install; it already is one, so its
 * components are at `repos/<name>` before anything is installed. That is not a
 * quirk of one developer's setup: it is what an envelope IS, and converting a real
 * workspace is what a GDW is for.
 *
 * Both are real, and both have to validate.
 */
export type GappSourceLayout = 'staging' | 'envelope';

/**
 * The file that makes a folder an envelope — the Aionima envelope config and repo
 * registry. Genie writes one into every workspace it creates and `scaffoldApp`
 * writes none, so its presence is the folder STATING which layout it has.
 *
 * `.gitmodules` would be the wrong marker: a component need not be a submodule.
 * The scaffolded ones are plain folders, and an envelope may hold plain
 * directories too, so keying on it would miss envelopes and mislabel them staging.
 */
export const ENVELOPE_MARKER = 'project.json';

/**
 * Which layout a source folder has — decided ONCE, from the folder itself.
 *
 * Deliberately NOT "try `repos/<name>`, fall back to flat". A checker's whole job
 * is to say what is wrong, and a resolver that accepts either path cannot name
 * the place a MISSING component should have been — it only ever learns that it
 * was in neither. That is exactly how the old advice came to be wrong: it asserted
 * a layout it had never determined, and told developers standing in an envelope to
 * create a duplicate of the folder they were looking at. Deciding first is what
 * makes the message right in both directions.
 *
 * It also keeps the CHECK and the COPY on one rule. The copier runs on a plain
 * path with no database in reach, so the answer has to be readable from the folder
 * alone — which is why this keys off a file and not off stored `gapp_dev` state.
 *
 * Takes an `exists` predicate rather than touching `fs`, so the rule stays pure
 * and the callers keep the probes they already inject.
 */
export function gappSourceLayout(
    folder: string,
    exists: (absolutePath: string) => boolean,
): GappSourceLayout {
    return exists(path.join(folder, ENVELOPE_MARKER)) ? 'envelope' : 'staging';
}

/**
 * Where component `<name>` actually sits inside a SOURCE folder of this layout.
 *
 * The single resolver every caller uses — the install gate, the testing suite and
 * the copier — because a component found in one place and copied from another is
 * an install that fails partway through, after the workspace already exists.
 */
export function componentSourceDir(
    folder: string,
    layout: GappSourceLayout,
    repo: string | undefined,
): string {
    if (!repo) return folder;
    return layout === 'envelope' ? path.join(folder, 'repos', repo) : path.join(folder, repo);
}

/** How to SPELL that location to a developer, in the terms their own layout uses. */
export function componentSourceSpelling(layout: GappSourceLayout, repo: string): string {
    return layout === 'envelope' ? `repos/${repo}` : repo;
}

/** What of the source folder becomes the installed app. */
export interface AppCopyPlan {
    /** The app named no components, so the whole folder IS the app. */
    wholeFolder: boolean;
    /** Component folders, each landing at `repos/<name>`. */
    components: string[];
    /** Envelope-level paths that travel whatever the components are. */
    envelopePaths: string[];
}

/**
 * Which paths of the source folder travel into the workspace.
 *
 * A GApp with named components is copied component by component: the manifest
 * says which folders are the app, and the rest of the developer's directory is
 * not. That rule is right, and it is precisely why the envelope-level paths have
 * to be enumerated here — they belong to no component, so nothing else would
 * carry them.
 *
 * `.agents/` is carried only when the app DECLARED agents. Copying it
 * unconditionally would smuggle discovery back in through the copier: files would
 * land on the machine that no consent screen ever described. What travels is the
 * folder — a persona is often more than one file — but what may RUN is only what
 * the manifest declared, which `validateAppFolder` has already checked is there.
 *
 * Pure, because the assertion that matters is about a path that must NOT be
 * forgotten, and a copier made of `fs` calls cannot state that.
 */
export function appCopyPlan(manifest: AppManifest): AppCopyPlan {
    const components = new Set<string>();
    if (manifest.frontend.repo) components.add(manifest.frontend.repo);
    for (const service of manifest.services ?? []) {
        if (service.repo) components.add(service.repo);
    }

    return {
        wholeFolder: components.size === 0,
        components: [...components],
        envelopePaths: [
            // The manifest travels so its DECLARED permissions stay readable after
            // install — that is the ceiling the permissions screen narrows to.
            APP_MANIFEST_FILENAME,
            ...((manifest.agents ?? []).length > 0 ? [APP_AGENTS_DIR] : []),
        ],
    };
}

export function appInstallPlan(workspaceId: string, manifest: AppManifest): AppInstallPlan {
    const { slug, frontend } = manifest;

    const site: DevSiteConfig = {
        name: slug,
        // A bare `<slug>.gen`, matching what the real apps use (`orr.gen`,
        // `ripple.gen`) rather than the `<site>.<workspace>.gen` default: a GApp is
        // its own product, and its address should read like one.
        //
        // PENDING CORRECTION (owner, 2026-08-22): hosted GApp sites are to move to
        // the `.gapp` TLD — `<slug>.gapp`, distinct from the `.gapp` ENVELOPE
        // suffix, which is a different thing that also exists. That migration does
        // NOT start here any more: `hostname.ts` is now the single place a GApp's
        // address is minted, and its header carries the reason the TLD has not been
        // flipped yet (the site sanitiser, `GEN_HOST_RE`, the multi-SAN certificate
        // and the host-header allowlist all assume `.gen`, so moving it in one file
        // and not the others would mint an address the navigation policy does not
        // recognise). Tracked as genie#237.
        genName: gappHostname(slug),
        repo: frontend.repo ?? '',
        // HOST-NATIVE, not a container. A GApp runs against live source on the
        // host, which is the model both target apps already use.
        runMode: 'host',
        kind: 'http',
        enabled: true,
        ...(frontend.serve.mode === 'static'
            ? {
                  hostServe: {
                      mode: 'static' as const,
                      root: frontend.serve.root,
                      ...(frontend.serve.spa ? { spa: true } : {}),
                  },
              }
            : {
                  // Genie fronts a port it did NOT start, so there is deliberately
                  // no hostServe block: a generated serve config would be config
                  // for a server Genie is not running.
                  hostPort: frontend.serve.hostPort,
              }),
        // Reaching a real browser installs a certificate, edits the hosts file and
        // runs a local proxy — a one-time admin prompt. Never a side effect of
        // installing an app; only when the app asked and the user agreed.
        ...(frontend.browserExposed ? { browserExposed: true } : {}),
    };

    return {
        // Keyed the way every other site is, so a reinstall lands on the SAME row
        // instead of orphaning the old one beside it.
        siteId: devSiteIdFor(workspaceId, slug),
        site,
        processes: (manifest.services ?? []).map((service) => ({
            label: service.name,
            command: service.command,
            cwd: repoPath(service.repo),
            ...(service.port !== undefined ? { port: service.port } : {}),
        })),
    };
}
