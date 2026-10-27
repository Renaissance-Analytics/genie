/**
 * CLAUDE CODE TOO OLD FOR GENIE'S SHELL APPROVALS (prism-acp 0.30.0, BREAKING).
 *
 * Every Claude agent runs with prism-acp's `permissionPrompts` on Bash and PowerShell (genie#1188). From 0.30.0 that hook
 * fails CLOSED, which needs Claude Code's `onFailure: "block"` — introduced in 2.1.295. prism-acp reads the CLI's version
 * from the `initialize` handshake and, when it is older or missing, ends the session with its own words: "Claude
 * permission prompts require an initialize version of 2.1.295 or later, consistent with system/init". Shown as is, the
 * agent read Broken with a `Restart` that cannot help. The person is told what to do instead
 * (test/claude-cli-too-old.test.ts drives the real driver with an old stand-in CLI).
 */

export const CLAUDE_CLI_MINIMUM = '2.1.295';

export const CLAUDE_CLI_TOO_OLD =
    `Claude Code did not report version ${CLAUDE_CLI_MINIMUM} or later, which Genie needs to ask before this agent's shell ` +
    `commands. Update Claude Code to ${CLAUDE_CLI_MINIMUM} or later (run \`claude update\`), then restart this agent.`;

/** prism-acp 0.30.0's refusal of a Claude Code whose `initialize` version is older than 2.1.295 or missing. */
const VERSION_REFUSAL = /permission prompts require an initialize version of 2\.1\.295 or later/i;

/** A provider's problem in words the person can act on: the old-CLI refusal becomes what to do; anything else is kept. */
export function providerProblemWords(problem: string): string {
    return VERSION_REFUSAL.test(problem) ? CLAUDE_CLI_TOO_OLD : problem;
}
