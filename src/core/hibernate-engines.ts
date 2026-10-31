import type { ServiceInstance } from './services.js';

/**
 * WHICH ENGINES A HIBERNATION RELEASES, A WAKE RESUMES, AND A RESTART LEAVES ASLEEP (parity audit 2026-10-30, top-15 #12).
 *
 * Genie 2's hibernate stopped a workspace's agents, terminals and processes and never told the service registry, so a
 * sleeping workspace's Postgres and Redis ran on. Genie 1 (v0.7.0-beta.342) released them — `main/workspace/
 * hibernation.ts` step 3: "services released (an engine nobody else holds stops with it, so resources aren't burning for
 * no reason)", through `main/dev-server/lifecycle.ts` `teardown` — and its wake brought every enabled service back
 * (`onWorkspaceWake`, "as a fresh boot would"). A hibernated workspace stays asleep through restarts and upgrades
 * (`hibernation.ts`'s header; Genie 2's `core/workspace-model.ts` `staysAsleepThrough`).
 *
 * WHO USES AN ENGINE is the registry's own rule (`chosen`: `ServiceRegistry.choices(ws)`'s chosen engine per kind —
 * the one whose env the workspace gets), plus a dedicated engine's owner, which uses it whether or not it is chosen
 * (a `custom` image is never "chosen" and still belongs to its workspace).
 */
export interface EngineUse {
    /** The engine ids a workspace uses now: `registry.choices(ws)`'s chosen ones. */
    readonly chosen: (workspaceId: string) => ReadonlySet<string>;
}

type Workspaces = readonly { readonly id: string; readonly asleep: boolean }[];

const ownedBy = (i: ServiceInstance, workspaceId: string): boolean => i.scope.kind === 'dedicated' && i.scope.workspaceId === workspaceId;
const usedBy = (i: ServiceInstance, workspaceId: string, use: EngineUse): boolean => ownedBy(i, workspaceId) || use.chosen(workspaceId).has(i.id);

/**
 * Hibernating `workspaceId`: its own engines, and each shared one it uses that NO OTHER AWAKE workspace uses. A shared
 * engine another awake workspace still uses stays up (Genie 1: released, so the refcount drops — the engine stops only
 * when nobody else holds it).
 */
export function enginesToRelease(input: EngineUse & { workspaceId: string; instances: readonly ServiceInstance[]; workspaces: Workspaces }): string[] {
    const othersAwake = input.workspaces.filter((w) => w.id !== input.workspaceId && !w.asleep).map((w) => w.id);
    return input.instances
        .filter((i) => {
            if (ownedBy(i, input.workspaceId)) return true;
            if (i.scope.kind !== 'shared' || !input.chosen(input.workspaceId).has(i.id)) return false;
            return !othersAwake.some((ws) => usedBy(i, ws, input));
        })
        .map((i) => i.id);
}

/** Waking `workspaceId`: every engine it uses, its own and shared — except one the person stopped, which stays stopped. */
export function enginesToResume(input: EngineUse & { workspaceId: string; instances: readonly ServiceInstance[]; personStopped: ReadonlySet<string> }): string[] {
    return input.instances.filter((i) => usedBy(i, input.workspaceId, input) && !input.personStopped.has(i.id)).map((i) => i.id);
}

/**
 * At Genie start: an engine that ONLY sleeping workspaces use stays stopped — an asleep workspace's own engine, or a
 * shared one with at least one user, every one of them asleep. A shared engine nobody uses is not this rule's business.
 */
export function asleepOnlyEngine(i: ServiceInstance, input: EngineUse & { workspaces: Workspaces }): boolean {
    if (i.scope.kind === 'dedicated') {
        const owner = i.scope.workspaceId;
        return input.workspaces.some((w) => w.id === owner && w.asleep);
    }
    const users = input.workspaces.filter((w) => usedBy(i, w.id, input));
    return users.length > 0 && users.every((w) => w.asleep);
}
