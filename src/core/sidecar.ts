import type { AgentRecord } from './identity.js';

type AcpProvider = AgentRecord['provider'];

/**
 * SIDECARS (§6.2) — pure. `<agent>-slave` is an agent's own review partner: its own identity, its own context,
 * registered in the caller's workspace and tied to the caller by `sidecarOf`. ONE per agent — a second ask
 * REJOINS the existing one. A sidecar never spawns a sidecar. Genie never stops one for you: nothing here links
 * the parent's stop to the sidecar's; only the person, a hibernate or an upgrade ends it.
 *
 * ## Named after the AGENT, never the provider (B27, owner 2026-10-15)
 *
 * The spec's `<driver>-slave` is Genie 1's convention, and in Genie 1 the "driver" is the agent that DRIVES the
 * sidecar (`repos/genie/main/agents/sidecar.ts`, `sidecarNameFor(driverName)`): `codex:tynn-slave` is tynn's,
 * `codex:moic-slave` is moic's. This module once read "driver" as the provider and named every sidecar
 * `claude-slave` / `codex-slave`, so tynn — which already had `tynn-slave`, carried over by the v1 import —
 * asked for its sidecar and got a brand-new `codex-slave`; and two agents in one workspace would have shared one.
 *
 * ## Which record is the agent's sidecar
 *
 * 1. `<agent>-slave` in the caller's workspace — the name is the identity (workspace, name), and it is the only
 *    mark a Genie 1 sidecar carries: the v1 import writes no `sidecarOf`. If another agent owns that name, it is
 *    refused, never shared or duplicated.
 * 2. Otherwise a record whose `sidecarOf` is the caller, whatever its name — a renamed sidecar, or a
 *    `<provider>-slave` registered before this fix. Checked SECOND because an install can hold both (the owner's
 *    does: `tynn-slave` and the `codex-slave` this bug made), and the canonical name is the one the person knows.
 *
 * If the agent's sidecar runs on another provider than the one asked for, the ask is REFUSED in words: Genie does
 * not register a second sidecar for you, and does not switch the existing one's driver behind the person's back.
 */

export function sidecarName(agentName: string): string {
    return `${agentName}-slave`;
}

export function isSidecarName(name: string): boolean {
    return name.endsWith('-slave');
}

export type SidecarPlan =
    | { kind: 'existing'; record: AgentRecord }
    | { kind: 'register'; name: string; workspaceId: string; provider: AcpProvider; sidecarOf: string }
    | { kind: 'refused'; reason: string };

export function sidecarPlan(input: { caller: { id: string; name: string; workspaceId: string }; driver: AcpProvider; existing: readonly AgentRecord[] }): SidecarPlan {
    const { caller, driver } = input;
    if (isSidecarName(caller.name)) return { kind: 'refused', reason: `${caller.name} is a sidecar; a sidecar does not spawn a sidecar` };
    const name = sidecarName(caller.name);
    const here = input.existing.filter((r) => r.workspaceId === caller.workspaceId && r.id !== caller.id);
    const named = here.find((r) => r.name === name);
    if (named && named.sidecarOf && named.sidecarOf !== caller.id) {
        return { kind: 'refused', reason: `${name} in this workspace is the sidecar of another agent; Genie does not share or duplicate it` };
    }
    const linked = here.filter((r) => r.sidecarOf === caller.id);
    const mine = named ?? linked.find((r) => r.provider === driver) ?? linked[0];
    if (mine) {
        if (mine.provider === driver) return { kind: 'existing', record: mine };
        return { kind: 'refused', reason: `${mine.name} is your sidecar and runs on ${mine.provider}, not ${driver}; ask for agent "${mine.provider}" to rejoin it. Genie does not register a second sidecar for you.` };
    }
    return { kind: 'register', name, workspaceId: caller.workspaceId, provider: driver, sidecarOf: caller.id };
}
