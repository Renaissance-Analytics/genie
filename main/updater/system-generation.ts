/**
 * DEEP vs SHALLOW: whether an upgrade is allowed to interrupt anything.
 *
 * Phase 0 of the MCP shuttle (`.ai/plans/genie-mcp-shuttle-spec.md` §8, genie#346).
 * No shuttle exists yet. This ships the VOCABULARY everything after it needs, and
 * it is independently useful: it replaces a judgement call ("does this release
 * restart things?") with a function of two build descriptors.
 *
 * ## The rule
 *
 * The owner allows terminal restarts for a deep system upgrade and for nothing
 * else. An upgrade is DEEP if and only if the incoming build changes one of:
 *
 *   1. {@link SystemGeneration.wireGeneration} — the shuttle's publish/dispatch
 *      protocol changed incompatibly.
 *   2. {@link SystemGeneration.mcpProtocolRevision} — the MCP revision the shuttle
 *      terminates. Every connected agent is talking that revision, so a change
 *      is a change to the conversation itself.
 *   3. {@link SystemGeneration.runtimeKey} — the shipped standalone Node runtime.
 *      Both the pty-host and the host Caddy run out of the copy this selects.
 *   4. {@link SystemGeneration.ptyHostKey} — the pty-host's identity, i.e.
 *      fancy-term-host + node-pty. A node-pty rebuild is a new native ABI.
 *
 * EVERYTHING ELSE IS SHALLOW, including every routine release. Note what is
 * deliberately NOT a field: the app version, the tool list, plugins, the renderer,
 * database migrations, prompts. Two builds that share all four values ARE the
 * same system, whatever else moved — so leaving those out is how "a routine
 * release is not deep" becomes true by construction rather than by care.
 *
 * ## Unknown resolves to DEEP
 *
 * A build from before this module carries no descriptor, and a malformed one is
 * no more trustworthy. The two ways of being wrong do not cost the same:
 *
 *   - wrongly DEEP    → one warning the user did not strictly need
 *   - wrongly SHALLOW → terminals restart and nobody was told
 *
 * The second is the failure the owner has been living with, so "cannot tell"
 * means deep, and the reason says it could not tell.
 *
 * PURE: no electron, no fs, no process. The caller supplies both descriptors.
 */

/** The four values that decide whether an upgrade may interrupt a session. */
export interface SystemGeneration {
    /** The shuttle's publish/dispatch wire protocol. Bump ONLY on an incompatible
     *  change — never for new tools, which ride a `publish` instead. */
    wireGeneration: number;
    /** The MCP protocol revision the shuttle terminates (e.g. `2024-11-05`). */
    mcpProtocolRevision: string;
    /** The shipped standalone Node runtime unit — see `runtimeKeyFor`. */
    runtimeKey: string;
    /** The pty-host's identity, fancy-term-host + node-pty — see `hostKeyFor`. */
    ptyHostKey: string;
}

/** Why an upgrade is deep. One entry per condition that tripped. */
export type DeepReason =
    | 'wire-generation'
    | 'mcp-protocol'
    | 'runtime'
    | 'pty-host'
    /** The running build has no usable descriptor — it predates this module. */
    | 'unknown-installed'
    /** The incoming build has no usable descriptor. */
    | 'unknown-incoming';

export interface UpgradeDepth {
    deep: boolean;
    /** EVERY condition that made it deep, in a fixed order — not just the first.
     *  Empty exactly when `deep` is false. */
    reasons: DeepReason[];
}

/**
 * This build's shuttle wire generation.
 *
 * `1` names the generation that exists before the shuttle does: there is no
 * publish/dispatch protocol yet, so there is nothing for a later build to be
 * incompatible WITH except "no shuttle". The first shuttle build that changes
 * the wire bumps this, and that bump is what makes its upgrade deep.
 */
export const SHUTTLE_WIRE_GENERATION = 1;

/** Is this a descriptor every field of which can actually be compared? */
function isComplete(g: SystemGeneration | null | undefined): g is SystemGeneration {
    return (
        !!g &&
        Number.isInteger(g.wireGeneration) &&
        typeof g.mcpProtocolRevision === 'string' &&
        g.mcpProtocolRevision.length > 0 &&
        typeof g.runtimeKey === 'string' &&
        g.runtimeKey.length > 0 &&
        typeof g.ptyHostKey === 'string' &&
        g.ptyHostKey.length > 0
    );
}

/**
 * Whether moving from `installed` to `incoming` is a DEEP upgrade, and why.
 *
 * Completeness is checked BEFORE comparing, and that ordering is load-bearing: a
 * malformed descriptor's missing fields are `undefined`, and `undefined ===
 * undefined` would read as "unchanged" — so a half-written descriptor on both
 * sides would compare as a routine release.
 */
export function upgradeDepth(
    installed: SystemGeneration | null | undefined,
    incoming: SystemGeneration | null | undefined,
): UpgradeDepth {
    if (!isComplete(installed)) return { deep: true, reasons: ['unknown-installed'] };
    if (!isComplete(incoming)) return { deep: true, reasons: ['unknown-incoming'] };

    const reasons: DeepReason[] = [];
    if (installed.wireGeneration !== incoming.wireGeneration) reasons.push('wire-generation');
    if (installed.mcpProtocolRevision !== incoming.mcpProtocolRevision) reasons.push('mcp-protocol');
    if (installed.runtimeKey !== incoming.runtimeKey) reasons.push('runtime');
    if (installed.ptyHostKey !== incoming.ptyHostKey) reasons.push('pty-host');

    return { deep: reasons.length > 0, reasons };
}
