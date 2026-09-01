/**
 * PURE. Which workspace is SACRED, and which reserved name it may use.
 *
 * The owner's rule: *"the tynn workspace should be somehow marked as a sacred
 * workspace in tynn and when in genie (just cosmetic in genie, you use the same
 * tools and guides everyone else uses)"*.
 *
 * SACRED IS COSMETIC PLUS ONE EXEMPTION. It grants no tools, no permissions and
 * no different guides — a sacred workspace uses exactly what every other
 * workspace uses. The single behavioural difference is that it may hold an agent
 * under one otherwise-reserved name (`agents/reserved-names.ts`).
 *
 * THE FLAG HAS EXACTLY ONE HOME — Tynn — and Genie converges on it, the same
 * shape as `is_gapp`/`planGappDevSync`. There is deliberately no Genie-side
 * toggle: a second home is a second answer, and the two drift. It is what makes
 * "mark it in Tynn and Genie notices" true.
 *
 * Tynn sends a NAME, not a boolean. A boolean would leave Genie guessing WHICH
 * term was granted, and the obvious guess — the workspace slug — is wrong in the
 * one case that matters: the Tynn workspace's slug is `tynn-ai` while the name
 * it needs is `tynn`.
 */

import { isReservedAgentName } from '../agents/reserved-names';

/** The bit of a workspace row this decision needs. */
export interface SacredWorkspace {
    id: string;
    /** The currently stored grant (`workspaces.sacred_name`). */
    sacred_name: string | null;
    /** The linked Tynn project, or null when the workspace is not Tynn-linked. */
    tynnProjectId: string | null;
}

/** The bit of a backend project this decision needs. */
export interface SacredProject {
    id: string;
    /** The reserved agent name Tynn grants this project's workspace, if any. */
    sacredAgentName?: string | null;
}

/** A workspace whose grant should change, and what to. */
export interface SacredChange {
    id: string;
    next: string | null;
}

/** Normalise a grant, or null when it is not one Genie can honour. */
function grant(raw: string | null | undefined): string | null {
    const name = String(raw ?? '').trim().toLowerCase();
    // A grant is an EXEMPTION FROM the block list, not a claim on a name. A term
    // Genie does not reserve is already allowed everywhere, so honouring it
    // would store a grant that means nothing and imply Genie reserves it.
    if (!name || !isReservedAgentName(name)) return null;
    return name;
}

/**
 * The changes that bring stored grants in line with what Tynn says.
 *
 * Emits ONLY rows that actually change, so a project fetch that learns nothing
 * new does not churn `updated_at` or fire a workspaces-changed broadcast — a row
 * rewritten to itself makes every fetch look like a change.
 *
 * A project MISSING from `projects` is "no answer" and is left alone; a project
 * that answers WITHOUT the field is saying "not marked", exactly as `is_gapp`
 * reads an absent flag through `!!`.
 */
export function planSacredSync(
    workspaces: readonly SacredWorkspace[],
    projects: readonly SacredProject[],
): SacredChange[] {
    const known = new Map<string, string | null>();
    for (const p of projects) known.set(p.id, grant(p.sacredAgentName));

    const changes: SacredChange[] = [];
    for (const ws of workspaces) {
        // The RAW stored value, not `grant(...)` of it. Filtering both sides
        // would make a column holding an inert term look identical to an empty
        // one, and the junk would never be cleaned out.
        const current = String(ws.sacred_name ?? '').trim().toLowerCase() || null;
        let next: string | null;
        if (ws.tynnProjectId === null) {
            // Not linked: no Tynn speaks for it, so it cannot hold a grant Tynn
            // gave.
            next = null;
        } else {
            const answer = known.get(ws.tynnProjectId);
            if (answer === undefined) continue; // no answer — leave it alone
            next = answer;
        }
        if (next !== current) changes.push({ id: ws.id, next });
    }
    return changes;
}
