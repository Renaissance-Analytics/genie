import {
    deleteWorkspaceDevService,
    getWorkspaceDevServices,
    setWorkspaceDevService,
    setWorkspaceDevServices,
} from '../db';
import {
    DEFAULT_VERSIONS,
    SERVICE_ENGINES,
    engineKeyFor,
    engineSpecFor,
    isServiceEngine,
    resolveEngineVersion,
} from '../dev-server/services/catalog';
import {
    devServiceIdFor,
    setActiveService,
    switchActiveWarning,
} from '../dev-server/services/services-config';
import { devServiceManager } from '../dev-server/services/service-manager';
import { runtimeInfo } from './dev-site-tools';
import { resolveAgentTarget } from './host-tools';
import { terminalServiceEnvFor } from '../db';
import { terminalServiceEnv } from '../dev-server/services/env-wiring';
import { driftNotice, serviceEnvDrift } from '../dev-server/services/env-drift';
import type { DevServiceRow } from '../dev-server/services/service-manager';
import type { EngineInventoryRow } from '../dev-server/services/inventory';
import type { DevServiceConfig } from '../dev-server/services/services-config';
import type {
    DevServiceCatalogEntry,
    DevServiceEngineInfo,
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
 *
 * ## The human UX runs THIS code (P4)
 *
 * {@link runManageService} is the tool with the agent's authorization lifted
 * off the front, so the Site Manager's Services tab drives the identical verbs
 * rather than a parallel implementation of them. See `dev-site-tools.ts`.
 */

// --- shaping ----------------------------------------------------------------

function toInfo(row: DevServiceRow): DevServiceInfo {
    return {
        id: row.serviceId,
        engine: row.engine,
        version: row.version,
        engineKey: row.engineKey,
        dedicated: row.dedicated,
        ...(row.active ? { active: true } : {}),
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

/** One MACHINE-level engine row, as `inventory` reports it. Passed through
 *  whole: the three independent facts (`installed`, `state`, `holders`) and the
 *  workspace NAMES are the entire point — see `services/inventory.ts`. */
function toEngineInfo(row: EngineInventoryRow): DevServiceEngineInfo {
    return {
        recordKey: row.recordKey,
        engineKey: row.engineKey,
        engine: row.engine,
        version: row.version,
        label: row.label,
        image: row.image,
        containerName: row.containerName,
        installed: row.installed,
        state: row.state,
        ...(row.containerId ? { containerId: row.containerId } : {}),
        dedicated: row.dedicated,
        ...(row.ownerWorkspaceId ? { ownerWorkspaceId: row.ownerWorkspaceId } : {}),
        holders: row.holders,
        configured: row.configured,
        workspaces: row.workspaces,
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

/** The workspace fields the tool reads. Narrower than a `WorkspaceRow` so the
 *  UX can call this without pretending to be an agent. */
export interface DevServiceTarget {
    id: string;
    project_name: string;
}


/**
 * Is the CALLING terminal carrying a service env the workspace has moved on from?
 *
 * Attached to the read actions because those are what somebody calls WHEN a
 * connection is already failing — which is the moment "your shell is the problem"
 * explains everything. Best effort: a bookkeeping gap must never turn a working
 * answer into an error.
 */
function staleEnvFor(
    terminalId: string | undefined,
    workspaceId: string,
    manager: { hostEnvFor: (id: string) => Record<string, string> },
): { staleTerminalEnv?: string } {
    if (!terminalId) return {};
    try {
        const baked = terminalServiceEnvFor(terminalId);
        if (Object.keys(baked).length === 0) return {};
        const live = terminalServiceEnv(manager.hostEnvFor(workspaceId));
        const notice = driftNotice(serviceEnvDrift(baked, live));
        return notice ? { staleTerminalEnv: notice } : {};
    } catch {
        return {};
    }
}

export async function manageServiceForMcp(
    terminalId: string,
    req: ManageServiceRequest,
): Promise<ManageServiceResult> {
    // `catalog` and `inventory` are answerable with no workspace — one says what
    // could be run here and the other says what IS running on the machine, and
    // neither is a property of a workspace. Refusing them because the caller's
    // terminal could not be resolved would be a dead end.
    const { decision, ws } = await resolveAgentTarget(terminalId, req.workspaceId);
    if (req.action === 'catalog' || req.action === 'inventory') {
        return runManageService(ws ?? null, req, terminalId);
    }
    if (!decision.allowed || !ws) {
        return { ok: false, error: decision.reason, services: [], runtime: await runtimeInfo() };
    }
    return runManageService(ws, req, terminalId);
}

/**
 * The tool itself, against an ALREADY-RESOLVED workspace.
 *
 * `null` is accepted for `catalog` alone — see the header on that action. Every
 * other action refuses it, because a service is defined ON a workspace.
 */
export async function runManageService(
    ws: DevServiceTarget | null,
    req: ManageServiceRequest,
    /** The CALLING terminal, when there is one — used only to notice that its
     *  baked-in service env has gone stale (genie#222). A host route has none,
     *  and simply gets no notice. */
    callerTerminalId?: string,
): Promise<ManageServiceResult> {
    const runtime = await runtimeInfo();
    const bare = (error: string): ManageServiceResult => ({
        ok: false,
        error,
        services: [],
        runtime,
    });

    if (req.action === 'catalog') {
        const manager = devServiceManager();
        return {
            ok: true,
            services: ws && manager ? manager.list(ws.id).map(toInfo) : [],
            catalog: catalogEntries(),
            runtime,
        };
    }

    // MACHINE-level, like `catalog`: a shared engine belongs to no workspace, so
    // requiring one to ask about it would be asking the wrong question. This is
    // the read a human has had as a settings page since the workstation Services
    // page shipped; without it an agent can stop an engine five other workspaces
    // are using and report success.
    if (req.action === 'inventory') {
        const manager = devServiceManager();
        if (!manager) {
            return bare(
                'The Genie Hosting Manager is not running in this process, so the workstation inventory cannot be read here.',
            );
        }
        try {
            return {
                ok: true,
                services: ws ? manager.list(ws.id).map(toInfo) : [],
                engines: (await manager.inventory()).map(toEngineInfo),
                runtime,
            };
        } catch (e) {
            return bare(
                `The workstation inventory could not be read: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            );
        }
    }

    if (!ws) return bare('This action needs a workspace.');

    const manager = devServiceManager();
    if (!manager) {
        return bare(
            'The Genie Hosting Manager is not running in this process, so services cannot be managed here.',
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
                // Re-read the LIVE published ports first. An engine's publication
                // is ephemeral, the endpoints were captured once at acquire, and
                // this is the tool an agent calls to learn how to connect — an
                // address nothing is listening on is worse than no answer.
                await manager.refresh().catch(() => {});
                return {
                    ok: true,
                    services: services(),
                    runtime,
                    ...(req.id ? { affectedId: req.id } : {}),
                    ...staleEnvFor(callerTerminalId, ws.id, manager),
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
                // Same reason as `list`/`status`, and more so: this one exists to
                // hand back an address somebody will dial.
                await manager.refresh().catch(() => {});
                const target = targetService();
                if ('error' in target) return fail(target.error);
                return {
                    ok: true,
                    services: services(),
                    affectedId: target.serviceId,
                    ...staleEnvFor(callerTerminalId, ws.id, manager),
                    // The whole point of the action: what a site container is
                    // actually given, so an agent can reason about the app's
                    // config without guessing at key names.
                    env: manager.envFor(ws.id),
                    runtime,
                };
            }

            case 'active': {
                // Which VERSION this workspace's apps connect to, when it holds
                // more than one major of an engine (#242 P3). Every single-valued
                // name (DATABASE_URL, DB_*, PG*) follows this choice; the other
                // version stays a reachable container but contributes no
                // environment, so the two can no longer contradict each other.
                const target = targetService();
                if ('error' in target) return fail(target.error);
                const configs = getWorkspaceDevServices(ws.id);
                const current = Object.values(configs).find(
                    (c) => c.engine === target.config.engine && c.active,
                );
                if (target.config.active) {
                    return { ok: true, services: services(), affectedId: target.serviceId, runtime };
                }
                setWorkspaceDevServices(ws.id, setActiveService(configs, target.serviceId));
                // Re-acquire so the consumers' environment is rebuilt around the
                // new choice; a config change nobody re-read would leave running
                // sites pointed at the old version until their next restart.
                const status = await manager.acquire(ws.id, target.serviceId);
                const warning = switchActiveWarning(current, target.config);
                return {
                    ok: status.state !== 'failed',
                    // The data does NOT come along — each version keeps its own
                    // volume, so the newly-active one starts empty. Said plainly
                    // rather than discovered from an application with no rows.
                    ...(status.error ? { error: status.error } : warning ? { note: warning } : {}),
                    services: services(),
                    affectedId: target.serviceId,
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
                const removal = await manager.remove(ws.id, target.serviceId, {
                    ...(req.purge ? { purge: true } : {}),
                });
                deleteWorkspaceDevService(ws.id, target.serviceId);
                return {
                    ok: true,
                    services: services(),
                    affectedId: target.serviceId,
                    // The service definition IS gone — that part succeeded — but
                    // a declined purge left the data exactly where it was, and
                    // saying nothing would read as "the data is gone too".
                    ...(removal.declined ? { note: removal.declined } : {}),
                    runtime,
                };
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
