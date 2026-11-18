import { agentPrompter } from '../../src/main/flow-runner.js';

/**
 * `agentPrompter` with the step's `waitForReply` ON (Tynn #826): the step waits for the agent's turn to end and answers
 * its reply. The tests written for that wait (Tynn #684, #749, genie#721, the session-path ones) read it through this,
 * unchanged; the step's default — done once the agent has the prompt — is test/flow-busy-agent-826.test.ts.
 */
export function waitingPrompter(deps: Parameters<typeof agentPrompter>[0]): ReturnType<typeof agentPrompter> {
    const prompt = agentPrompter(deps);
    return (address, text, hooks, options) => prompt(address, text, hooks, { ...options, waitForReply: true });
}
