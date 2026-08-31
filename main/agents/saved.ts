/**
 * PURE. What `runAgent start` should DO — reattach, create, or refuse (Tynn #254).
 *
 * The complaint this answers: `runAgent start` minted a new agent every call, so
 * the workspace roster filled with strangers nobody could name, reopen, or hand
 * to a teammate. The fix is not a flag on the spawn; it is that starting an
 * agent RESOLVES a saved one first, and bringing a NEW one into existence is a
 * separate, stated act.
 *
 * A SAVED AGENT IS A TERMINAL SPEC. Not a new record type — `terminal_specs`
 * already belongs to a workspace, already survives its pty (that is what makes a
 * dead agent revivable rather than gone), and already carries every field this
 * needs: `meta.agent` (provider), `meta.whisper_purpose` (name), `meta.agent_id`
 * (the durable AgentInbox identity), `meta.agent_command`, `meta.chat_session_id`.
 * So a saved agent is a VIEW over the specs a workspace already has, and this
 * module is the reading of it — no migration, no second store to keep in sync,
 * and an agent stays a durable AMS identity in the sidebar while its live TUI
 * is rendered through a distinct AgentPanel on the Floor.
 *
 * The decision is separated from the doing because the doing is a pty spawn and
 * an approval modal. What is worth pinning is which of the three things happens,
 * and that a refusal happens BEFORE anything exists.
 */

import { agentName, isAgentProvider, savedAgentKey, type AgentProvider } from './identity';

/** A saved agent, as read off the workspace's terminal specs. */
export interface SavedAgent {
    /** The terminal spec id. A saved agent IS that spec — this is not a join key. */
    specId: string;
    provider: AgentProvider;
    /** The agent's NAME — the saved-config half of its identity. */
    name: string;
    /**
     * The durable AgentInbox identity (`meta.agent_id`), which is what makes a
     * reattach a reattach: inbox cursors, queued mail, channel membership and DM
     * history all hang off this, so a "restart" that minted a new one would be a
     * new agent wearing the old one's name.
     */
    agentId: string | null;
    /**
     * The harness's chat session, when bound. NULL is normal, not an error:
     * Codex has none until its SessionStart hook fires, and the whole design
     * exists so that gap never blocks resolution.
     */
    chatSessionId: string | null;
    /** Is its pty running right now? A saved agent that is not live is not gone. */
    live: boolean;
}

/** The spec shape this module reads. Loose, so it stays free of the db types. */
export interface AgentSpecLike {
    id: string;
    workspace_id?: string | null;
    meta?: Record<string, unknown> | null;
}

/**
 * The agent-STAMPED TERMINAL SPECS of one workspace — not the workspace's agents.
 *
 * Read the name carefully, because the old one lied. This scans terminal specs
 * for `meta.agent` and returns what it finds. That is a TERMINAL lookup: it
 * answers "which terminal belongs to this agent" and "is there an unbound spec
 * to adopt", both of which are real questions.
 *
 * It is NOT the workspace's agent list. `workspace_agents` is (see
 * `listWorkspaceAgents`), and it has been since v50. An agent registered and
 * never started has no spec and does not appear here — which is correct for a
 * terminal lookup and would be a bug in an agent list. Using this as the agent
 * list is what made a dormant agent invisible and a leftover spec look like an
 * agent, and it is worth keeping the two straight.
 */
export function savedAgentsOf(
    specs: readonly AgentSpecLike[],
    workspaceId: string,
    isLive: (specId: string) => boolean,
): SavedAgent[] {
    const out: SavedAgent[] = [];
    for (const spec of specs) {
        if (spec.workspace_id !== workspaceId) continue;
        const provider = spec.meta?.agent;
        if (!isAgentProvider(provider)) continue;
        const chat = spec.meta?.chat_session_id;
        const agentId = spec.meta?.agent_id;
        out.push({
            specId: spec.id,
            provider,
            name: agentName(spec.meta?.whisper_purpose as string | undefined),
            agentId: typeof agentId === 'string' && agentId ? agentId : null,
            chatSessionId: typeof chat === 'string' && chat ? chat : null,
            live: isLive(spec.id),
        });
    }
    return out;
}

/** What the caller asked `runAgent start` for. */
export interface AgentStartRequest {
    /** The saved agent's name. Absent ⇒ the workspace's default (`general`). */
    name?: string;
    /**
     * The provider. Absent means "whichever provider this name is saved under" —
     * resolved from the record on a reattach, and from the WORKSTATION default
     * when creating (the caller passes that in as `workstationProvider`).
     */
    provider?: AgentProvider;
    /** Bring a NEW saved agent into existence. Creation is deliberate. */
    create?: boolean;
    /** The workstation's default provider, for a create that named none. */
    workstationProvider: AgentProvider;
}

export type AgentStartDecision =
    | {
          kind: 'reattach';
          agent: SavedAgent;
          /** `warm` — its pty is running; `revive` — the spec outlived its pty. */
          how: 'warm' | 'revive';
      }
    | { kind: 'create'; provider: AgentProvider; name: string }
    | { kind: 'refuse'; error: string };

/** Every candidate's name, for an error a caller can act on. The driver is
 *  named alongside rather than inside the key -- it is which TUI is fronted,
 *  not part of what the agent IS. */
function refsOf(agents: readonly SavedAgent[]): string {
    return agents.map((a) => `${savedAgentKey(a.name)} (${a.provider})`).join(', ');
}

/**
 * Reattach, create, or refuse.
 *
 * The rules, and why each one is a refusal rather than a guess:
 *
 *  - A name that resolves to ONE saved agent REATTACHES. This is the acceptance
 *    criterion of the whole story: `start` on a saved agent must not mint a
 *    second one, whether it is running (`warm`) or its pty has since died
 *    (`revive`). Both keep the same spec and the same `agent_id`.
 *
 *  - A name that resolves to SEVERAL (the same name under two providers) is
 *    AMBIGUOUS, and answering with either would silently attach the caller to a
 *    different conversation than the one it meant. The refusal names both refs,
 *    so the fix is to copy one into the call.
 *
 *  - A name that resolves to NOTHING needs `create`. This is the "distinct,
 *    deliberate act" — and it is why the tool no longer fills a roster by
 *    accident. The refusal lists what the workspace does have, because the
 *    overwhelmingly common cause is a caller reaching for an agent that exists
 *    under a slightly different name.
 *
 *  - `create` on a name the workspace ALREADY has is refused rather than
 *    silently reattaching. Two agents under one key is the state this design
 *    forbids, and a create that quietly became a reattach would hide from the
 *    caller that its "new" agent is carrying somebody else's history.
 */
export function decideAgentStart(
    saved: readonly SavedAgent[],
    req: AgentStartRequest,
): AgentStartDecision {
    const name = agentName(req.name);
    const byName = saved.filter((a) => a.name === name);
    const matches = req.provider ? byName.filter((a) => a.provider === req.provider) : byName;

    if (matches.length > 1) {
        return {
            kind: 'refuse',
            error:
                `"${name}" names more than one saved agent in this workspace (${refsOf(matches)}). ` +
                'Pass `agent` with the provider you mean — two providers under one name are two ' +
                'different agents with two different conversations.',
        };
    }

    const existing = matches[0];
    if (existing && req.create) {
        return {
            kind: 'refuse',
            error:
                `This workspace already has a saved agent "${savedAgentKey(existing.name)}". ` +
                'Start it without `create` to reattach to it, or create the new one under a ' +
                'different `name`.',
        };
    }
    if (existing) {
        return { kind: 'reattach', agent: existing, how: existing.live ? 'warm' : 'revive' };
    }

    if (!req.create) {
        const roster = saved.length
            ? `This workspace's saved agents: ${refsOf(saved)}.`
            : 'This workspace has no saved agents yet.';
        return {
            kind: 'refuse',
            error:
                `No saved agent "${name}" in this workspace. ${roster} ` +
                'Starting an agent reattaches to a saved one; to define a NEW agent, call again ' +
                'with `create: true` (and a `name` you will reopen it by).',
        };
    }

    // A create that named no provider takes the WORKSTATION's. The person paying
    // for the subscription decides which TUI their compute is spent on — the
    // same rule GApp agents follow. From here on the record PINS it: reattaching
    // never re-resolves the provider, because `codex:tynn-slave` is not a
    // stand-in for whatever this machine defaults to today, it is that agent.
    return { kind: 'create', provider: req.provider ?? req.workstationProvider, name };
}

/**
 * The terminal in this workspace that already IS the named agent, if any.
 *
 * `runAgent start` binds the terminal it creates onto the `workspace_agents`
 * row, and a bind REPLACES whatever was bound before — so creating while the
 * agent's previous terminal is still alive abandons that terminal. It keeps its
 * `meta.agent` and `whisper_purpose`, nothing reaps it, and the AMS grid draws a
 * square per agent-stamped spec, so it lingers as a second agent under the same
 * name. That is how one registered `claude:tynn` came to show three squares.
 *
 * Identity is (provider, name) — the registry's own unique key, and what the
 * grid renders — so adopting here cannot disagree with either. Liveness is NOT
 * part of it: a saved agent that is not running is not gone, and reviving it is
 * what keeps its conversation attached.
 */
export function adoptableAgentSpec(
    saved: readonly SavedAgent[],
    provider: AgentProvider,
    name: string,
): SavedAgent | undefined {
    return saved.find((item) => item.provider === provider && item.name === name);
}
