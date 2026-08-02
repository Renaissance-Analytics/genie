import { serviceContainerNameFor } from '../argv';
import { SERVICE_ENGINES, engineKeyFor, engineSpecFor } from './catalog';
import { engineRecordKeyFor } from './service-manager';
import type { ProvisionStrategy, ServiceEngine } from './catalog';
import type { DevServices } from './services-config';
import type { ContainerState } from '../container-runtime';

/**
 * PURE. The MACHINE's view of the shared service engines (#234 P3, workstation
 * half).
 *
 * ## Why this is not another workspace list
 *
 * Everything else in the Dev Server answers a per-workspace question. This one
 * cannot be asked per workspace, because the thing it is about is not
 * per-workspace: one `postgres:16` container serves every workspace pinned to
 * Postgres 16, and its lifecycle is reference-counted across all of them. A
 * workspace panel can honestly say "this project uses Postgres 16"; only a
 * MACHINE view can say "one container, six projects, stopping it stops all six"
 * — which is the sentence a person needs before they touch anything.
 *
 * ## Three states that are routinely confused
 *
 * `installed` (the image is on disk), `state` (a container exists / is up) and
 * `holders` (workspaces using it right now) are independent, and every pair of
 * them occurs in practice:
 *
 *   - installed, absent — an engine pulled once and never started again. Several
 *     gigabytes with nothing to show for it, and invisible everywhere else.
 *   - running, zero holders — an engine carries `restart: unless-stopped`, so a
 *     reboot brings it up before Genie opens. Adoption fixes the count, but
 *     until a workspace acquires it this is exactly what is true.
 *   - configured, not held — a workspace has the engine defined but disabled.
 *
 * Flattening them into one "status" is how someone deletes a volume six other
 * projects were using, so they stay three fields.
 *
 * ## The names, not just the count
 *
 * `holders: 6` is a number. `workspaces: ['web', 'api', …]` is an answer. The
 * shared model's whole risk is acting on a container without knowing who else
 * is on it, so the row carries who.
 */

// --- what a caller sees -----------------------------------------------------

/** `absent` = no container at all; `stopped` = one exists but is not up. The
 *  two need different actions, so they are not merged. */
export type EngineInventoryState = 'running' | 'stopped' | 'absent';

export interface EngineInventoryRow {
    /** The CONTAINER's identity: the engine key, or `<engineKey>@<workspaceId>`
     *  for a dedicated one. What a machine-level action names. */
    recordKey: string;
    /** `<engine>-<major>` — the SHARING unit. */
    engineKey: string;
    engine: ServiceEngine;
    version: string;
    label: string;
    summary: string;
    provision: ProvisionStrategy;
    /** The image this engine runs. Reported so the caller knows what to probe,
     *  and so a human can see what would be downloaded. */
    image: string;
    containerName: string;
    /** The image is on this machine. Established WITHOUT downloading anything. */
    installed: boolean;
    state: EngineInventoryState;
    containerId?: string;
    dedicated: boolean;
    /** Present on a dedicated engine: the workspace that owns the container. */
    ownerWorkspaceId?: string;
    /** Workspaces holding it right now — the live reference count. */
    holders: number;
    /** Workspaces that have it configured at all, enabled or not. */
    configured: number;
    /** WHO — workspace labels, in the order they were listed. */
    workspaces: string[];
}

export interface EngineInventoryInput {
    /** Every workspace's stored services. */
    configs: Array<{ workspaceId: string; workspaceLabel: string; services: DevServices }>;
    /** Image refs present on this machine. */
    images: ReadonlySet<string>;
    /** Engine containers the runtime reported, keyed by container NAME. */
    containers: ReadonlyMap<string, { id: string; state: ContainerState }>;
    /** The manager's live reference count: workspace ids per recordKey. */
    holders: ReadonlyMap<string, ReadonlySet<string>>;
}

// --- the aggregation --------------------------------------------------------

interface Draft {
    engine: ServiceEngine;
    version: string;
    dedicated: boolean;
    ownerWorkspaceId?: string;
    image: string;
    workspaces: string[];
}

/** Running first, then merely installed, then the rest — a machine-wide list is
 *  long, and "what is eating my laptop" must not need sorting. */
const RANK: Record<EngineInventoryState, number> = { running: 0, stopped: 1, absent: 2 };

export function buildEngineInventory(input: EngineInventoryInput): EngineInventoryRow[] {
    const drafts = new Map<string, Draft>();

    // 1. The CATALOG — every pinned version of every real engine, so the page can
    //    say what this machine could run even when it is running nothing. `custom`
    //    is excluded: it has no image until a workspace names one.
    for (const engine of SERVICE_ENGINES) {
        const spec = engineSpecFor(engine);
        if (spec.alwaysDedicated) continue;
        for (const version of spec.versions) {
            const engineKey = engineKeyFor(engine, version);
            drafts.set(engineKey, {
                engine,
                version,
                dedicated: false,
                image: spec.image(version),
                workspaces: [],
            });
        }
    }

    // 2. What the workspaces actually asked for. A dedicated engine (and every
    //    `custom` one, which is always dedicated) is its OWN container with its
    //    own volume, so it gets its own record rather than being counted against
    //    the shared engine it would otherwise look like.
    for (const { workspaceId, workspaceLabel, services } of input.configs) {
        for (const config of Object.values(services)) {
            const spec = engineSpecFor(config.engine);
            const dedicated = config.dedicated || Boolean(spec.alwaysDedicated);
            const engineKey = engineKeyFor(config.engine, config.version);
            const recordKey = engineRecordKeyFor(engineKey, dedicated ? workspaceId : null);
            const image =
                config.engine === 'custom' ? config.image ?? '' : spec.image(config.version);
            const existing = drafts.get(recordKey);
            if (existing) {
                existing.workspaces.push(workspaceLabel);
                continue;
            }
            drafts.set(recordKey, {
                engine: config.engine,
                version: config.version,
                dedicated,
                ...(dedicated ? { ownerWorkspaceId: workspaceId } : {}),
                image,
                workspaces: [workspaceLabel],
            });
        }
    }

    const rows: EngineInventoryRow[] = [];
    for (const [recordKey, draft] of drafts) {
        const spec = engineSpecFor(draft.engine);
        const engineKey = engineKeyFor(draft.engine, draft.version);
        const containerName = serviceContainerNameFor(engineKey, draft.ownerWorkspaceId);
        const container = input.containers.get(containerName);
        rows.push({
            recordKey,
            engineKey,
            engine: draft.engine,
            version: draft.version,
            label: spec.label,
            summary: spec.summary,
            provision: spec.provision,
            image: draft.image,
            containerName,
            installed: draft.image ? input.images.has(draft.image) : false,
            state: container ? (container.state === 'running' ? 'running' : 'stopped') : 'absent',
            ...(container ? { containerId: container.id } : {}),
            dedicated: draft.dedicated,
            ...(draft.ownerWorkspaceId ? { ownerWorkspaceId: draft.ownerWorkspaceId } : {}),
            holders: input.holders.get(recordKey)?.size ?? 0,
            configured: draft.workspaces.length,
            workspaces: draft.workspaces,
        });
    }

    return rows.sort((a, b) => {
        const byState = RANK[a.state] - RANK[b.state];
        if (byState !== 0) return byState;
        // Within a state, something on disk outranks something that would have to
        // be downloaded — the same "what is already here" ordering.
        if (a.installed !== b.installed) return a.installed ? -1 : 1;
        if (a.engine !== b.engine) return a.engine.localeCompare(b.engine);
        return b.version.localeCompare(a.version, undefined, { numeric: true });
    });
}

/** Every image this inventory would report on — what the caller probes with
 *  `imageExists`. Deduped, and NEVER pulled: opening a page must not start a
 *  multi-gigabyte download. */
export function inventoryImages(
    configs: EngineInventoryInput['configs'],
): string[] {
    const images = new Set<string>();
    for (const engine of SERVICE_ENGINES) {
        const spec = engineSpecFor(engine);
        if (spec.alwaysDedicated) continue;
        for (const version of spec.versions) images.add(spec.image(version));
    }
    for (const { services } of configs) {
        for (const config of Object.values(services)) {
            const image =
                config.engine === 'custom'
                    ? config.image ?? ''
                    : engineSpecFor(config.engine).image(config.version);
            if (image) images.add(image);
        }
    }
    return [...images];
}
