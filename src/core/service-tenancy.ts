import { dataVolumeOf, type ServiceInstance } from './services.js';

/**
 * WHOSE DATA IS IN AN ENGINE'S VOLUME — and therefore whether "delete data" is destruction (hosting ship line H6).
 *
 * Genie 1 learned this the expensive way (repos/genie main/dev-server/services/tenancy.ts): its purge guard asked "is
 * anyone HOLDING this engine right now?", and a workspace whose window was closed held nothing — so one purge from the
 * only open workspace deleted every other workspace's database and reported success. Co-tenancy of a volume is a
 * property of who has DATA in it, not of who is connected. Here that is read off the record:
 *
 * - a multi-tenant engine (adopted from Genie 1, or a new shared one): every workspace with a SLICE — its database,
 *   role, ACL user or bucket is in the volume whether or not it is open, and whether or not it is the active version;
 * - a dedicated engine: its one workspace;
 * - a shared engine with no slices (Mailpit, Meilisearch, or one created before slices existed): every workspace on
 *   the machine is handed its connection, so Genie cannot know whose data it holds. UNKNOWN is treated as occupied —
 *   the one place where guessing destroys what cannot be brought back. It can still be removed keeping its data.
 *
 * `workspaceId` is who is asking: their own data is theirs to delete; any OTHER holder refuses it, by name. The volume
 * cannot appeal to the engine (Docker has no notion of a volume with three tenants), so this guard is Genie's alone and
 * fails closed. Agents never reach it: the `services` tool refuses `deleteData` outright, before anything is asked.
 */

export type DeleteDataVerdict =
    | { readonly allowed: true; readonly volume: string | null; readonly deletes: string }
    | { readonly allowed: false; readonly reason: string };

/** `a`, `a and b`, `a, b and c`. */
function listOf(parts: readonly string[]): string {
    if (parts.length <= 1) return parts[0] ?? '';
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Each workspace with data in the instance's volume, and what that data is CALLED there — so a refusal can be checked. */
export function dataHolders(i: ServiceInstance): { workspaceId: string; holds: string }[] | null {
    if (i.slices !== undefined) {
        const holders = Object.entries(i.slices).map(([workspaceId, s]) => ({ workspaceId, holds: s.bucket ?? s.identifier }));
        // An adopted DEDICATED engine is its workspace's even where Genie 1 recorded no slice for it.
        const owner = i.scope.kind === 'dedicated' ? i.scope.workspaceId : null;
        if (owner !== null && !holders.some((h) => h.workspaceId === owner)) holders.push({ workspaceId: owner, holds: `${i.engine} ${i.version}` });
        return holders;
    }
    if (i.scope.kind === 'dedicated') return [{ workspaceId: i.scope.workspaceId, holds: i.credentials.database ?? `${i.engine} ${i.version}` }];
    return null;
}

/** The one workspace whose data an engine holds, if there is exactly one — who a person's "delete data" acts for. */
export function soleHolderOf(i: ServiceInstance): string | undefined {
    const holders = dataHolders(i);
    return holders && holders.length === 1 ? holders[0]!.workspaceId : undefined;
}

/**
 * May `workspaceId` delete this engine's data? `label` names a workspace for a person (the Services tab passes its
 * workspace names); without it the id is said.
 */
export function deleteDataVerdict(i: ServiceInstance, workspaceId?: string, label: (workspaceId: string) => string = (id) => id): DeleteDataVerdict {
    const named = (h: { workspaceId: string; holds: string }): string => `${h.holds} (workspace ${label(h.workspaceId)})`;
    const what = `${i.engine} ${i.version}`;
    const volume = dataVolumeOf(i);
    if (volume === null) return { allowed: true, volume: null, deletes: `nothing: ${what} is a custom image and keeps no data volume` };
    const holders = dataHolders(i);
    if (holders === null) {
        return {
            allowed: false,
            reason: `${what} is shared, and every workspace on this machine is handed its connection, so Genie cannot tell whose data its volume ${volume} holds. Unknown is treated as in use: nothing was deleted. Remove it keeping its data instead.`,
        };
    }
    const others = holders.filter((h) => h.workspaceId !== workspaceId);
    if (others.length > 0) {
        return {
            allowed: false,
            reason: `Deleting ${volume} would delete what other workspaces keep in ${what}: ${listOf(others.map(named))}. That data is there whether or not those workspaces are open; nothing was removed. Remove it keeping its data instead.`,
        };
    }
    const own = holders.filter((h) => h.workspaceId === workspaceId);
    return { allowed: true, volume, deletes: own.length > 0 ? `${volume}, with ${listOf(own.map(named))}` : `${volume} (no workspace keeps data in it)` };
}
