import type { AgentRecord } from './identity.js';

type AcpProvider = AgentRecord['provider'];

/**
 * SIDECARS (§6.2) — pure. `<driver>-slave` is an agent's own review partner: its own identity, its own
 * context, registered in the caller's workspace and tied to the caller by `sidecarOf`. One per agent per
 * driver — a second ask REJOINS the existing one. A sidecar never spawns a sidecar. Genie never stops one
 * for you: nothing here links the parent's stop to the sidecar's; only the person, a hibernate or an
 * upgrade ends it.
 */

export function sidecarName(driver: AcpProvider): string {
    return `${driver}-slave`;
}

export function isSidecarName(name: string): boolean {
    return name.endsWith('-slave');
}

export type SidecarPlan =
    | { kind: 'existing'; record: AgentRecord }
    | { kind: 'register'; name: string; workspaceId: string; provider: AcpProvider; sidecarOf: string }
    | { kind: 'refused'; reason: string };

export function sidecarPlan(input: { caller: { id: string; name: string; workspaceId: string }; driver: AcpProvider; existing: readonly AgentRecord[] }): SidecarPlan {
    if (isSidecarName(input.caller.name)) return { kind: 'refused', reason: `${input.caller.name} is a sidecar; a sidecar does not spawn a sidecar` };
    const name = sidecarName(input.driver);
    const mine = input.existing.find((r) => r.workspaceId === input.caller.workspaceId && r.name === name && r.sidecarOf === input.caller.id);
    if (mine) return { kind: 'existing', record: mine };
    return { kind: 'register', name, workspaceId: input.caller.workspaceId, provider: input.driver, sidecarOf: input.caller.id };
}
