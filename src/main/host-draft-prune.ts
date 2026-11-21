import { rosterPruner } from '../core/chat-drafts.js';

/**
 * EVERY CHAT'S UNSENT DRAFT GOES WITH ITS AGENT, IN GENIE-HOST (Tynn #997, client/host split step 2g-4a). genie-host keeps the
 * drafts (chat-draft-store.ts) and the registry, so it prunes them itself: once at boot over the loaded roster, then on each
 * registry write whose roster changed (core/chat-drafts.ts rosterPruner). main prunes nothing.
 */
export interface HostDraftPrunePorts {
    readonly agents: () => readonly string[];
    readonly drafts: { prune(agentIds: Iterable<string>): Promise<void> };
    readonly onRegistryWritten: (listener: () => void) => () => void;
    readonly log: (line: string) => void;
}

export async function hostDraftPrune(ports: HostDraftPrunePorts): Promise<() => void> {
    const pruner = rosterPruner({
        ids: ports.agents,
        prune: (ids) => ports.drafts.prune(ids),
        failed: (error) => ports.log(`chat drafts could not be pruned: ${error instanceof Error ? error.message : String(error)}`),
    });
    await pruner.start();
    return ports.onRegistryWritten(() => pruner.changed());
}
