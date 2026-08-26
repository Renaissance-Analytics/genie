import { isAgentProvider } from '../agents/identity';

/**
 * Turn a peer TAG into the address the broker routes on.
 *
 * The owner's ask: agents should not have to use an id to reach each other. The
 * pieces were already there and simply never met — `list` hands every peer a
 * `ref` and calls it "the identity a person or an agent can actually say out
 * loud", while `send` accepted only `agentId`, a uuid. The one field an agent
 * could READ was the one field it could not USE.
 *
 * A second reason arrived independently: an agentId is stable only as long as
 * the TERMINAL is (it lives in the terminal spec's meta). A name outlives a
 * terminal replacement; a uuid does not, and fails silently when it does.
 *
 * Accepted forms, in the order they are tried:
 *
 *   `{provider}:{name}`               a peer in the caller's own workspace
 *   `{provider}:{name}:{chat-id}`     the same, as `list` prints it
 *   `{slug}:{provider}:{name}`        a peer in a NAMED workspace
 *   anything else                     passed through as an agentId, unchanged
 *
 * REACHABILITY IS NOT DECIDED HERE. The broker already refuses a peer the caller
 * may not reach, with a message written for that case. Deciding it here too
 * would be a second ACL, and two ACLs drift.
 */

/** The subset of a peer this needs. Built from what `list` already returns. */
export interface AddressablePeer {
    agentId: string;
    /** `{provider}:{name}` or `{provider}:{name}:{chat-id}`. */
    ref: string;
    workspaceId: string;
    /** Display slug — what a cross-workspace tag names. */
    slug: string;
}

export type AddressResolution = { ok: true; agentId: string } | { ok: false; error: string };

/** The durable half of a ref: `{provider}:{name}`, dropping any chat-id.
 *  A chat-id is rebound on relaunch, so matching on it would make yesterday's
 *  tag wrong for the same agent. */
function durableRef(ref: string): string {
    const parts = ref.split(':');
    return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : ref;
}

/** Is this a tag at all? A tag must name a provider Genie knows — which is what
 *  keeps a uuid (or any id that happens to contain a colon) from being mistaken
 *  for a malformed tag and refused. */
function tagParts(to: string): { slug: string | null; durable: string } | null {
    const parts = to.split(':');
    if (parts.length >= 2 && isAgentProvider(parts[0])) {
        return { slug: null, durable: `${parts[0]}:${parts[1]}` };
    }
    if (parts.length >= 3 && isAgentProvider(parts[1])) {
        return { slug: parts[0]!, durable: `${parts[1]}:${parts[2]}` };
    }
    return null;
}

export function resolveAgentAddress(
    to: string,
    peers: AddressablePeer[],
    callerWorkspaceId: string,
): AddressResolution {
    const raw = String(to ?? '').trim();
    const tag = tagParts(raw);
    // Not a tag: it is an id, and ids are passed through untouched so every
    // agent written against the old contract keeps working.
    if (!tag) return { ok: true, agentId: raw };

    const matches = peers.filter(
        (p) =>
            durableRef(p.ref) === tag.durable &&
            (tag.slug === null || p.slug === tag.slug),
    );

    if (matches.length === 1) return { ok: true, agentId: matches[0]!.agentId };

    if (matches.length > 1) {
        // An unqualified tag means "mine" when the caller has one of that name.
        // Without this, naming your own agent would start meaning a stranger's
        // the moment another workspace happened to use the same name.
        const own = matches.filter((p) => p.workspaceId === callerWorkspaceId);
        if (own.length === 1) return { ok: true, agentId: own[0]!.agentId };

        // Genuinely ambiguous between strangers. The QUALIFIED forms go in the
        // message so the caller can retry from the error itself.
        const options = matches.map((p) => `${p.slug}:${tag.durable}`).join(', ');
        return {
            ok: false,
            error: `\`${raw}\` matches ${matches.length} agents in different workspaces. Name the workspace: ${options}.`,
        };
    }

    // Nobody. Say who IS there — "not found" alone sends the caller to `list`
    // for information this answer could have carried.
    const reachable = peers.map((p) => durableRef(p.ref));
    const known = [...new Set(reachable)].sort().slice(0, 8).join(', ');
    return {
        ok: false,
        error: known
            ? `No agent matches \`${raw}\`. Reachable agents: ${known}. Use \`{provider}:{name}\`, or \`{workspace}:{provider}:{name}\` for another workspace.`
            : `No agent matches \`${raw}\`, and no peer agents are reachable from here. Use \`list\` to check who is running.`,
    };
}
