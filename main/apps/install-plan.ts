import { devSiteIdFor, type DevSiteConfig } from '../dev-server/sites-config';
import type { AppManifest } from './manifest';

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
