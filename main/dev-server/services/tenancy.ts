import { engineKeyFor, engineSpecFor, workspaceSqlIdentifier } from './catalog';
import { engineRecordKeyFor } from './service-manager';
import type { ServiceEngine } from './catalog';
import type { DevServices } from './services-config';
import type { DevWorkspace } from '../site-manager';

/**
 * PURE. Who else has data in a shared engine's volume — and therefore whether
 * dropping it is destruction (Tynn #250, step 4).
 *
 * ## The confusion this exists to end
 *
 * A shared engine's state lives in ONE named volume for the whole machine:
 * `genie-svc-postgres-17-data` holds the database of every workspace pinned to
 * Postgres 17. `remove --purge` deletes that volume, and the guard in front of
 * it used to ask *"is anyone HOLDING this engine?"* — the manager's live
 * reference count, filled on acquire and emptied on release.
 *
 * That is the wrong question, and the gap between the two is where data went.
 * Holding is about a connection **right now**; a Genie App whose window is
 * closed holds nothing, and neither does a project nobody has opened since Genie
 * started. Their databases are in that volume all the same. So one
 * `manageService remove … purge=true` from the only open workspace deleted them,
 * and reported `ok: true` while doing it.
 *
 * **Co-tenancy on a shared volume is a property of who has a SLICE PROVISIONED
 * in it, not of who happens to be connected.** That is the whole of this module.
 *
 * ## Why this cannot be the engine's job
 *
 * Everywhere else, the boundary between two workspaces is enforced by the engine
 * itself — a Postgres role that cannot `CONNECT` to another workspace's
 * database, a MySQL grant scoped to one schema, a Redis ACL pinned to one key
 * prefix (`provision.ts`). Those hold against anything a development agent can
 * type, which is exactly why they are preferred.
 *
 * A volume is different in kind. Docker has no notion of a volume with three
 * tenants, and Genie holds the socket: by the time `volumeRemove` is called
 * there is no server left to appeal to. This is the one place where the guard
 * must be Genie's own, so it is written to FAIL CLOSED — an unreadable
 * workspace makes the tenancy unknown, and unknown is treated as occupied.
 *
 * ## Disabled still counts
 *
 * A service with `enabled: false` is not running, but its database was created
 * when it was enabled and is still sitting in the volume. Data outlives the
 * flag, so tenancy is read off the stored definition regardless of it. The same
 * reasoning as `inventory.ts`, which counts `configured` the same way.
 */

// --- what a tenant is -------------------------------------------------------

/** A workspace whose data is inside the volume — an installed Genie App or an
 *  ordinary project; the volume cannot tell them apart, and neither can a purge. */
export interface SliceTenant {
    workspaceId: string;
    /** The human name, for the refusal a person or an agent reads. */
    label: string;
    /** What this workspace's data is CALLED inside the engine — the database,
     *  role, or key prefix. Naming it is what makes a refusal checkable: the
     *  reader can go and look. */
    identifier: string;
    /** Set when this workspace hosts a Genie App (`app`), is one under
     *  development (`app-dev`), or is the throwaway workspace of a PREVIEW
     *  window (`app-preview`). All three hold real app data. */
    appKind?: 'app' | 'app-dev' | 'app-preview';
}

export interface SliceTenancy {
    /** Every OTHER workspace with a slice in this container's volume. */
    tenants: SliceTenant[];
    /** Workspaces whose stored services could not be read. Any entry here means
     *  the tenancy is UNKNOWN — see the fail-closed note in the header. */
    unreadable: string[];
}

export interface TenancyQuery {
    /** The CONTAINER whose volume is in question: an engine key, or
     *  `<engineKey>@<workspaceId>` for a dedicated one. */
    recordKey: string;
    /** The workspace asking. Excluded from the result — it is purging its own. */
    askingWorkspaceId: string;
    workspaces: readonly DevWorkspace[];
    /** May throw; a throw is what `unreadable` is for. */
    servicesFor: (workspaceId: string) => DevServices;
}

/**
 * Every workspace OTHER than the asker that has a slice in this container.
 *
 * A dedicated engine answers this trivially — its recordKey carries the owning
 * workspace, so no one else can match it — which is why flipping a service to
 * `dedicated` is the honest escape hatch from a refusal.
 */
export function sliceTenantsOf(query: TenancyQuery): SliceTenancy {
    const tenants: SliceTenant[] = [];
    const unreadable: string[] = [];

    for (const workspace of query.workspaces) {
        if (workspace.id === query.askingWorkspaceId) continue;
        let services: DevServices;
        try {
            services = query.servicesFor(workspace.id);
        } catch {
            unreadable.push(workspace.label || workspace.id);
            continue;
        }
        for (const config of Object.values(services)) {
            const spec = engineSpecFor(config.engine);
            const dedicated = config.dedicated || Boolean(spec.alwaysDedicated);
            const recordKey = engineRecordKeyFor(
                engineKeyFor(config.engine, config.version),
                dedicated ? workspace.id : null,
            );
            if (recordKey !== query.recordKey) continue;
            tenants.push({
                workspaceId: workspace.id,
                label: workspace.label || workspace.id,
                identifier: workspaceSqlIdentifier(workspace.id),
                ...(workspace.appKind ? { appKind: workspace.appKind } : {}),
            });
            // One slice per container per workspace: two versions of an engine
            // are two containers, so a second match here cannot happen.
            break;
        }
    }

    // Genie Apps first. The refusal is read by someone deciding whether to press
    // on, and "an installed app's data" is the fact that decides it.
    tenants.sort((a, b) => Number(Boolean(b.appKind)) - Number(Boolean(a.appKind)));
    return { tenants, unreadable };
}

// --- the verdict ------------------------------------------------------------

/** `allowed: false` carries the whole explanation, because a refusal nobody can
 *  act on just becomes a `force` flag later. */
export type PurgeVerdict = { allowed: true } | { allowed: false; reason: string };

function nameOf(tenant: SliceTenant): string {
    const what =
        tenant.appKind === 'app'
            ? `the Genie App “${tenant.label}”`
            : tenant.appKind === 'app-dev'
              ? `“${tenant.label}”, where a Genie App is being developed`
              : tenant.appKind === 'app-preview'
                ? `“${tenant.label}”, a Genie App open in a preview window`
                : `“${tenant.label}”`;
    return `${tenant.identifier} — ${what}`;
}

/** `a`, `a and b`, `a, b and c`. */
function listOf(parts: string[]): string {
    if (parts.length <= 1) return parts[0] ?? '';
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * May this purge drop the volume?
 *
 * Fail closed by construction: the only branch that returns `allowed: true` is
 * the one where the tenancy was read in full AND came back empty.
 */
export function purgeVerdict(input: {
    engine: ServiceEngine;
    version: string;
    /** The named volume about to be removed — the thing a person can go and check. */
    volume: string;
    tenancy: SliceTenancy;
}): PurgeVerdict {
    const { engine, version, volume, tenancy } = input;

    if (tenancy.unreadable.length > 0) {
        return {
            allowed: false,
            reason:
                `Genie could not read the stored services of ${listOf(tenancy.unreadable)}, so it ` +
                `cannot tell whether the shared ${engine} ${version} data volume ${volume} also holds ` +
                'another workspace’s database. An unknown tenancy is treated as occupied: this is ' +
                'the one case where guessing destroys data that cannot be brought back.',
        };
    }

    if (tenancy.tenants.length === 0) return { allowed: true };

    const apps = tenancy.tenants.filter((t) => t.appKind).length;
    return {
        allowed: false,
        reason:
            `Purging would delete ${volume}, the data volume the shared ${engine} ${version} engine ` +
            `keeps every workspace’s database in — including ` +
            `${listOf(tenancy.tenants.map(nameOf))}. ` +
            (apps > 0
                ? 'An installed Genie App keeps its real data there, and closing its window does not ' +
                  'move it. '
                : '') +
            'Nothing was holding the engine because those workspaces are not open right now; their ' +
            'data is in that volume regardless. Remove their services first if you truly mean to ' +
            'drop it, or set this workspace’s service to `dedicated` — its own container and ' +
            'its own volume — and purge that instead.',
    };
}
