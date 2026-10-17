import { chooseEngines, type ServiceInstance } from '../core/services.js';
import { WEBSOCKETS_HOST } from '../core/websockets.js';

/**
 * THE FRONT DOOR'S ROUTE FOR THE SHARED WEBSOCKETS SERVER: ONE, at its one address (core/websockets.ts WEBSOCKETS_HOST),
 * to the engine's loopback port — present while any workspace uses that engine (it is the CHOSEN one for some workspace;
 * a workspace that detached is not counted). Served with Genie's certificate beside the sites, and in the hosts file's
 * names (main/compose.ts). Workspaces are kept apart on the server by their apps, not by addresses (the owner, 2026-10-17).
 */
export function websocketRoutes(instances: readonly ServiceInstance[]): { host: string; target: string }[] {
    for (const i of instances) {
        if (i.engine !== 'websockets' || i.scope.kind !== 'shared' || i.slices === undefined) continue;
        const used = Object.keys(i.slices).some((workspaceId) => chooseEngines(instances, workspaceId).find((c) => c.kind === 'websockets')?.chosen?.id === i.id);
        if (used) return [{ host: WEBSOCKETS_HOST, target: `127.0.0.1:${i.publishedPort}` }];
    }
    return [];
}
