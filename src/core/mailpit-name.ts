import { slugLabel } from './gen-name.js';
import type { GenRoute } from './gen-router.js';
import type { ServiceInstance } from './services.js';

/**
 * MAILPIT AT mail.gen (the owner, 2026-10-21): a Mailpit's web inbox is served by Genie's front door at a `.gen` name —
 * the Genie browser opens `.gen` sites only — and that name is its connection info too (MAIL_HOST; the hosts file points
 * it at this machine). The shared Mailpit is `mail.gen`; a workspace's own is `<workspace>.mail.gen`. `mail` and every
 * name under it are Genie's: no site may take them (core/gen-name.ts `siteNameProblem`).
 *
 * Only a Mailpit that publishes its web inbox has a name: without that port there is nothing to serve, no route, and so
 * no hosts line — its connection info stays 127.0.0.1, never a name nothing resolves.
 */
export const MAIL_HOST_NAME = 'mail.gen';

/** The Mailpit's `.gen` name: `mail.gen` when shared, `<workspace>.mail.gen` when a workspace's own. */
export function mailpitHostOf(i: Pick<ServiceInstance, 'scope'>): string {
    if (i.scope.kind === 'shared') return MAIL_HOST_NAME;
    return `${slugLabel(i.scope.workspaceId) || 'workspace'}.${MAIL_HOST_NAME}`;
}

/** Its web inbox's loopback port, when it publishes one. */
function inboxPortOf(i: ServiceInstance): number | null {
    return i.engine === 'mailpit' && typeof i.publishedPorts?.ui === 'number' ? i.publishedPorts.ui : null;
}

/** The name it is reached by, or `null` when it has none (no web inbox published). */
export function mailpitNameOf(i: ServiceInstance): string | null {
    return inboxPortOf(i) === null ? null : mailpitHostOf(i);
}

/** The front door's routes to each Mailpit's web inbox — one per name; the first instance holding a name keeps it. */
export function mailpitRoutes(instances: readonly ServiceInstance[]): GenRoute[] {
    const routes: GenRoute[] = [];
    for (const i of instances) {
        const port = inboxPortOf(i);
        if (port === null) continue;
        const host = mailpitHostOf(i);
        if (routes.some((r) => r.host === host)) continue;
        routes.push({ host, target: `127.0.0.1:${port}` });
    }
    return routes;
}

/** Where Open inbox goes — the UI and the agents' tool alike: `https://<name>/`, or `null` with no web inbox. */
export function mailpitInboxUrl(i: ServiceInstance): string | null {
    const name = mailpitNameOf(i);
    return name === null ? null : `https://${name}/`;
}
