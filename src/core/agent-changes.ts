import type { ChangedGroup } from './files-panel.js';

/**
 * THE AGENT VIEW'S CHANGES TAB — the files THIS agent changed this session.
 *
 * From the file host's own groups (§4.3: the agents' reports, you, and "changed on disk with no report" as `?`),
 * never a guess. `null` is ABSENT: no file state, nothing changed, or this agent changed nothing — three different
 * nothings with one honest rendering, a sentence naming the agent, rather than an empty list (§5).
 */
export function agentChanges(state: { readonly changed: readonly ChangedGroup[] | null } | null, agentName: string): readonly string[] | null {
    const group = state?.changed?.find((g) => g.who === agentName);
    return group && group.files.length > 0 ? group.files : null;
}
