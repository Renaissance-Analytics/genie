import {
    deleteWorkspaceDevService,
    getWorkspaceDevServices,
    setWorkspaceDevService,
} from '../db';
import {
    DEFAULT_VERSIONS,
    SERVICE_ENGINES,
    engineKeyFor,
    engineSpecFor,
    isServiceEngine,
    resolveEngineVersion,
} from '../dev-server/services/catalog';
import { devServiceIdFor } from '../dev-server/services/services-config';
import { devServiceManager } from '../dev-server/services/service-manager';
import { runtimeInfo } from './dev-site-tools';
import { resolveAgentTarget } from './host-tools';
import type { DevServiceRow } from '../dev-server/services/service-manager';
import type { DevServiceConfig } from '../dev-server/services/services-config';
import type {
    DevServiceCatalogEntry,
    DevServiceInfo,
    ManageServiceRequest,
    ManageServiceResult,
} from './protocol';

/**
 * The HOST side of the `manageService` MCP tool (Tynn #234, P3) — the
 * agent-first administration surface for the Dev Server's backing services.
 *
 * The sibling of `dev-site-tools.ts`, and the same shape for the same reason:
 * `protocol.ts` stays pure, and the four kinds of I/O live here — resolving the
 * caller's workspace, persisting the definition, driving the service manager,
 * and reporting the container runtime's absence as DATA rather than as an
 * exception.
 *
 * ## Two behaviours worth naming
 *
 * **`add` finishes the job.** An agent asked for "a database" should not have to
 * make four calls. `add` with just `engine: 'postgres'` picks the default
 * version, stores the definition with a freshly minted credential, starts (or
 * ADOPTS) the shared engine, creates this workspace's database and role on it,
 * attaches the engine to this workspace's network, and reports the connection
 * surface plus the env keys now injected into the workspace's sites.
 *
 * **`stop` is a RELEASE, not a stop.** The engine is shared, so one workspace
 * cannot decide it goes away: releasing drops this workspace's hold, and the
 * container stops only if that was the last one. The result's `holders` count
 * is what makes that visible instead of surprising.
 */

// --- shaping ----------------------------------------------------------------

function toInfo(row: DevServiceRow): DevServiceInfo {
    return {
        id: row.serviceId,
        engine: row.engine,
        version: row.version,
        engineKey: row.engineKey,
        dedicated: row.dedicated,
        enabled: row.enabled,
        state: row.state,
        ...(row.ready === undefined ? {} : { ready: row.ready }),
        ...(row.holders === undefined ? {} : { holders: row.holders }),
        ...(row.endpoints ? { endpoints: row.endpoints } : {}),
        ...(row.namespace ? { namespace: row.namespace } : {}),
        ...(row.envKeys ? { envKeys: row.envKeys } : {}),
        ...(row.error ? { error: row.error } : {}),
    };
}

function catalogEntries(): DevServiceCatalogEntry[] {
    return SERVICE_ENGINES.map((engine) => {
        const spec = engineSpecFor(engine);
        return {
            engine,
            label: spec.label,
            summary: spec.summary,
            versions: [...spec.versions],
            defaultVersion: DEFAULT_VERSIONS[engine],
            shared: !spec.alwaysDedicated,
            provision: spec.provision,
        };
    });
}

// --- the tool ---------------------------------------------------------------

export async function manageServiceForMcp(
    terminalId: string,
    req: ManageServiceRequest,
): Promise<ManageServiceResult> {
    const runtime = await runtimeInfo();
    const bare = (error: string): ManageServiceResult => ({
        ok: false,
        error,
        services: [],
        runtime,
    });

    // The catalog is answerable with no workspace, no runtime and no manager —
    // it is how an agent finds out what it could ask for, and refusing it
    // because Docker is not running would be a dead end.
    if (req.action === 'catalog') {
        const { ws } = await resolveAgentTarget(terminalId, req.workspaceId);
        const manager = devServiceManager();
        return {
            ok: true,
            services: ws && manager ? manager.list(ws.id).map(toInfo) : [],
            catalog: catalogEntries(),
            runtime,
        };
    }

    const { decision, ws } = await resolveAgentTarget(terminalId, req.workspaceId);
    if (!decision.allowed || !ws) return bare(decision.reason);

    const manager = devServiceManager();
    if (!manager) {
        return bare(
            'The Genie Dev Server is not running in this process, so services cannot be managed here.',
        );
    }

    const services = () => manager.list(ws.id).map(toInfo);
    const fail = (error: string, extra: Partial<ManageServiceResult> = {}): ManageServiceResult => ({
        ok: false,
        error,
        services: services(),
        runtime,
        ...extra,
    });

    /** Every non-add action needs an id that is actually a service here. */
    const targetService = (): { serviceId: string; config: DevServiceConfig } | { error: string } => {
        const serviceId = req.id?.trim();
        if (!serviceId) {
            return { error: 'This action needs `id` — the service id from a `list` result.' };
        }
        const config = getWorkspaceDevServices(ws.id)[serviceId];
        if (!config) return { error: `No service "${serviceId}" in workspace ${ws.project_name}.` };
        return { serviceId, config };
    };

    try {
        switch (req.action) {
            case 'list':
            case 'status':
                return {
                    ok: true,
                    services: services(),
                    runtime,
                    ...(req.id ? { affectedId: req.id } : {}),
                };

            case 'add': {
                if (!isServiceEngine(req.engine)) {
                    return fail(
                        `add requires \`engine\` — one of ${SERVICE_ENGINES.join(', ')}. Run \`catalog\` to see what each one gives you.`,
                        { catalog: catalogEntries() },
                    );
                }
                const version = resolveEngineVersion(req.engine, req.version);
                if (!version) {
                    return fail(
                        `Genie has no image pinned for ${req.engine} ${req.version}. Known versions: ${engineSpecFor(
                            req.engine,
                        ).versions.join(', ')}.`,
                        { catalog: catalogEntries() },
                    );
                }
                if (req.engine === 'custom' && (!req.image || !req.port)) {
                    return fail(
                        'A `custom` service needs both `image` and `port` — the port it listens on INSIDE the container.',
                    );
                }

                const serviceId = setWorkspaceDevService(ws.id, {
                    engine: req.engine,
                    version,
                    ...(req.dedicated === undefined ? {} : { dedicated: req.dedicated }),
                    ...(req.image ? { image: req.image } : {}),
                    ...(req.port ? { port: req.port } : {}),
                    ...(req.env ? { env: req.env } : {}),
                    // Defined AND started unless the caller says otherwise: a
                    // service nobody asked to keep off is one they want running.
                    enabled: req.enabled !== false,
                });
                if (!serviceId) {
                    return fail(`Could not define a ${req.engine} service in this workspace.`);
                }

                if (req.enabled === false) {
                    return { ok: true, services: services(), affectedId: serviceId, runtime };
                }
                const status = await manager.acquire(ws.id, serviceId);
                return {
                    ok: status.state !== 'failed',
                    ...(status.error ? { error: status.error } : {}),
                    services: services(),
                    affectedId: serviceId,
                    runtime,
                };
            }

            case 'start': {
                const target = targetService();
                if ('error' in target) return fail(target.error);
                // Starting is also the act of enabling: otherwise the next boot
                // reconcile would quietly release it again.
                if (!target.config.enabled) {
                    setWorkspaceDevService(ws.id, {
                        engine: target.config.engine,
                        version: target.config.version,
                        enabled: true,
                    });
                }
                const status = await manager.acquire(ws.id, target.serviceId);
                return {
                    ok: status.state !== 'failed',
                    ...(status.error ? { error: status.error } : {}),
                    services: services(),
                    affectedId: target.serviceId,
                    runtime,
                };
            }

            case 'stop': {
                const target = targetService();
                if ('error' in target) return fail(target.error);
                // A RELEASE. The engine is shared, so this workspace letting go
                // stops the container only if it was the last holder.
                await manager.release(ws.id, target.serviceId);
                setWorkspaceDevService(ws.id, {
                    engine: target.config.engine,
                    version: target.config.version,
                    enabled: false,
                });
                return { ok: true, services: services(), affectedId: target.serviceId, runtime };
            }

            case 'logs': {
                const target = targetService();
                if ('error' in target) return fail(target.error);
                return {
                    ok: true,
                    services: services(),
                    affectedId: target.serviceId,
                    logs: await manager.logs(target.serviceId, req.tail),
                    runtime,
                };
            }

            case 'connection': {
                const target = targetService();
                if ('error' in target) return fail(target.error);
                return {
                    ok: true,
                    services: services(),
                    affectedId: target.serviceId,
                    // The whole point of the action: what a site container is
                    // actually given, so an agent can reason about the app's
                    // config without guessing at key names.
                    env: manager.envFor(ws.id),
                    runtime,
                };
            }

            case 'dedicated': {
                const target = targetService();
                if ('error' in target) return fail(target.error);
                const dedicated = req.dedicated !== false;
                if (target.config.dedicated === dedicated) {
                    return { ok: true, services: services(), affectedId: target.serviceId, runtime };
                }
                // Release from the CURRENT engine first — otherwise this
                // workspace stays counted as a holder of a container it no
                // longer uses, and that container never stops.
                await manager.release(ws.id, target.serviceId);
                setWorkspaceDevService(ws.id, {
                    engine: target.config.engine,
                    version: target.config.version,
                    dedicated,
                });
                const status = await manager.acquire(ws.id, target.serviceId);
                return {
                    ok: status.state !== 'failed',
                    // NOTE: shared and dedicated engines have SEPARATE data
                    // volumes, so what comes back is a freshly provisioned,
                    // EMPTY database — not a moved one. The tool description
                    // says so; there is nothing to migrate here that would not
                    // be a silent guess about which side is authoritative.
                    ...(status.error ? { error: status.error } : {}),
                    services: services(),
                    affectedId: target.serviceId,
                    runtime,
                };
            }

            case 'remove': {
                const target = targetService();
                if ('error' in target) return fail(target.error);
                // Release FIRST: forgetting the definition while the engine is
                // held would leave this workspace counted as a holder forever.
                await manager.remove(ws.id, target.serviceId, {
                    ...(req.purge ? { purge: true } : {}),
                });
                deleteWorkspaceDevService(ws.id, target.serviceId);
                return { ok: true, services: services(), affectedId: target.serviceId, runtime };
            }

            default:
                return fail(`Unknown action ${String(req.action)}.`);
        }
    } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
    }
}

/** Re-exported so a caller can build the same id the tool reports. */
export { devServiceIdFor, engineKeyFor };
