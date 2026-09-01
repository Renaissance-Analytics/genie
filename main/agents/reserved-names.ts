/**
 * PURE. Terms that may not be an agent's NAME (genie#324 follow-on).
 *
 * Three terms are refused: `general`, `genie`, `tynn`.
 *
 * `general` is here because it was never a name anyone chose. `normalizePurpose`
 * returns it for an agent that joins with no stated purpose, so an unnamed
 * terminal silently became `{tui}:general` — indistinguishable from a deliberate
 * name. On one workstation that minted 7 of 29 agents across seven workspaces.
 * #326 stopped Genie INVENTING them; this stops a person or an agent typing one
 * back in.
 *
 * `genie` and `tynn` are here because they name the products. An agent called
 * `tynn` in someone's side project reads as THE Tynn agent in every roster, DM
 * and channel it appears in, and there is no second field to disambiguate it —
 * the ref is the identity a person says out loud.
 *
 * THE EXEMPTION is not a hard-coded `tynn`. A SACRED workspace carries
 * `sacred_name` — the ONE reserved term it is permitted to use. So the Tynn
 * workspace holds an agent named `tynn` and nothing else anywhere may, and a
 * second sacred workspace needs no code change to be granted its own name.
 * Granting ONE term rather than a boolean also keeps `sacred` from being a
 * skeleton key: being granted `tynn` does not also unlock `genie`.
 *
 * It is NOT keyed on the workspace SLUG, which was the first design and was
 * wrong twice over. The Tynn workspace's slug is `tynn-ai` (`project.json` has
 * `tynn.project: "Tynn.ai"`, and `workspaceSlug` kebabs it), so the one agent
 * the owner said must be allowed would have been refused. And `slug.ts`
 * documents the slug as display-only and explicitly NOT unique across
 * workspaces — the wrong key for a rule that decides what may exist.
 *
 * Note the Genie OS Agent is NOT affected. It is a frozen constant
 * (`GENIE_OS_AGENT`, id `genie:workstation`, `workspaceId: null`) that is
 * deliberately never persisted as a workspace agent, so it never passes through
 * registration and never consults this list.
 */

/** The terms refused as an agent name. */
export const RESERVED_AGENT_NAMES: readonly string[] = Object.freeze([
    'general',
    'genie',
    'tynn',
]);

/**
 * Is this name a reserved term?
 *
 * Matched on the WHOLE name, never a substring — `tynnbuilder` is its own agent
 * and `genie-cloud` is a legitimate name. This mirrors `terminalsToStopFor`,
 * which matches whole names so `tynnbuilder` is never stopped as `tynn`'s.
 */
export function isReservedAgentName(name: string): boolean {
    return RESERVED_AGENT_NAMES.includes(String(name ?? '').trim().toLowerCase());
}

export interface ReservedNameCheck {
    /** The agent's name, already normalised by `agentName`. */
    name: string;
    /**
     * The ONE reserved term the owning workspace is permitted to use
     * (`workspaces.sacred_name`), or null/absent for an ordinary workspace.
     *
     * A grant that is not itself a reserved term is INERT — it cannot reserve a
     * name that was never on the list, and it confers no power over the terms
     * that are.
     */
    sacredName?: string | null;
}

/**
 * `null` when the name is allowed; otherwise the refusal to hand back.
 *
 * Returns the MESSAGE rather than throwing, because both call sites — the MCP
 * `registerAgent` tool and the UI's create flow — already return
 * `{ ok: false, error }` and a throw would have to be caught and reshaped at
 * each of them.
 */
export function reservedNameRefusal(input: ReservedNameCheck): string | null {
    const name = String(input.name ?? '').trim().toLowerCase();
    if (!isReservedAgentName(name)) return null;

    // The workspace's granted term, and only that one. The grant must itself be
    // reserved, so a workspace handed `frontend` gains nothing here.
    const granted = String(input.sacredName ?? '').trim().toLowerCase();
    if (granted && isReservedAgentName(granted) && name === granted) return null;

    return (
        `"${name}" is a reserved name and cannot be used for an agent. ` +
        `Reserved: ${RESERVED_AGENT_NAMES.join(', ')}. ` +
        'Give the agent a name that says what it does.'
    );
}
