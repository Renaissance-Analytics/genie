import { isAgentTui } from '../agents/identity';

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
 *   `{tui}:{name}`                    a peer in the caller's own workspace
 *   `{tui}:{name}:{chat-id}`          the same, as `list` prints it
 *   `{slug}:{tui}:{name}`             a peer in a NAMED workspace
 *   `{name}`                          when exactly one peer answers to it
 *   anything else                     passed through as an agentId, unchanged
 *
 * The bare NAME is not a convenience — it is compatibility (genie#388). For as
 * long as `agentRef` emitted the name alone, that is what `list` printed and what
 * agents wrote down. A name TWO peers answer to is refused with both qualified
 * forms rather than resolved to one of them, because v60 exists precisely so
 * `claude:tynn` and `codex:tynn` can both be agents.
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

/** The one separator every ref form uses. */
const SEP_PARTS = ':';

/** The durable half of a ref: `{tui}:{name}`, dropping any chat-id.
 *  A chat-id is rebound on relaunch, so matching on it would make yesterday's
 *  tag wrong for the same agent. */
function durableRef(ref: string): string {
    const parts = ref.split(SEP_PARTS);
    return parts.length >= 2 ? `${parts[0]}${SEP_PARTS}${parts[1]}` : ref;
}

/** The NAME half of a peer's durable ref — `claude:tynn` → `tynn`. */
function nameOf(ref: string): string {
    const parts = durableRef(ref).split(SEP_PARTS);
    return parts.length >= 2 ? parts[1]! : parts[0]!;
}

/**
 * A bare NAME that some peer publishes, resolved to that peer's own tag.
 *
 * For as long as `agentRef` emitted the name alone (`ddece5f7` → genie#388),
 * `list` printed bare names and agents wrote them down. Reading one has to keep
 * working, exactly as `parseAgentRef` keeps reading every form it ever emitted.
 *
 * It is also what makes the pair of errors in genie#388 impossible: `No agent
 * "genie"` and `Reachable agents: genie`, seconds apart from the same tool,
 * because one branch treated the string as a uuid and the other listed it as a
 * ref. A name somebody publishes now takes the tag path, where a miss says who
 * IS there and an ambiguity says how to qualify it.
 *
 * Deliberately anchored to the DIRECTORY rather than to a shape: a string only
 * becomes a name here if a peer answers to it, so a uuid — which no peer is
 * named — still falls through to the id passthrough untouched.
 *
 * AMBIGUITY IS REFUSED, not resolved by picking one. v60 exists precisely so
 * `claude:tynn` and `codex:tynn` can both be agents, so a bare `tynn` can name
 * two, and `find`ing the first would deliver a human's instruction to whichever
 * happened to sort earlier — silently, which is the failure this whole issue is
 * about. `null` here falls to the id passthrough and the broker's "No agent"
 * answer, so {@link ambiguousNames} states the qualified forms instead.
 */
function bareName(
    to: string,
    peers: AddressablePeer[],
): { slug: string | null; durable: string } | null {
    if (!to || to.includes(SEP_PARTS)) return null;
    const owners = peers.filter((p) => nameOf(p.ref) === to);
    const durables = [...new Set(owners.map((p) => durableRef(p.ref)))];
    return durables.length === 1 ? { slug: null, durable: durables[0]! } : null;
}

/** The distinct `{tui}:{name}` forms a bare name could have meant, when it
 *  could have meant more than one. Empty for anything else. */
function ambiguousNames(to: string, peers: AddressablePeer[]): string[] {
    if (!to || to.includes(SEP_PARTS)) return [];
    const durables = [
        ...new Set(peers.filter((p) => nameOf(p.ref) === to).map((p) => durableRef(p.ref))),
    ];
    return durables.length > 1 ? durables.sort() : [];
}

/** Is this a tag at all? A tag must name a provider Genie knows — which is what
 *  keeps a uuid (or any id that happens to contain a colon) from being mistaken
 *  for a malformed tag and refused. */
function tagParts(to: string): { slug: string | null; durable: string } | null {
    const parts = to.split(SEP_PARTS);
    if (parts.length >= 2 && isAgentTui(parts[0])) {
        return { slug: null, durable: `${parts[0]}:${parts[1]}` };
    }
    if (parts.length >= 3 && isAgentTui(parts[1])) {
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
    // A bare name TWO agents answer to is refused BEFORE the passthrough, or the
    // ambiguity would be reported as "no such agent" — which is false, and sends
    // the caller looking for a peer that is right there twice.
    const ambiguous = ambiguousNames(raw, peers);
    if (ambiguous.length) {
        return {
            ok: false,
            error: `\`${raw}\` is the name of ${ambiguous.length} agents running under different TUIs. Name the one you mean: ${ambiguous.join(', ')}.`,
        };
    }
    const tag = tagParts(raw) ?? bareName(raw, peers);
    // Not a tag and not a name anyone publishes: it is an id, and ids are passed
    // through untouched so every agent written against the old contract keeps
    // working.
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
