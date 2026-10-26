/**
 * WHAT AN AGENT JUST DID WITH GENIE, ON ITS DASHBOARD ROW (genie#1209; the owner, 2026-10-26: "I also want to see a
 * thumbsUp emoji on a agent row when an agent uses thumbsUp. We also need an emoji for imDone and an emoji for when an
 * agent performs any genie based action like opening a terminal, managing the workspace tabs, setting up bg process and
 * sites").
 */
export const ROW_EMOJI = { thumbsup: '👍', done: '✅', genie: '🧞' } as const;
export type RowSignalKind = keyof typeof ROW_EMOJI;

/** How long a row shows the emoji after the action. */
export const ROW_EMOJI_MS = 8_000;

/**
 * The tools that TALK or READ rather than act on the workstation: each has its own signal (mail travels between rows,
 * thumbsUp and imDone have their own emoji, a question reaches the Deck) or none worth a row's attention.
 */
const NOT_ACTIONS = new Set(['agentinbox', 'thumbsUp', 'imDone', 'ForceTheQuestion', 'checkIssues', 'knowledge', 'lists', 'plan']);

/** A Genie tool that ACTS — terminals, tabs, processes, sites, services, pages, flows, agents, files, plugins. */
export function isGenieAction(tool: string): boolean {
    return !NOT_ACTIONS.has(tool);
}
