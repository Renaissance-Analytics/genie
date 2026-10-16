import { createHash } from 'node:crypto';
import type { AdoptedSlice, ServiceInstance, ServiceScope } from './services.js';

/**
 * GENIE 1's SERVICE ENGINES → GENIE 2, TAKEN OVER IN PLACE — the pure plan (no I/O).
 *
 * The owner, after the first real upgrade: "the upgrade should have shut down everything that was
 * genie 1 so that everything running was genie 2 and what needed to be migrated, was migrated."
 * Genie 1's engines were still running, owned by nobody, and so were its workspace sandboxes and
 * site containers. The engines hold every workspace's data and every workspace's `.env` names them,
 * so they are not recreated: Genie 2 adopts the SAME container, volume, credentials and port. The
 * sandboxes and site containers are Genie 1's way of running apps, which Genie 2 runs on the host;
 * they are stopped.
 *
 * `main/v1-services.ts` reads Genie 1's database and asks Docker; this decides.
 *
 * ## What Genie 1 kept, and where (repos/genie, read-only reference)
 *
 * - `dev_service_engines(key, engine, version, workspace_id, admin_user, admin_password)` — one row
 *   per engine CONTAINER; `key` is `<engine>-<version>` for a shared engine and
 *   `<engine>-<version>@<workspaceId>` for a dedicated one (service-manager.ts engineRecordKeyFor).
 * - `workspaces.dev_services` — JSON, one entry per (workspace, engine, version): `engine`,
 *   `version`, `dedicated`, `active`, `enabled`, and the workspace's own `password`. The database,
 *   role, ACL user, mail tag and bucket are DERIVED from the workspace id (catalog.ts
 *   workspaceSqlIdentifier / workspaceDnsName), never stored — so they are derived here the same way.
 * - `dev_service_ports(record_key, port_name, host_port)` — only the ports that MOVED off their
 *   derived default. Observed Docker state wins over it; it is the fallback for a stopped container
 *   whose bindings Docker does not report.
 * - Containers carry labels (argv.ts): `genie.service=<engine>-<version>` on every engine,
 *   `genie.workspace=<workspace id>` on a dedicated engine AND on every sandbox/site container,
 *   `genie.site` on a site container, `genie.role` saying which.
 *
 * ## The rules
 *
 * - Docker is authoritative for what EXISTS: a container's ports, image and volume are read from it.
 *   A Genie 1 row with no container is skipped with why (nothing to take over; any volume is left).
 * - A service container with no row is REPORTED, never adopted: without the row there is no
 *   credential, and a guessed one is a locked-out app.
 * - Engines Genie 2 has no driver for (Meilisearch, SeaweedFS, WebSockets, custom images) are
 *   skipped with why and LEFT RUNNING — stopping one would break the apps that use it.
 * - A workspace's entry that Genie 1 had switched off (`enabled: false`) carries no slice: Genie 1
 *   gave that workspace no env for it either.
 * - Stopped: every container labelled `genie.workspace` or `genie.site` that is not an engine.
 * - Ids are `svc_v1_<record key>` — stable, so a second pass recognises what it already took.
 */

export interface V1EngineRow {
    readonly key: string;
    readonly engine: string;
    readonly version: string;
    readonly workspaceId: string | null;
    readonly adminUser: string;
    readonly adminPassword: string;
}

export interface V1ServiceRows {
    readonly engines: readonly V1EngineRow[];
    /** `devServices` is `workspaces.dev_services` as Genie 1 stores it: JSON text, or null. */
    readonly workspaces: readonly { readonly id: string; readonly devServices: string | null }[];
    readonly ports: readonly { readonly recordKey: string; readonly portName: string; readonly hostPort: number }[];
}

type PortMap = Readonly<Record<string, readonly { readonly HostIp?: string; readonly HostPort?: string }[] | null>> | null;

/** One element of `docker container inspect`'s array — the fields this reads, nothing more. */
export interface InspectedContainer {
    readonly Name?: string;
    readonly Config?: { readonly Image?: string; readonly Labels?: Readonly<Record<string, string>> | null };
    readonly State?: { readonly Status?: string };
    readonly NetworkSettings?: { readonly Ports?: PortMap };
    readonly HostConfig?: { readonly PortBindings?: PortMap };
    readonly Mounts?: readonly { readonly Type?: string; readonly Name?: string; readonly Destination?: string }[];
}

export interface V1ServicesPlan {
    readonly adopt: readonly ServiceInstance[];
    /** Adopted containers that are not running: started once, so the apps that name them reach them. */
    readonly start: readonly string[];
    /** Genie 1's sandboxes and site containers: stopped, and their restart policy cleared. */
    readonly stop: readonly { readonly name: string; readonly why: string }[];
    readonly skipped: readonly { readonly what: string; readonly why: string }[];
}

export const V1_SERVICE_ID_PREFIX = 'svc_v1_';

export const V1_LABELS = Object.freeze({ service: 'genie.service', workspace: 'genie.workspace', site: 'genie.site', role: 'genie.role' });

/** Per engine Genie 2 takes over: its surfaces (Genie 1's names and container ports, primary first) and its data directory. */
const ADOPTABLE: Readonly<Record<string, { readonly ports: readonly { readonly name: string; readonly container: number }[]; readonly data: string }>> = {
    postgres: { ports: [{ name: 'postgres', container: 5432 }], data: '/var/lib/postgresql/data' },
    mysql: { ports: [{ name: 'mysql', container: 3306 }], data: '/var/lib/mysql' },
    redis: { ports: [{ name: 'redis', container: 6379 }], data: '/data' },
    mailpit: { ports: [{ name: 'smtp', container: 1025 }, { name: 'ui', container: 8025 }], data: '/data' },
    minio: { ports: [{ name: 's3', container: 9000 }, { name: 'console', container: 9001 }], data: '/data' },
};

/** Genie 1's engines that are always dedicated, whatever the stored flag says (catalog.ts `alwaysDedicated`). */
const ALWAYS_DEDICATED = new Set(['redis', 'custom']);

/**
 * `null` rows = cannot see Genie 1; `null` containers = Docker did not answer. Either way nothing is
 * planned and nothing is claimed. `workspaces`, when given, is Genie 2's: a DEDICATED engine whose
 * workspace did not come over is left as it is, and said.
 */
export function planV1ServicesAdoption(
    rows: V1ServiceRows | null,
    containers: readonly InspectedContainer[] | null,
    options: { readonly workspaces?: readonly string[] } = {},
): V1ServicesPlan | null {
    if (rows === null || containers === null) return null;
    const known = options.workspaces ? new Set(options.workspaces) : null;
    const adopt: ServiceInstance[] = [];
    const start: string[] = [];
    const stop: { name: string; why: string }[] = [];
    const skipped: { what: string; why: string }[] = [];

    const labelsOf = (c: InspectedContainer): Readonly<Record<string, string>> => c.Config?.Labels ?? {};
    const nameOf = (c: InspectedContainer): string => (c.Name ?? '').replace(/^\//, '');
    const engines = containers.filter((c) => labelsOf(c)[V1_LABELS.service] !== undefined || labelsOf(c)[V1_LABELS.role] === 'service');

    // Each workspace's slices, by the engine record they belong to.
    const slicesByRecord = new Map<string, Record<string, AdoptedSlice>>();
    for (const ws of rows.workspaces) {
        for (const entry of parseDevServices(ws.devServices)) {
            const engineKey = `${entry.engine}-${entry.version}`;
            const recordKey = entry.dedicated || ALWAYS_DEDICATED.has(entry.engine) ? `${engineKey}@${ws.id}` : engineKey;
            const what = `workspace ${ws.id}: ${engineKey}`;
            if (!ADOPTABLE[entry.engine]) continue; // said once, on the engine row below
            if (!entry.enabled) {
                skipped.push({ what, why: 'switched off in Genie 1, which gave the workspace no env for it; not carried' });
                continue;
            }
            if (!rows.engines.some((e) => e.key === recordKey)) {
                skipped.push({ what, why: 'Genie 1 never started an engine for it (no engine record); nothing to take over' });
                continue;
            }
            const identifier = workspaceSqlIdentifier(ws.id);
            const slice: AdoptedSlice = {
                identifier,
                password: entry.password,
                ...(entry.engine === 'redis' ? { prefix: `${identifier}:` } : {}),
                ...(entry.engine === 'minio' ? { bucket: workspaceDnsName(ws.id) } : {}),
                ...(entry.active ? { active: true } : {}),
            };
            slicesByRecord.set(recordKey, { ...(slicesByRecord.get(recordKey) ?? {}), [ws.id]: slice });
        }
    }

    const claimed = new Set<InspectedContainer>();
    for (const row of rows.engines) {
        const what = `engine ${row.key}`;
        const engineKey = `${row.engine}-${row.version}`;
        const container = engines.find((c) => labelsOf(c)[V1_LABELS.service] === engineKey && (labelsOf(c)[V1_LABELS.workspace] ?? null) === row.workspaceId);
        if (container) claimed.add(container);
        const surfaces = ADOPTABLE[row.engine];
        if (!surfaces) {
            skipped.push({ what, why: `Genie 2 has no ${row.engine} engine; ${container ? `its container ${nameOf(container)} is left running as it is` : 'it has no container either'}` });
            continue;
        }
        if (!container) {
            skipped.push({ what, why: 'Genie 1 recorded it but no container exists; nothing to take over (any data volume is left alone)' });
            continue;
        }
        const name = nameOf(container);
        if (row.workspaceId !== null && known !== null && !known.has(row.workspaceId)) {
            skipped.push({ what, why: `dedicated to workspace ${row.workspaceId}, which is not in Genie 2; its container ${name} is left as it is` });
            continue;
        }
        const published: Record<string, number> = {};
        for (const surface of surfaces.ports) {
            const port = hostPortOf(container.NetworkSettings?.Ports ?? null, surface.container)
                ?? hostPortOf(container.HostConfig?.PortBindings ?? null, surface.container)
                ?? rows.ports.find((p) => p.recordKey === row.key && p.portName === surface.name)?.hostPort
                ?? null;
            if (port !== null) published[surface.name] = port;
        }
        const primary = published[surfaces.ports[0]!.name];
        if (primary === undefined) {
            skipped.push({ what, why: `its container ${name} publishes no host port for ${surfaces.ports[0]!.name} and Genie 1 remembered none; an app could not reach it` });
            continue;
        }
        const mounts = (container.Mounts ?? []).filter((m) => m.Type === 'volume' && typeof m.Name === 'string' && m.Name !== '');
        const volume = (mounts.find((m) => m.Destination === surfaces.data) ?? mounts[0])?.Name;
        const scope: ServiceScope = row.workspaceId === null ? { kind: 'shared' } : { kind: 'dedicated', workspaceId: row.workspaceId };
        const slices = slicesByRecord.get(row.key) ?? {};
        adopt.push({
            id: `${V1_SERVICE_ID_PREFIX}${row.key}`,
            engine: row.engine,
            version: row.version,
            scope,
            publishedPort: primary,
            // Unused for an adopted engine (its env is the slice's) — and never filled with something new.
            credentials: {},
            active: Object.values(slices).some((s) => s.active === true),
            adopted: 'v1',
            containerName: name,
            ...(container.Config?.Image ? { image: container.Config.Image } : {}),
            ...(volume ? { volume } : {}),
            admin: { user: row.adminUser, password: row.adminPassword },
            slices,
            publishedPorts: published,
        });
        // Started only when some workspace USES it. Projected against the owner's real Genie 1 data (2026-10-14): two
        // stopped engines no workspace held a slice of would have been woken for nobody.
        const used = Object.keys(slices).length > 0;
        if (container.State?.Status !== 'running' && used) start.push(name);
        if (!used) skipped.push({ what: `${what} (adopted)`, why: `no workspace holds a slice of it in Genie 1; taken over${container.State?.Status !== 'running' ? ' and left stopped' : ''}, but it gives no workspace any env` });
    }

    for (const c of engines) {
        if (claimed.has(c)) continue;
        skipped.push({ what: `container ${nameOf(c)}`, why: 'a Genie 1 service container with no record in Genie 1\'s database — no credential to carry; left as it is' });
    }

    for (const c of containers) {
        if (engines.includes(c)) continue;
        const labels = labelsOf(c);
        if (labels[V1_LABELS.site] !== undefined) stop.push({ name: nameOf(c), why: `Genie 1's site container (workspace ${labels[V1_LABELS.workspace] ?? '?'})` });
        else if (labels[V1_LABELS.workspace] !== undefined) stop.push({ name: nameOf(c), why: `Genie 1's ${labels[V1_LABELS.role] ?? 'workspace'} container (workspace ${labels[V1_LABELS.workspace]})` });
    }

    return { adopt, start, stop, skipped };
}

/** The host port Docker reports for `<container>/tcp`, loopback first; a blank `HostPort` is no port. */
function hostPortOf(map: PortMap, containerPort: number): number | null {
    const bindings = map?.[`${containerPort}/tcp`] ?? null;
    if (!bindings) return null;
    const ordered = [...bindings].sort((a, b) => Number(b.HostIp === '127.0.0.1') - Number(a.HostIp === '127.0.0.1'));
    for (const b of ordered) {
        const n = Number(b.HostPort);
        if (b.HostPort && Number.isInteger(n) && n > 0) return n;
    }
    return null;
}

interface V1DevService {
    readonly engine: string;
    readonly version: string;
    readonly dedicated: boolean;
    readonly enabled: boolean;
    readonly active: boolean;
    readonly password: string;
}

/** Genie 1's `dev_services` blob. An entry without an engine, a version or a password is unusable there too (services-config.ts parseDevServices). */
function parseDevServices(text: string | null): V1DevService[] {
    if (!text) return [];
    let value: unknown;
    try { value = JSON.parse(text); } catch { return []; }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
    const out: V1DevService[] = [];
    for (const raw of Object.values(value as Record<string, unknown>)) {
        if (raw === null || typeof raw !== 'object') continue;
        const e = raw as Record<string, unknown>;
        if (typeof e.engine !== 'string' || typeof e.version !== 'string' || typeof e.password !== 'string' || e.password === '') continue;
        out.push({ engine: e.engine, version: e.version, dedicated: e.dedicated === true, enabled: e.enabled === true, active: e.active === true, password: e.password });
    }
    return out;
}

/**
 * Genie 1's workspace slug (argv.ts workspaceSlugFor), byte for byte: the identifiers below are
 * DERIVED from it, and they are the names of databases, roles and ACL users that already exist.
 */
export function v1WorkspaceSlug(workspaceId: string): string {
    const raw = String(workspaceId ?? '');
    const lower = raw.toLowerCase();
    const sanitised = lower.replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '');
    if (sanitised && sanitised === lower && sanitised.length <= 48) return sanitised;
    const digest = createHash('sha1').update(raw).digest('hex').slice(0, 8);
    const stem = sanitised.slice(0, 48 - 9).replace(/[^a-z0-9]+$/, '') || 'workspace';
    return `${stem}-${digest}`;
}

/** Genie 1's `ws_<slug>` (catalog.ts workspaceSqlIdentifier): database, role, Redis ACL user, mail tag. */
export function workspaceSqlIdentifier(workspaceId: string): string {
    return `ws_${v1WorkspaceSlug(workspaceId).replace(/-/g, '_')}`.slice(0, 63);
}

/** Genie 1's `ws-<slug>` (catalog.ts workspaceDnsName): the S3 bucket, which is also the access key. */
export function workspaceDnsName(workspaceId: string): string {
    return `ws-${v1WorkspaceSlug(workspaceId)}`.slice(0, 63).replace(/-+$/, '');
}
