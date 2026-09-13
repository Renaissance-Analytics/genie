import type { EndpointRoute } from '../mcp/terminal-resolution';
import type { ShuttleRoutes } from './listener';

/**
 * WHICH TOKEN IS WHICH ENDPOINT, AND WHICH TERMINALS A WORKSPACE HAS.
 *
 * genie#346 Phase 1, `.ai/plans/genie-mcp-shuttle-spec.md` §3.2 ("the shuttle is
 * authoritative for routing") and §4.3 (terminal resolution needs no Genie
 * round-trip). Every `.mcp.json` URL carries a token; while Genie is being replaced,
 * or after the shuttle restarts with no Genie attached, that URL must still resolve,
 * or the listener 404s every agent at exactly the moment it exists to keep them
 * connected. So the publisher sends its topology, it is persisted, and a cold boot
 * reads it back.
 *
 * A malformed topology is refused WHOLE and the last good one kept. An empty one is
 * accepted: a Genie with nothing open has nothing to route, and keeping stale
 * endpoints would route agents to workspaces that are gone.
 *
 * Pure apart from the injected read/write.
 */

export interface ShuttleTopology {
    /** URL token → what it addresses. */
    endpoints: Record<string, EndpointRoute>;
    /** Workspace id → its terminal ids, as Genie last saw them. */
    workspaces: Record<string, string[]>;
}

export interface TopologyPersistence {
    read(): string | null;
    write(body: string): void;
}

export interface TopologyStore {
    /** Load the last persisted topology. Missing or corrupt is "none". */
    boot(): void;
    /** Replace the topology. False, and nothing changed, when it is malformed. */
    publish(topology: ShuttleTopology): boolean;
    /** The listener's view of it. */
    routes(): ShuttleRoutes;
}

/** The characters the listener routes on (`/mcp/<token>`). */
const TOKEN = /^[A-Za-z0-9_-]+$/;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function isRoute(v: unknown): v is EndpointRoute {
    if (!isRecord(v)) return false;
    if (v.kind === 'workspace') return typeof v.workspaceId === 'string' && v.workspaceId !== '';
    if (v.kind === 'terminal') return typeof v.terminalId === 'string' && v.terminalId !== '';
    return false;
}

export function isTopology(v: unknown): v is ShuttleTopology {
    if (!isRecord(v) || !isRecord(v.endpoints) || !isRecord(v.workspaces)) return false;
    for (const [token, route] of Object.entries(v.endpoints)) {
        if (!TOKEN.test(token) || !isRoute(route)) return false;
    }
    for (const terminals of Object.values(v.workspaces)) {
        if (!Array.isArray(terminals) || !terminals.every((t) => typeof t === 'string')) return false;
    }
    return true;
}

export function createTopologyStore(disk: TopologyPersistence): TopologyStore {
    // Null-prototype copies, so a lookup can never find an inherited key.
    let endpoints: Record<string, EndpointRoute> = Object.create(null);
    let workspaces: Record<string, string[]> = Object.create(null);

    const adopt = (t: ShuttleTopology) => {
        endpoints = Object.assign(Object.create(null), t.endpoints);
        workspaces = Object.assign(Object.create(null), t.workspaces);
    };

    const routes: ShuttleRoutes = {
        endpoint: (token) => (own(endpoints, token) ? endpoints[token]! : null),
        workspaceTerminals: (workspaceId) => (own(workspaces, workspaceId) ? [...workspaces[workspaceId]!] : []),
    };

    return {
        boot() {
            let raw: string | null = null;
            try {
                raw = disk.read();
            } catch {
                raw = null;
            }
            if (!raw) return;
            try {
                const parsed: unknown = JSON.parse(raw);
                if (isTopology(parsed)) adopt(parsed);
            } catch {
                /* a torn file is no topology, not a crash */
            }
        },

        publish(topology) {
            if (!isTopology(topology)) return false;
            adopt(topology);
            try {
                disk.write(JSON.stringify(topology));
            } catch {
                // Routing the live topology matters more than persisting it; a failed
                // write only makes the next cold boot staler.
            }
            return true;
        },

        routes: () => routes,
    };
}
