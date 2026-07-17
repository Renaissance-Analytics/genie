import { broadcastLocal } from '../remote';
import { getKnowledgeStore } from './store';
import type { KnowledgeChangeEvent } from './types';

/**
 * Wire the Knowledge Graph store's change events to a LOCAL renderer broadcast
 * (`broadcastLocal`, so a host window's own /ws/events feed isn't double-pushed),
 * mirroring `installAgentInboxPresence`. An open Knowledge Graph window subscribes to
 * `knowledge:changed` and re-fetches, so a node an AGENT adds via the MCP tool
 * shows up live without a manual refresh. Local-only; no relay, no mobile push.
 *
 * Call {@link installKnowledgeBroadcast} once at boot.
 */
export function installKnowledgeBroadcast(): void {
    getKnowledgeStore().setEmitter((ev: KnowledgeChangeEvent) => {
        broadcastLocal('knowledge:changed', ev);
    });
}
