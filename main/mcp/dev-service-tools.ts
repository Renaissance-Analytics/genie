import {
    deleteWorkspaceDevService,
    getWorkspaceDevServices,
    listTerminalSpecs,
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
import { terminalServiceEnv } from '../dev-server/services/env-wiring';
import {
    staleServiceTerminals,
    staleTerminalNote,
} from '../dev-server/services/stale-terminal-env';
import { isTerminalLive } from '../terminal/ipc';
import { workspaceIdOfSpec } from '../terminal/workspace-of-terminal';
import { runtimeInfo } from './dev-site-tools';
import { callerSeesWholeWorkstation, resolveAgentTarget } from './host-tools';
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

/**
 * The open terminals in a workspace that are still dialling the OLD service
 * address, said in the one place somebody is already asking (genie#222).
 *
 * A managed engine's published host port moves when its container is recreated,
 * and a pty's environment cannot be rewritten after it starts — so every
 * terminal that was already open keeps the `PG*` / `MYSQL_*` it was spawned
 * with. The issue's residual is not that this happens (it is a property of
 * ptys), it is that Genie held both values and said NOTHING: `onPortMoved`
 * wrote to `console.warn`, which no user and no agent reads.
 *
 * The live side is narrowed through `terminalServiceEnv` so it is compared in
 * exactly the form a terminal is handed, not the fuller set a site gets.
 *
 * Returns null when nothing is stale — the overwhelmingly common case, and a
 * note that fires every time is a note nobody reads.
 */
function staleTerminalNoteFor(workspaceId: string): string | null {
    const manager = devServiceManager();
    if (!manager) return null;
    const open = listTerminalSpecs()
        .filter((spec) => workspaceIdOfSpec(spec) === workspaceId)
        .map((spec) => spec.id)
        .filter((id) => isTerminalLive(id));
    if (open.length === 0) return null;
    return staleTerminalNote(
        staleServiceTerminals(terminalServiceEnv(manager.hostEnvFor(workspaceId)), open),
    );
}

/**
 * WHO is reading an `inventory`, and therefore how much of the machine the
 * answer may describe (genie#345).
 *
 * The machine-level row carries every workspace's name, id and container. That
 * is the right answer for the human at the workstation Services page and for
 * the workstation operator; it is the wrong one for an agent, which should
 * never be shown a resource it can neither reach nor act on. So the view is
 * stated explicitly at every call site rather than defaulted — a new caller has
 * to decide, instead of inheriting the wider answer by omission.
 */
export interface InventoryView {
    /** The workspace doing the reading. `null` when the reader is not acting AS
     *  a workspace at all — Genie's own workstation surfaces, and the owner's
     *  remote control of their own machine. */
    workspaceId: string | null;
    /** May they see the whole machine, other workspaces named? True for the
     *  workstation operator (see `callerSeesWholeWorkstation`) and for Genie's
     *  own human surfaces; false for an agent in a workspace. */
    wholeWorkstation: boolean;
}

/**
 * One MACHINE-level engine row, shaped for the reader.
 *
 * The three independent facts (`installed`, `state`, `holders`) are the point
 * and reach everyone — without them an agent stops an engine five other
 * workspaces are using and reports success. The workspace NAMES are not: the
 * question that hazard raises is *"is anyone else on this?"*, which
 * `sharedWithOthers` answers without saying who. Identity is not needed to make
 * the safe decision, only the unsafe one.
 */
function toEngineInfo(row: EngineInventoryRow, view: InventoryView): DevServiceEngineInfo {
    // The reader's OWN id is not a disclosure; anyone else's is.
    const ownerIsReader = Boolean(
        row.ownerWorkspaceId && row.ownerWorkspaceId === view.workspaceId,
    );
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
        ...(row.ownerWorkspaceId && (view.wholeWorkstation || ownerIsReader)
            ? { ownerWorkspaceId: row.ownerWorkspaceId }
            : {}),
        holders: row.holders,
        configured: row.configured,
        sharedWithOthers: row.workspaceIds.some((id) => id !== view.workspaceId),
        ...(view.wholeWorkstation ? { workspaces: row.workspaces } : {}),
    };
}

/**
 * The engines this reader may be told about.
 *
 * A DEDICATED engine belonging to another workspace is dropped whole rather
 * than redacted, because there is nothing left to redact: its `recordKey` is
 * `<engineKey>@<workspaceId>` and its container is named after that workspace —
 * the row IS the identity. It is also unreachable: no action here can start,
 * stop or remove somebody else's container. A shared engine stays, because a
 * shared engine is exactly what this reader might acquire or release.
 */
function enginesFor(rows: EngineInventoryRow[], view: InventoryView): DevServiceEngineInfo[] {
    return rows
        .filter(
            (row) =>
                view.wholeWorkstation ||
                !row.dedicated ||
                row.ownerWorkspaceId === view.workspaceId,
        )
        .map((row) => toEngineInfo(row, view));
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


export async function manageServiceForMcp(
    terminalId: string,
    req: ManageServiceRequest,
): Promise<ManageServiceResult> {
    const { decision, ws } = await resolveAgentTarget(terminalId, req.workspaceId);
    // Read off the CALLER's terminal, never off the request: a `workspaceId` in
    // the arguments must not be able to buy a wider view of the machine.
    const view: InventoryView = {
        workspaceId: ws?.id ?? null,
        wholeWorkstation: callerSeesWholeWorkstation(terminalId),
    };
    // `catalog` alone is answerable with no workspace: it is STATIC — what this
    // build could run — so it is a property of the machine and names nobody.
    // Refusing it because the caller's terminal could not be resolved would be a
    // dead end with nothing to protect.
    if (req.action === 'catalog') return runManageService(ws ?? null, req, view);
    // `inventory` used to be the second exception, which made a machine-wide
    // read the ONE answer an unauthorized caller could get (genie#345). It now
    // goes through the same gate as everything else — an unattached caller has
    // no workspace to scope the answer to, and nothing it could act on — with
    // ONE deliberate exception: the workstation operator. The OS Agent's
    // terminal is `workspace_id: null` on purpose, because the machine IS its
    // scope; denying it the machine view would close the hole by removing the
    // feature from the one caller it was built for.
    if (req.action === 'inventory' && view.wholeWorkstation) {
        return runManageService(ws ?? null, req, view);
    }
    if (!decision.allowed || !ws) {
        return { ok: false, error: decision.reason, services: [], runtime: await runtimeInfo() };
    }
    return runManageService(ws, req, view);
}

/**
 * The tool itself, against an ALREADY-RESOLVED workspace.
 *
 * `null` is accepted for `catalog` alone — see the header on that action. Every
 * other action refuses it, because a service is defined ON a workspace.
 *
 * `view` says how much of the MACHINE the `inventory` answer may describe. It
 * has no default: the two human surfaces (the desktop's IPC, the owner's remote
 * control) pass the whole-workstation view deliberately, and an agent's is
 * narrowed by {@link manageServiceForMcp}. See {@link InventoryView}.
 */
export async function runManageService(
    ws: DevServiceTarget | null,
    req: ManageServiceRequest,
    view: InventoryView,
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

    // MACHINE-level: a shared engine belongs to no workspace, so a purely
    // per-workspace answer would be the wrong shape. This is the read a human
    // has had as a settings page since the workstation Services page shipped;
    // without it an agent can stop an engine five other workspaces are using and
    // report success. `view` decides how much of the machine comes back —
    // everyone gets the counts that make a release honest, only the workstation
    // sees who those holders are.
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
                engines: enginesFor(await manager.inventory(), view),
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
            case 'status': {
                // Re-read the LIVE published ports first. An engine's publication
                // is ephemeral, the endpoints were captured once at acquire, and
                // this is the tool an agent calls to learn how to connect — an
                // address nothing is listening on is worse than no answer.
                await manager.refresh().catch(() => {});
                // …and, having re-read them, say which open terminals were handed
                // an EARLIER answer and cannot pick this one up (genie#222).
                const stale = staleTerminalNoteFor(ws.id);
                return {
                    ok: true,
                    services: services(),
                    runtime,
                    ...(req.id ? { affectedId: req.id } : {}),
                    ...(stale ? { note: stale } : {}),
                };
            }

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
                const stale = staleTerminalNoteFor(ws.id);
                return {
                    ok: true,
                    services: services(),
                    affectedId: target.serviceId,
                    // The whole point of the action: what a site container is
                    // actually given, so an agent can reason about the app's
                    // config without guessing at key names.
                    env: manager.envFor(ws.id),
                    runtime,
                    // …and, when it differs, WHICH open terminals were handed an
                    // earlier answer to this same question (genie#222).
                    ...(stale ? { note: stale } : {}),
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
