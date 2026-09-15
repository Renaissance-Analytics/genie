/**
 * Whether Genie serves agents through the MCP shuttle (genie#346).
 *
 * Always, in the product. It is not a setting: keeping an agent's connection alive
 * through a Genie update is how Genie works, not something a person has to find
 * and turn on — beta.324 shipped it as an opt-in switch, off by default, and the
 * very next upgrade dropped every agent again. When the shuttle cannot run, Genie
 * still serves agents itself and says so ({@link startMcpEndpoint}'s fallback);
 * that is a failure being reported, not a mode anyone chooses.
 *
 * The E2E suite is the one exception, and only per launch: its specs share one
 * profile and one MCP port, so a detached shuttle left behind by one spec would
 * answer the next spec's agents. A spec that is proving the shuttle opts in.
 */
export function shuttleEnabledFor(opts: { e2e: boolean; env: NodeJS.ProcessEnv }): boolean {
    return !opts.e2e || opts.env.GENIE_E2E_MCP_SHUTTLE === '1';
}
