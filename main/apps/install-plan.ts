import { devSiteIdFor, type DevSiteConfig } from '../dev-server/sites-config';
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
        genName: `${slug}.gen`,
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
