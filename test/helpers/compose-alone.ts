import type { OwnAgentStores } from '../../src/main/agent-stores-api.js';
import { composeWith, type ComposedServices, type ComposeInput } from '../../src/main/compose.js';
import { composeHosting } from '../../src/main/hosting-compose.js';

/**
 * A TEST THAT COMPOSES ALONE: the stores agents write to and a real hosting stack, opened here for the test. The app never
 * does this; the window composes against genie-host's (composeWindowServices, Tynn #584).
 */
export async function composeServices(input: Omit<ComposeInput, 'agentStores'>): Promise<ComposedServices<OwnAgentStores>> {
    return (await composeWith({ ...input, buildOwnHosting: composeHosting })) as ComposedServices<OwnAgentStores>;
}
