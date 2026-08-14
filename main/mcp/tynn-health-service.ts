import { readTynnMcpBearerToken, readTynnMcpUrl } from './agent-config';
import { defaultTynnProbeHttp, probeTynnMcp, type TynnHealth, type TynnProbeHttp } from './tynn-health';

/**
 * Owns WHEN the Tynn health probe runs and who hears about it.
 *
 * Two rules shape this, both about the fact that the endpoint being probed is
 * the user's PRODUCTION Tynn:
 *
 *   - **single-flight.** Genie can have several windows open on one workspace
 *     (a stage window, a remote window, the main one), and each will ask for
 *     health on open. They share one probe rather than each firing their own
 *     pair of requests at production.
 *   - **no polling.** Nothing in here schedules anything. A probe happens when
 *     a workspace is activated or when the user clicks the indicator, and the
 *     result is PUSHED via `onResult`. `setInterval` is banned in this codebase
 *     and there is no reason to want one: health only changes when the config
 *     or the server does, and both of those are events.
 *
 * The readers, the HTTP and the push are all injected, so the whole thing is
 * exercised without electron, without fs and without the network.
 */

export interface TynnHealthTarget {
    workspaceId: string;
    workspacePath: string;
    workspaceName: string;
}

export interface TynnHealthServiceDeps {
    readUrl: (workspacePath: string) => string | null;
    readToken: (workspacePath: string) => string | null;
    http: TynnProbeHttp;
    /** Push a finished result at whoever is listening (the windows). */
    onResult?: (health: TynnHealth) => void;
    now?: () => number;
}

export interface TynnHealthService {
    check(target: TynnHealthTarget): Promise<TynnHealth>;
    cached(workspaceId: string): TynnHealth | null;
    all(): Record<string, TynnHealth>;
    forget(workspaceId: string): void;
}

/** A config read that fails is "not configured", not a crash. */
function safeRead(read: (p: string) => string | null, workspacePath: string): string | null {
    try {
        return read(workspacePath);
    } catch {
        return null;
    }
}

export function createTynnHealthService(deps: TynnHealthServiceDeps): TynnHealthService {
    const cache = new Map<string, TynnHealth>();
    const inFlight = new Map<string, Promise<TynnHealth>>();

    async function run(target: TynnHealthTarget): Promise<TynnHealth> {
        const health = await probeTynnMcp({
            workspaceId: target.workspaceId,
            workspaceName: target.workspaceName,
            url: safeRead(deps.readUrl, target.workspacePath),
            token: safeRead(deps.readToken, target.workspacePath),
            http: deps.http,
            ...(deps.now ? { now: deps.now } : {}),
        });
        cache.set(target.workspaceId, health);
        try {
            deps.onResult?.(health);
        } catch {
            // A destroyed window or a throwing listener must not turn a
            // successful probe into a rejected promise for everyone else.
        }
        return health;
    }

    return {
        check(target) {
            const existing = inFlight.get(target.workspaceId);
            if (existing) return existing;
            const pending = run(target).finally(() => {
                inFlight.delete(target.workspaceId);
            });
            inFlight.set(target.workspaceId, pending);
            return pending;
        },
        cached(workspaceId) {
            return cache.get(workspaceId) ?? null;
        },
        all() {
            return Object.fromEntries(cache);
        },
        forget(workspaceId) {
            cache.delete(workspaceId);
        },
    };
}

/**
 * The app's instance. `onResult` is wired late (in ipc.ts, which owns the
 * windows) so this module never has to reach for electron.
 */
let pushResult: ((health: TynnHealth) => void) | null = null;

export const tynnHealthService = createTynnHealthService({
    readUrl: readTynnMcpUrl,
    readToken: readTynnMcpBearerToken,
    http: defaultTynnProbeHttp,
    onResult: (health) => pushResult?.(health),
});

/** The channel name every window listens on for a finished probe. */
export const TYNN_HEALTH_CHANNEL = 'tynn-health:update';

export function onTynnHealthResult(push: (health: TynnHealth) => void): void {
    pushResult = push;
}
