import { chooseEngines, type ServiceInstance } from '../core/services.js';
import { workspaceDnsName } from '../core/v1-services.js';

/**
 * THE SHARED WEBSOCKETS SERVER, FOR AN HTTPS SITE'S BROWSER (moic, 2026-10-16). pusher-js on an https page always uses
 * TLS (useTLS = forceTLS || location.protocol === 'https:'), so a browser handed the loopback address dialled
 * wss://127.0.0.1:<port>, where nothing speaks TLS, and every https site's live updates fell back to polling. Genie 1
 * served the engine through the front door at this name (host-core/hosting.ts), and a `.env` written then names it.
 *
 * Main-process only: the name hashes a long workspace id with node:crypto (v1-services.ts `v1WorkspaceSlug`), which the
 * renderer cannot bundle — core/services.ts is given the namer, never imports it.
 */
export function websocketBrowserHost(workspaceId: string): string {
    return `websockets.${workspaceDnsName(workspaceId)}.gen`;
}

/**
 * The front door's routes for it: one per workspace whose WebSockets engine it is (CHOSEN — a workspace that detached,
 * or uses another, gets none), at that name, to the engine's loopback port. Served with Genie's certificate beside the
 * sites, and in the hosts file's names (main/compose.ts).
 */
export function websocketRoutes(instances: readonly ServiceInstance[]): { host: string; target: string }[] {
    const routes: { host: string; target: string }[] = [];
    for (const i of instances) {
        if (i.engine !== 'websockets' || i.scope.kind !== 'shared' || i.slices === undefined) continue;
        for (const workspaceId of Object.keys(i.slices)) {
            const chosen = chooseEngines(instances, workspaceId).find((c) => c.kind === 'websockets')?.chosen;
            if (chosen?.id === i.id) routes.push({ host: websocketBrowserHost(workspaceId), target: `127.0.0.1:${i.publishedPort}` });
        }
    }
    return routes;
}
