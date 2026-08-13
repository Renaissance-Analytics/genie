import {
    ROLE_LABEL,
    SERVICE_LABEL,
    SERVICE_ROLE,
    SHARED_SERVICES_NETWORK,
    WORKSPACE_LABEL,
    serviceContainerNameFor,
    serviceVolumeNameFor,
} from '../argv';
import {
    engineKeyFor,
    engineSpecFor,
    parseEngineKey,
    resolveEngineVersion,
    workspaceDnsName,
    workspaceSqlIdentifier,
} from './catalog';
import { serviceEnv } from './env-wiring';
import { buildEngineInventory, inventoryImages } from './inventory';
import { provisionSteps, runProvisionSteps } from './provision';
import type { EngineSpec, ServiceEngine } from './catalog';
import type { EngineInventoryRow } from './inventory';
import type { ProvisionedService } from './env-wiring';
import type { EngineAdmin, WorkspaceSlice } from './provision';
import type { DevServiceConfig, DevServices } from './services-config';
import type { ContainerRuntime, ContainerState, RuntimeDetection } from '../container-runtime';
import type { DevWorkspace } from '../site-manager';
import type { ImagePullConsent } from '../workspace-sandbox';

/**
 * The DEV SERVICE MANAGER (Tynn #234, P3) — the owner's service model, running.
 *
 * ## What makes this different from the site manager
 *
 * A site container belongs to one workspace and dies with it. A service ENGINE
 * is shared: one `postgres:16` container serves every workspace pinned to
 * Postgres 16, each with its own database, role and credentials. That single
 * difference produces everything unusual in this file.
 *
 * **The container is keyed by (engine, version), not by workspace.** So the
 * second workspace to ask for Postgres 16 ADOPTS the first's container instead
 * of starting a second copy — the same derived-name trick the sandbox uses,
 * doing the deduplication for free. A user with twenty PG16 workspaces runs one
 * postgres, which is the whole point.
 *
 * **It belongs to no workspace, and must not be labelled with one.**
 * `teardownWorkspaceSandbox` removes exactly what carries `genie.workspace`, so
 * a shared engine tagged with whichever workspace happened to start it would be
 * destroyed when that workspace was removed — taking every other workspace's
 * data with it. It carries `genie.service` instead, and `psServices` is how it
 * is found.
 *
 * **Reachable from every consumer, visible to none of the others.** The engine
 * lives on its own `genie-services` network and is ATTACHED to each consuming
 * workspace's isolated network on acquire, detached on release. A container may
 * be on many networks; the workspaces still cannot see each other, because the
 * engine is the only node they have in common — and inside it, the database and
 * role boundary does the rest.
 *
 * **Reference counted.** Start on first acquire, stop on last release. Not on
 * the second-to-last; that is the bug this exists to prevent.
 *
 * **Provision on EVERY acquire.** Not once at creation. A workspace that
 * reopens, a Genie that restarts, an engine recreated after a version bump —
 * all land here again, and Redis in particular has no choice, because its ACLs
 * live in memory and are gone after a restart. Every step is written to
 * converge (`provision.ts`).
 *
 * Failures are STATUSES, never exceptions — same house rule as
 * `../site-manager.ts`, and for the same reason: an MCP agent is driving this,
 * and an exception crossing that boundary becomes a tool error with no state.
 */

// --- what a caller sees -----------------------------------------------------

export type DevServiceState = 'running' | 'stopped' | 'failed';

/** One reachable surface of a service, from BOTH sides of the boundary. */
export interface ServiceEndpoint {
    /** `postgres`, `s3`, `smtp`, … */
    name: string;
    kind: 'http' | 'tcp';
    /** How a container on the workspace's network reaches it: the engine's
     *  container name, on its real port. */
    host: string;
    port: number;
    /** How THIS MACHINE reaches it — a person, an agent, `psql`. Absent when
     *  the runtime published nothing. */
    hostPort?: number;
    /** The host surface, ready to paste. */
    localAddress?: string;
}

export interface DevServiceStatus {
    serviceId: string;
    workspaceId: string;
    engine: ServiceEngine;
    version: string;
    /** The `<engine>-<version>` key — the SHARING unit. */
    engineKey: string;
    dedicated: boolean;
    state: DevServiceState;
    /** True when the engine answered its own readiness check. */
    ready?: boolean;
    containerId?: string;
    containerName?: string;
    /** How many workspaces currently hold this engine. `1` on a dedicated one. */
    holders?: number;
    endpoints?: ServiceEndpoint[];
    /** The per-workspace names carved out of the engine. */
    namespace?: { identifier: string; dnsName: string };
    /** The env keys injected into this workspace's site containers. */
    envKeys?: string[];
    error?: string;
}

/** One configured service plus whatever is currently true about it. */
export interface DevServiceRow extends DevServiceStatus {
    enabled: boolean;
}

// --- deps -------------------------------------------------------------------

export interface ResolvedRuntimeLike {
    runtime: ContainerRuntime | null;
    detection: RuntimeDetection;
}

/** What the manager needs to know an engine's own superuser credential. */
export interface EngineAdminRequest {
    /** Identifies the CONTAINER: `postgres-16`, or `postgres-16@<workspaceId>`
     *  for a dedicated one. */
    recordKey: string;
    engine: ServiceEngine;
    version: string;
    /** Non-null only for a dedicated engine. */
    workspaceId: string | null;
    adminUser: string;
}

export interface DevServiceManagerDeps {
    /** Which runtime, and is it usable. Called per action, so installing Docker
     *  mid-session works without a restart. */
    resolveRuntime: () => Promise<ResolvedRuntimeLike>;
    listWorkspaces: () => DevWorkspace[];
    devServicesFor: (workspaceId: string) => DevServices;
    /**
     * The engine's own superuser credential, minted once per CONTAINER and then
     * stable.
     *
     * Machine-scoped rather than per-workspace, because the container is: a
     * shared engine's admin password cannot live in one workspace's row. And it
     * must never be regenerated — every one of these images bakes the
     * credential into its data directory on first init and ignores the env
     * afterwards, so a new password would simply lock Genie out of the engine
     * it created.
     */
    engineAdmin: (req: EngineAdminRequest) => EngineAdmin;
    /** Consent for fetching a missing engine image. ABSENT MEANS NO PULL. */
    confirmImagePull?: (req: ImagePullConsent) => Promise<boolean> | boolean;
    onImagePullProgress?: (chunk: string) => void;
    /** Host-side readiness probe, for an engine with no in-container check. */
    probeReady?: (req: { port: number; kind: 'http' | 'tcp'; timeoutMs: number }) => Promise<boolean>;
    readyTimeoutMs?: number;
    /** Fired whenever the live set changes, so the UX and other agents follow. */
    onChanged?: () => void;
}

/**
 * Why a host-native site's service env is what it is — the diagnostic behind an
 * EMPTY {@link DevServiceManager.hostEnvFor}. `enabled` services that are `live`
 * but have `withHostPort === 0` (every one in `missingHostPort`) is the "up but
 * DB-less" state: the app would fall back to its repo `.env` and fail to reach
 * the managed DB with no signal — this report is that signal.
 */
export interface HostEnvReport {
    /** The host-form env — identical to {@link DevServiceManager.hostEnvFor}. */
    env: Record<string, string>;
    /** Services the workspace has ENABLED in config. */
    enabled: number;
    /** Of those, how many are LIVE in this process right now. */
    live: number;
    /** Of the live ones, how many expose a published loopback port (reachable
     *  from the host, so they contribute env). */
    withHostPort: number;
    /** The engines that are live but publish NO host port — the ones that make
     *  the env come up short. */
    missingHostPort: string[];
}

export interface DevServiceManager {
    /** Ensure the engine is up, this workspace's slice provisioned, and the
     *  engine attached to its network. Never throws. */
    acquire(workspaceId: string, serviceId: string): Promise<DevServiceStatus>;
    /** Let go. Detaches, and stops the engine when this was the last holder. */
    release(workspaceId: string, serviceId: string): Promise<void>;
    /**
     * Re-acquire the engines that are ALREADY running — never start one.
     *
     * An engine carries `restart: unless-stopped`, so after a reboot it is up
     * with ZERO known holders. That is not a cosmetic gap: the first workspace
     * that acquires it afterwards becomes its only holder, and its release then
     * stops an engine every other workspace is still using. Adoption also
     * RE-PROVISIONS, which is not optional — a Redis ACL user lives in memory
     * and is gone the moment the container restarts.
     *
     * Engines that are NOT running stay stopped: boot must not pull images or
     * start databases for workspaces nobody has opened.
     */
    adopt(): Promise<void>;
    /** Configured services + live state. All workspaces, or one. */
    list(workspaceId?: string): DevServiceRow[];
    /** A bounded log tail for the engine behind one service. Never throws. */
    logs(serviceId: string, tail?: number): Promise<string>;
    /** Release, and — only when nobody else holds it — remove the engine. */
    remove(workspaceId: string, serviceId: string, opts?: { purge?: boolean }): Promise<void>;
    /** The env this workspace's SITE containers get (engine reached by container
     *  name — for a sibling container on the workspace network). */
    envFor(workspaceId: string): Record<string, string>;
    /** The env a HOST-run process/terminal gets — the same connections, but on
     *  the engine's PUBLISHED loopback port (127.0.0.1) it can actually dial.
     *  Omits any service the runtime published nothing for. */
    hostEnvFor(workspaceId: string): Record<string, string>;
    /** {@link hostEnvFor} plus the counts that explain an EMPTY result — so a
     *  host-native site can log an actionable line instead of silently serving
     *  DB-less when its services are up but unreachable from the host. */
    hostEnvReportFor(workspaceId: string): HostEnvReport;
    /** Acquire every enabled service; release everything that no longer is. */
    reconcile(): Promise<void>;
    releaseAll(): Promise<void>;

    /**
     * THE MACHINE's engines: what is installed, what is up, and who holds it.
     *
     * Lives here rather than beside the manager because the reference count
     * does: `holders` is in this closure, and an inventory built from anywhere
     * else could only guess at it. Never throws and never pulls — an absent
     * runtime yields the catalog with everything `absent`, which is the honest
     * answer on a machine that has no Docker yet.
     */
    inventory(): Promise<EngineInventoryRow[]>;

    /**
     * Drive ONE engine container at machine level.
     *
     * The counterpart of {@link acquire}/{@link release}, which are a
     * workspace's hold. This is the machine saying "that container, off" — and
     * because it is the manager doing it, the reference count follows.
     */
    engineAction(req: EngineActionRequest): Promise<EngineActionResult>;
}

export interface EngineActionRequest {
    /** The CONTAINER: an engine key, or `<engineKey>@<workspaceId>`. */
    recordKey: string;
    /** `install` PRE-DOWNLOADS this version's image (#242 P3, multi-version) —
     *  it never starts anything. */
    action: 'start' | 'stop' | 'logs' | 'install';
    tail?: number;
}

export interface EngineActionResult {
    ok: boolean;
    error?: string;
    logs?: string;
}

// --- implementation ---------------------------------------------------------

/** How long an engine gets to become ready before `ready:false` is reported. */
const DEFAULT_READY_TIMEOUT_MS = 60_000;

/** Gap between readiness attempts. */
const READY_RETRY_MS = 400;

interface Live {
    workspaceId: string;
    serviceId: string;
    config: DevServiceConfig;
    engineKey: string;
    recordKey: string;
    containerId: string;
    containerName: string;
    slice: WorkspaceSlice;
    admin: EngineAdmin;
    endpoints: ServiceEndpoint[];
    ready: boolean;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The key identifying one engine CONTAINER.
 *
 * The engine key alone for a shared engine — that is the deduplication. A
 * dedicated one appends the workspace, so it is a different container and a
 * different admin credential.
 */
export function engineRecordKeyFor(engineKey: string, workspaceId: string | null): string {
    return workspaceId ? `${engineKey}@${workspaceId}` : engineKey;
}

export function createDevServiceManager(deps: DevServiceManagerDeps): DevServiceManager {
    const readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

    /** Provisioned services, keyed by serviceId. */
    const live = new Map<string, Live>();
    /** WHO holds each engine container. The reference count, and the reason a
     *  release does not stop an engine somebody else is using. */
    const holders = new Map<string, Set<string>>();
    /** In-flight acquires, so two agents cannot race two containers onto one name. */
    const acquiring = new Map<string, Promise<DevServiceStatus>>();
    /** Why a service is NOT running, kept until it is acquired or released. */
    const lastFailure = new Map<string, DevServiceStatus>();
    /** Engine containers we have already re-created to add a missing loopback
     *  publication — so a runtime that keeps failing to report a port can never
     *  loop us into recreating the same container over and over. */
    const republished = new Set<string>();

    const changed = () => {
        try {
            deps.onChanged?.();
        } catch {
            /* a listener must not be able to fail a lifecycle call */
        }
    };

    const holdersOf = (recordKey: string): Set<string> => {
        const existing = holders.get(recordKey);
        if (existing) return existing;
        const created = new Set<string>();
        holders.set(recordKey, created);
        return created;
    };

    function findService(
        workspaceId: string,
        serviceId: string,
    ): { workspace: DevWorkspace; config: DevServiceConfig } | null {
        const workspace = deps.listWorkspaces().find((w) => w.id === workspaceId);
        if (!workspace) return null;
        const config = deps.devServicesFor(workspaceId)[serviceId];
        return config ? { workspace, config } : null;
    }

    const failed = (
        workspaceId: string,
        serviceId: string,
        config: DevServiceConfig | null,
        error: string,
    ): DevServiceStatus => ({
        serviceId,
        workspaceId,
        engine: config?.engine ?? 'custom',
        version: config?.version ?? '',
        engineKey: config ? engineKeyFor(config.engine, config.version) : '',
        dedicated: config?.dedicated ?? false,
        state: 'failed',
        error,
    });

    /** The engine's ports, as both surfaces. Reads the PUBLISHED port back. */
    async function endpointsFor(
        runtime: ContainerRuntime,
        spec: EngineSpec,
        config: DevServiceConfig,
        containerName: string,
        containerId: string,
    ): Promise<ServiceEndpoint[]> {
        const mappings = await runtime.portMappings(containerId).catch(() => []);
        const ports =
            config.engine === 'custom' && config.port
                ? [{ name: 'service', container: config.port, kind: 'tcp' as const, primary: true }]
                : spec.ports;
        return ports.map((port) => {
            const mapping = mappings.find(
                (m) => m.container === port.container && m.protocol === 'tcp',
            );
            return {
                name: port.name,
                kind: port.kind,
                // The IN-NETWORK surface: the engine's container name, on its
                // real port. NOT the loopback publication — see `env-wiring.ts`.
                host: containerName,
                port: port.container,
                ...(mapping
                    ? {
                          hostPort: mapping.hostPort,
                          localAddress:
                              port.kind === 'http'
                                  ? `http://127.0.0.1:${mapping.hostPort}`
                                  : `127.0.0.1:${mapping.hostPort}`,
                      }
                    : {}),
            };
        });
    }

    /** Poll the engine's own readiness check, or the published port. */
    async function waitReady(
        runtime: ContainerRuntime,
        spec: EngineSpec,
        admin: EngineAdmin,
        containerId: string,
        endpoints: ServiceEndpoint[],
    ): Promise<boolean> {
        const deadline = Date.now() + readyTimeoutMs;
        const readyExec = spec.readyExec?.(admin.password);
        const primary = endpoints.find((e) => e.hostPort);

        for (;;) {
            if (readyExec) {
                // Asked INSIDE the container, in the engine's own protocol. A
                // TCP connect is not enough: Postgres binds, restarts during
                // initdb, and binds again, so a connect can succeed against a
                // cluster that is about to go away.
                const result = await runtime.exec(containerId, readyExec).catch(() => null);
                if (result?.code === 0) return true;
            } else if (primary?.hostPort && deps.probeReady) {
                if (
                    await deps.probeReady({
                        port: primary.hostPort,
                        kind: primary.kind,
                        timeoutMs: Math.min(2_000, Math.max(250, deadline - Date.now())),
                    })
                ) {
                    return true;
                }
            } else {
                // Nothing to ask. Honest answer: unknown, reported as not-ready.
                return false;
            }
            if (Date.now() + READY_RETRY_MS >= deadline) return false;
            await new Promise((resolve) => setTimeout(resolve, READY_RETRY_MS));
        }
    }

    async function acquireOnce(
        workspaceId: string,
        serviceId: string,
    ): Promise<DevServiceStatus> {
        const found = findService(workspaceId, serviceId);
        if (!found) {
            return failed(
                workspaceId,
                serviceId,
                null,
                `Service ${serviceId} is not configured in workspace ${workspaceId}.`,
            );
        }
        const { config } = found;

        const { runtime, detection } = await deps.resolveRuntime();
        if (!runtime || detection.kind === 'none') {
            // The guided-install path, not an error — the message carries the
            // remedy, because an agent has nothing else to act on.
            return failed(
                workspaceId,
                serviceId,
                config,
                detection.installHint ??
                    'No container runtime (Docker or Podman) is available on this machine.',
            );
        }

        const spec = engineSpecFor(config.engine);
        const engineKey = engineKeyFor(config.engine, config.version);
        // `custom` is always dedicated — an arbitrary image has no multi-tenant
        // story, so it cannot be shared.
        const dedicated = config.dedicated || Boolean(spec.alwaysDedicated);
        const ownerId = dedicated ? workspaceId : null;
        const recordKey = engineRecordKeyFor(engineKey, ownerId);
        const containerName = serviceContainerNameFor(engineKey, ownerId ?? undefined);
        const image = config.engine === 'custom' ? config.image ?? '' : spec.image(config.version);
        if (!image) {
            return failed(workspaceId, serviceId, config, 'This service has no image to run.');
        }
        const admin = deps.engineAdmin({
            recordKey,
            engine: config.engine,
            version: config.version,
            workspaceId: ownerId,
            adminUser: spec.adminUser ?? 'admin',
        });

        // Create the engine container, published to LOOPBACK so a person, a
        // program or an agent on this machine can connect. Shared by the create
        // and the re-publish-an-adopted-one paths, so the publication is defined
        // in exactly one place.
        const createContainer = async (): Promise<
            { ok: true; id: string } | { ok: false; error: string }
        > => {
            if (!(await runtime.imageExists(image))) {
                const pulled = await pullEngineImage(runtime, image, config, workspaceId);
                if (!pulled.ok) return { ok: false, error: pulled.error };
            }
            // A shared engine's HOME is the services network — not whichever
            // workspace happened to be first, which would leave it homeless on
            // that workspace's release. A dedicated one lives on the workspace's
            // own network and needs no attachment at all.
            const network = dedicated
                ? (await runtime.networkEnsure(workspaceId)).name
                : (
                      await runtime.networkEnsureNamed(SHARED_SERVICES_NETWORK, {
                          [ROLE_LABEL]: SERVICE_ROLE,
                      })
                  ).name;
            const ports =
                config.engine === 'custom' && config.port
                    ? [{ container: config.port, hostIp: '127.0.0.1' }]
                    : spec.ports.map((p) => ({ container: p.container, hostIp: '127.0.0.1' }));
            const created = await runtime.runContainer({
                workspaceId: ownerId,
                name: containerName,
                image,
                network,
                labels: {
                    [SERVICE_LABEL]: engineKey,
                    [ROLE_LABEL]: SERVICE_ROLE,
                    ...(ownerId ? { [WORKSPACE_LABEL]: ownerId } : {}),
                },
                ...(spec.command ? { command: spec.command(admin.password) } : {}),
                env: {
                    ...(spec.adminEnv?.(admin.password) ?? {}),
                    ...(config.engine === 'custom' ? config.env ?? {} : {}),
                },
                // A named volume, never a bind: a database's data directory needs
                // the container's own uid/gid and filesystem semantics, and it
                // must outlive the container — which is what makes re-creating a
                // mis-published one safe.
                volumes: spec.volumes.map((v) => ({
                    name: serviceVolumeNameFor(engineKey, v.suffix, ownerId ?? undefined),
                    target: v.target,
                })),
                ports,
                restart: 'unless-stopped',
                init: true,
            });
            return { ok: true, id: created.id };
        };

        try {
            // --- the engine container ---------------------------------------
            const existing = (await runtime.psServices(engineKey)).find(
                (c) => c.name === containerName,
            );
            let containerId: string;
            if (existing) {
                // ADOPT. This is the deduplication: the second workspace to want
                // Postgres 16 finds the first's container by its derived name.
                if (existing.state !== 'running') await runtime.start(existing.id);
                containerId = existing.id;

                // The adoption gap (moic beta.245): a published port is FIXED at
                // create — there is no way to add one to a running container. An
                // engine adopted from an older Genie that never published to
                // loopback is unreachable from the host, so every host-native
                // site, terminal and `queue:work` gets no service env. When the
                // engine expects a published port but the adopted container
                // exposes NONE, re-create it WITH the publication (the named
                // volume keeps the data). Guarded so a runtime that simply fails
                // to report ports can never loop us into endless re-creation.
                const expectsPublish =
                    (config.engine === 'custom' && Boolean(config.port)) || spec.ports.length > 0;
                if (expectsPublish && !republished.has(containerName)) {
                    const adopted = await endpointsFor(runtime, spec, config, containerName, containerId);
                    if (!adopted.some((e) => e.hostPort)) {
                        republished.add(containerName);
                        await runtime.stop(containerId).catch(() => {});
                        await runtime.remove(containerId).catch(() => {});
                        const recreated = await createContainer();
                        if (!recreated.ok) {
                            return failed(workspaceId, serviceId, config, recreated.error);
                        }
                        containerId = recreated.id;
                    }
                }
            } else {
                const created = await createContainer();
                if (!created.ok) return failed(workspaceId, serviceId, config, created.error);
                containerId = created.id;
            }

            const endpoints = await endpointsFor(runtime, spec, config, containerName, containerId);
            const ready = await waitReady(runtime, spec, admin, containerId, endpoints);
            if (!ready) {
                return failed(
                    workspaceId,
                    serviceId,
                    config,
                    `${spec.label} started but never became ready — check \`logs\`.`,
                );
            }

            // --- attach it to this workspace's network ----------------------
            if (!dedicated) {
                const network = await runtime.networkEnsure(workspaceId);
                await runtime.networkConnect(network.name, containerId);
            }

            // --- carve out this workspace's slice ---------------------------
            const slice: WorkspaceSlice = {
                identifier: workspaceSqlIdentifier(workspaceId),
                dnsName: workspaceDnsName(workspaceId),
                password: config.password,
            };
            const provisioned = await runProvisionSteps(
                runtime,
                containerId,
                provisionSteps(config.engine, admin, slice),
            );
            if (!provisioned.ok) {
                return failed(
                    workspaceId,
                    serviceId,
                    config,
                    provisioned.error ?? 'provisioning failed',
                );
            }

            holdersOf(recordKey).add(workspaceId);
            live.set(serviceId, {
                workspaceId,
                serviceId,
                config,
                engineKey,
                recordKey,
                containerId,
                containerName,
                slice,
                admin,
                endpoints,
                ready,
            });
            changed();
            return statusOf(live.get(serviceId)!);
        } catch (e) {
            return failed(workspaceId, serviceId, config, messageOf(e));
        }
    }

    async function pullEngineImage(
        runtime: ContainerRuntime,
        image: string,
        config: DevServiceConfig,
        workspaceId: string,
    ): Promise<{ ok: true } | { ok: false; error: string }> {
        // ABSENT MEANS NO PULL — the same default as the sandbox's, and for the
        // same reason: a caller who has not built a progress surface must not be
        // able to start a download by forgetting a field.
        if (!deps.confirmImagePull) {
            return {
                ok: false,
                error:
                    `The ${config.engine} image ${image} is not on this machine. ` +
                    `Run \`${runtime.kind} pull ${image}\` and try again.`,
            };
        }
        const agreed = await deps.confirmImagePull({
            image,
            reason:
                `Workspace ${workspaceId} needs the ${config.engine} ${config.version} image ` +
                `${image}, which is not on this machine yet. It is downloaded once and shared ` +
                'by every workspace using that engine afterwards.',
        });
        if (!agreed) {
            return {
                ok: false,
                error: `The image ${image} was not downloaded, so ${config.engine} was not started.`,
            };
        }
        const pull = await runtime.pullImage(image, {
            ...(deps.onImagePullProgress ? { onProgress: deps.onImagePullProgress } : {}),
        });
        return pull.ok
            ? { ok: true }
            : { ok: false, error: `Downloading ${image} failed: ${pull.error ?? 'unknown error'}` };
    }

    function provisionedFor(entry: Live): ProvisionedService {
        const spec = engineSpecFor(entry.config.engine);
        const primary =
            entry.endpoints.find((e) => e.name === (spec.ports.find((p) => p.primary)?.name ?? '')) ??
            entry.endpoints[0];
        return {
            engine: entry.config.engine,
            version: entry.config.version,
            // Which version owns this engine's single-valued env names (#242 P3).
            // Two majors of one engine are different containers with different
            // VOLUMES; without a choice the environment contradicts itself.
            ...(entry.config.active ? { active: true } : {}),
            host: entry.containerName,
            port: primary?.port ?? 0,
            slice: entry.slice,
            ...(spec.adminUser ? { adminUser: spec.adminUser } : {}),
            // Only the NAMESPACE engines hand the master credential out — they
            // have no per-workspace one. `env-wiring.ts` uses it for exactly
            // those, and ignores it elsewhere.
            ...(spec.provision === 'namespace' ? { adminPassword: entry.admin.password } : {}),
            ...(entry.config.engine === 'custom'
                ? { name: entry.engineKey, customEnv: entry.config.env ?? {} }
                : {}),
        };
    }

    /**
     * Like {@link provisionedFor}, but for a HOST-run consumer — a managed
     * process, a person, a `psql`. A host process reaches the engine on its
     * PUBLISHED loopback port, never the container name a sibling container uses
     * (it cannot resolve that name). Returns `null` when nothing was published:
     * then the engine is simply unreachable from the host, so it is left out
     * rather than emitting a connection string that would fail.
     */
    function provisionedForHost(entry: Live): ProvisionedService | null {
        const spec = engineSpecFor(entry.config.engine);
        const primary =
            entry.endpoints.find((e) => e.name === (spec.ports.find((p) => p.primary)?.name ?? '')) ??
            entry.endpoints[0];
        if (!primary?.hostPort) return null;
        return { ...provisionedFor(entry), host: '127.0.0.1', port: primary.hostPort };
    }

    function statusOf(entry: Live): DevServiceStatus {
        return {
            serviceId: entry.serviceId,
            workspaceId: entry.workspaceId,
            engine: entry.config.engine,
            version: entry.config.version,
            engineKey: entry.engineKey,
            dedicated: entry.config.dedicated || Boolean(engineSpecFor(entry.config.engine).alwaysDedicated),
            state: 'running',
            ready: entry.ready,
            containerId: entry.containerId,
            containerName: entry.containerName,
            holders: holdersOf(entry.recordKey).size,
            endpoints: entry.endpoints,
            namespace: { identifier: entry.slice.identifier, dnsName: entry.slice.dnsName },
            envKeys: Object.keys(serviceEnv([provisionedFor(entry)])),
        };
    }

    async function acquire(workspaceId: string, serviceId: string): Promise<DevServiceStatus> {
        const inFlight = acquiring.get(serviceId);
        if (inFlight) return inFlight;
        const promise = acquireOnce(workspaceId, serviceId)
            .then((status) => {
                if (status.state === 'running') lastFailure.delete(serviceId);
                else lastFailure.set(serviceId, status);
                return status;
            })
            .finally(() => acquiring.delete(serviceId));
        acquiring.set(serviceId, promise);
        return promise;
    }

    async function release(workspaceId: string, serviceId: string): Promise<void> {
        // A release clears the remembered failure: the service is off because it
        // was asked to be, which is not the same as being broken.
        lastFailure.delete(serviceId);
        const entry = live.get(serviceId);
        if (!entry) return;
        live.delete(serviceId);

        const { runtime } = await deps.resolveRuntime();
        const held = holdersOf(entry.recordKey);
        held.delete(workspaceId);

        if (runtime) {
            try {
                const dedicated =
                    entry.config.dedicated ||
                    Boolean(engineSpecFor(entry.config.engine).alwaysDedicated);
                // Detach FIRST: a workspace network with the engine still
                // attached cannot be removed, so a workspace teardown would
                // leave an orphan network behind.
                if (!dedicated) {
                    await runtime.networkDisconnect(`genie-ws-${workspaceId}`, entry.containerId);
                }
                // Stop only when NOBODY holds it. This line is the reference
                // count, and stopping one release too early is the bug the whole
                // mechanism exists to prevent.
                if (held.size === 0) await runtime.stop(entry.containerId);
            } catch {
                /* tolerant — the adapter already treats "already gone" as success */
            }
        }
        changed();
    }

    return {
        acquire,
        release,

        async adopt() {
            const { runtime } = await deps.resolveRuntime();
            if (!runtime) return;
            for (const workspace of deps.listWorkspaces()) {
                for (const [serviceId, config] of Object.entries(
                    deps.devServicesFor(workspace.id),
                )) {
                    if (!config.enabled || live.has(serviceId)) continue;
                    const engineKey = engineKeyFor(config.engine, config.version);
                    const dedicated =
                        config.dedicated || Boolean(engineSpecFor(config.engine).alwaysDedicated);
                    const containerName = serviceContainerNameFor(
                        engineKey,
                        dedicated ? workspace.id : undefined,
                    );
                    let found;
                    try {
                        found = (await runtime.psServices(engineKey)).find(
                            (c) => c.name === containerName && c.state === 'running',
                        );
                    } catch {
                        // One unreadable engine must not abandon the rest —
                        // this runs once at boot and gets no second chance.
                        continue;
                    }
                    // Not running: leave it. Adoption is for what Docker kept
                    // alive, never a back door into starting things on boot.
                    if (!found) continue;
                    await acquire(workspace.id, serviceId);
                }
            }
        },

        list(workspaceId) {
            const rows: DevServiceRow[] = [];
            for (const workspace of deps.listWorkspaces()) {
                if (workspaceId && workspace.id !== workspaceId) continue;
                for (const [serviceId, config] of Object.entries(
                    deps.devServicesFor(workspace.id),
                )) {
                    const entry = live.get(serviceId);
                    const status = entry
                        ? statusOf(entry)
                        : lastFailure.get(serviceId) ?? {
                              serviceId,
                              workspaceId: workspace.id,
                              engine: config.engine,
                              version: config.version,
                              engineKey: engineKeyFor(config.engine, config.version),
                              dedicated: config.dedicated,
                              state: 'stopped' as const,
                          };
                    rows.push({
                        ...status,
                        // The stored intent always comes from CONFIG, so a row
                        // never shows a stale copy carried on an old failure.
                        engine: config.engine,
                        version: config.version,
                        engineKey: engineKeyFor(config.engine, config.version),
                        enabled: config.enabled,
                    });
                }
            }
            return rows;
        },

        async logs(serviceId, tail) {
            const entry = live.get(serviceId);
            if (!entry) {
                const failure = lastFailure.get(serviceId);
                return failure?.error
                    ? `This service is not running. It last failed with:\n${failure.error}`
                    : 'This service is not running, so it has no engine log.';
            }
            const { runtime } = await deps.resolveRuntime();
            if (!runtime) return 'No container runtime is available, so the log cannot be read.';
            try {
                return await runtime.logs(entry.containerId, ...(tail ? [{ tail }] : []));
            } catch (e) {
                return `Could not read the engine log: ${messageOf(e)}`;
            }
        },

        async remove(workspaceId, serviceId, opts = {}) {
            const entry = live.get(serviceId);
            const config = entry?.config ?? deps.devServicesFor(workspaceId)[serviceId];
            await release(workspaceId, serviceId);
            if (!opts.purge || !entry || !config) return;

            // Only when NOBODY holds the engine. Dropping a shared volume while
            // another workspace is using it would destroy that workspace's data
            // — the single most destructive thing this module could do.
            if (holdersOf(entry.recordKey).size > 0) return;
            const { runtime } = await deps.resolveRuntime();
            if (!runtime) return;
            const spec = engineSpecFor(config.engine);
            const dedicated = config.dedicated || Boolean(spec.alwaysDedicated);
            try {
                await runtime.remove(entry.containerId);
                for (const volume of spec.volumes) {
                    await runtime.volumeRemove(
                        serviceVolumeNameFor(
                            entry.engineKey,
                            volume.suffix,
                            dedicated ? workspaceId : undefined,
                        ),
                    );
                }
            } catch {
                /* tolerant: removal has to converge */
            }
            changed();
        },

        envFor(workspaceId) {
            const mine = [...live.values()].filter((e) => e.workspaceId === workspaceId);
            return serviceEnv(mine.map(provisionedFor));
        },

        hostEnvFor(workspaceId) {
            const mine = [...live.values()].filter((e) => e.workspaceId === workspaceId);
            return serviceEnv(
                mine.map(provisionedForHost).filter((p): p is ProvisionedService => p !== null),
            );
        },

        hostEnvReportFor(workspaceId) {
            const configured = deps.devServicesFor(workspaceId);
            const enabled = Object.values(configured).filter((c) => c.enabled).length;
            const mine = [...live.values()].filter((e) => e.workspaceId === workspaceId);
            const provisioned: ProvisionedService[] = [];
            const missingHostPort: string[] = [];
            for (const entry of mine) {
                const host = provisionedForHost(entry);
                if (host) provisioned.push(host);
                else missingHostPort.push(entry.config.engine);
            }
            return {
                env: serviceEnv(provisioned),
                enabled,
                live: mine.length,
                withHostPort: provisioned.length,
                missingHostPort,
            };
        },

        async reconcile() {
            const wanted = new Set<string>();
            for (const workspace of deps.listWorkspaces()) {
                for (const [serviceId, config] of Object.entries(
                    deps.devServicesFor(workspace.id),
                )) {
                    if (!config.enabled) continue;
                    wanted.add(serviceId);
                    await acquire(workspace.id, serviceId);
                }
            }
            for (const [serviceId, entry] of [...live.entries()]) {
                if (!wanted.has(serviceId)) await release(entry.workspaceId, serviceId);
            }
        },

        async releaseAll() {
            for (const [serviceId, entry] of [...live.entries()]) {
                await release(entry.workspaceId, serviceId);
            }
        },

        async inventory() {
            const configs = deps.listWorkspaces().map((w) => ({
                workspaceId: w.id,
                workspaceLabel: w.label || w.id,
                services: deps.devServicesFor(w.id),
            }));
            const { runtime } = await deps.resolveRuntime();

            // No runtime is the ORDINARY first-run state, not a failure: the
            // catalog is still the true answer to "what could this machine run",
            // and it is the answer someone with no Docker most needs.
            const containers = new Map<string, { id: string; state: ContainerState }>();
            const images = new Set<string>();
            if (runtime) {
                for (const c of await runtime.psServices().catch(() => [])) {
                    containers.set(c.name, { id: c.id, state: c.state });
                }
                // Probed, never pulled. `imageExists` is a local lookup; opening a
                // page must not be able to start a multi-gigabyte download.
                await Promise.all(
                    inventoryImages(configs).map(async (image) => {
                        if (await runtime.imageExists(image).catch(() => false)) {
                            images.add(image);
                        }
                    }),
                );
            }

            return buildEngineInventory({ configs, images, containers, holders });
        },

        async engineAction({ recordKey, action, tail }) {
            const { runtime, detection } = await deps.resolveRuntime();
            if (!runtime) {
                return {
                    ok: false,
                    error:
                        detection.installHint ??
                        'No container runtime (Docker or Podman) is available on this machine.',
                };
            }

            // INSTALL — pre-download a version's image (#242 P3). The one action
            // with no consumer requirement: each (engine, version) is its own
            // image, so holding 17 ready while 16 serves today is the point. It
            // PULLS ONLY — a downloaded image is not a running engine, and
            // starting still needs a workspace to provision for.
            if (action === 'install') {
                const parsed = parseEngineKey(recordKey.split('@')[0] ?? '');
                // The version becomes an image TAG, so an unknown one is an
                // arbitrary image to run with a workspace's data in it — refused
                // here for the same reason `resolveEngineVersion` refuses it.
                const version = parsed ? resolveEngineVersion(parsed.engine, parsed.version) : null;
                if (!parsed || !version) {
                    return {
                        ok: false,
                        error: `Genie has no image pinned for ${recordKey}, so there is nothing to install.`,
                    };
                }
                const image = engineSpecFor(parsed.engine).image(version);
                if (!image) {
                    return {
                        ok: false,
                        error: `${parsed.engine} has no image until a workspace names one, so there is nothing to install.`,
                    };
                }
                if (await runtime.imageExists(image)) return { ok: true };
                if (!deps.confirmImagePull) {
                    return {
                        ok: false,
                        error:
                            `The image ${image} is not on this machine. ` +
                            `Run \`${runtime.kind} pull ${image}\` and try again.`,
                    };
                }
                const agreed = await deps.confirmImagePull({
                    image,
                    reason:
                        `Genie would download the ${parsed.engine} ${version} image ${image} so this ` +
                        'machine can run that version. It is downloaded once and shared by every ' +
                        'workspace that uses it afterwards.',
                });
                if (!agreed) {
                    return { ok: false, error: `The image ${image} was not downloaded.` };
                }
                const pull = await runtime.pullImage(image, {
                    ...(deps.onImagePullProgress ? { onProgress: deps.onImagePullProgress } : {}),
                });
                if (!pull.ok) {
                    return {
                        ok: false,
                        error: `Downloading ${image} failed: ${pull.error ?? 'unknown error'}`,
                    };
                }
                changed();
                return { ok: true };
            }

            /** Which workspaces have this exact CONTAINER configured. */
            const consumers: Array<{ workspaceId: string; serviceId: string }> = [];
            for (const workspace of deps.listWorkspaces()) {
                for (const [serviceId, config] of Object.entries(
                    deps.devServicesFor(workspace.id),
                )) {
                    const dedicated =
                        config.dedicated || Boolean(engineSpecFor(config.engine).alwaysDedicated);
                    const key = engineRecordKeyFor(
                        engineKeyFor(config.engine, config.version),
                        dedicated ? workspace.id : null,
                    );
                    if (key === recordKey) consumers.push({ workspaceId: workspace.id, serviceId });
                }
            }

            if (action === 'start') {
                // Re-ACQUIRE rather than `docker start`. Provisioning has to run
                // again — a Redis ACL user lives in memory and is gone after a
                // restart — and the workspaces have to be reattached to the
                // engine's network. A bare start would bring up a container none
                // of its consumers could authenticate against.
                if (consumers.length === 0) {
                    return {
                        ok: false,
                        error:
                            'No workspace uses this engine, so there is nothing to start. Add it ' +
                            "from a workspace's Site Manager (or ask an agent to) and it will start there.",
                    };
                }
                const failures: string[] = [];
                for (const { workspaceId, serviceId } of consumers) {
                    const status = await acquire(workspaceId, serviceId);
                    if (status.state === 'failed') failures.push(status.error ?? 'failed to start');
                }
                return failures.length
                    ? { ok: false, error: failures[0]! }
                    : { ok: true };
            }

            const containerId = await findEngineContainer(runtime, recordKey);
            if (!containerId) {
                return {
                    ok: false,
                    error: `No container for ${recordKey} on this machine, so there is nothing to ${action}.`,
                };
            }

            if (action === 'logs') {
                try {
                    return {
                        ok: true,
                        logs: await runtime.logs(containerId, ...(tail ? [{ tail }] : [])),
                    };
                } catch (e) {
                    return { ok: false, error: `Could not read the engine log: ${messageOf(e)}` };
                }
            }

            // STOP. Blunt on purpose, and the bookkeeping is the point: the
            // container is down, so nobody holds it. Leaving the holds in place
            // would have the next release "stop" an already-stopped engine while
            // every consumer still reported itself as connected.
            try {
                await runtime.stop(containerId);
            } catch (e) {
                return { ok: false, error: messageOf(e) };
            }
            holders.delete(recordKey);
            for (const [serviceId, entry] of [...live.entries()]) {
                if (entry.recordKey === recordKey) live.delete(serviceId);
            }
            changed();
            return { ok: true };
        },
    };

    /** The engine container behind a recordKey, by its derived name. */
    async function findEngineContainer(
        runtime: ContainerRuntime,
        recordKey: string,
    ): Promise<string | null> {
        const [engineKey, ownerId] = recordKey.split('@');
        const name = serviceContainerNameFor(engineKey!, ownerId);
        const found = (await runtime.psServices(engineKey).catch(() => [])).find(
            (c) => c.name === name,
        );
        return found?.id ?? null;
    }
}

// --- the process-wide instance ----------------------------------------------

let instance: DevServiceManager | null = null;

/** Create the one dev-service manager for this process. Idempotent: a second
 *  call returns the existing one rather than orphaning its engines. */
export function initDevServices(deps: DevServiceManagerDeps): DevServiceManager {
    instance ??= createDevServiceManager(deps);
    return instance;
}

/** The live manager, or null when services were never initialised. */
export function devServiceManager(): DevServiceManager | null {
    return instance;
}

/**
 * The env a workspace's SITE containers get from its services.
 *
 * Returns `{}` rather than throwing when nothing was initialised, which is what
 * makes the site-manager wiring purely additive.
 */
export function devServiceEnvFor(workspaceId: string): Record<string, string> {
    return instance?.envFor(workspaceId) ?? {};
}

/**
 * The HOST-form service env for a workspace: the same connection strings as
 * {@link devServiceEnvFor}, but on the engines' published `127.0.0.1` ports so a
 * process or terminal running on the HOST (a `queue:work`, a test run, a dev
 * server) can reach them. `{}` when nothing is initialised.
 */
export function devServiceHostEnvFor(workspaceId: string): Record<string, string> {
    return instance?.hostEnvFor(workspaceId) ?? {};
}

/**
 * {@link devServiceHostEnvFor} with the diagnostic that explains an empty result
 * — enabled vs live vs host-published counts, so a host-native site can log WHY
 * it got no service env rather than serving DB-less in silence. All-zeroes when
 * nothing is initialised.
 */
export function devServiceHostEnvReportFor(workspaceId: string): HostEnvReport {
    return (
        instance?.hostEnvReportFor(workspaceId) ?? {
            env: {},
            enabled: 0,
            live: 0,
            withHostPort: 0,
            missingHostPort: [],
        }
    );
}

/** Test-only: drop the process-wide instance. */
export function resetDevServicesForTests(): void {
    instance = null;
}
