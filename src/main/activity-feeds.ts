import { activityFeed, type ActivityFeed } from '../core/activity-feed.js';
import type { AgentId } from '../core/identity.js';
import type { LiveSession } from '../core/roster.js';
import type { TimedEvent } from '../core/stream-view.js';

/**
 * EVERY AGENT'S ACTIVITY FEED, PUSHED (beta.33 item 10) — what the workspace Dashboard's lanes draw.
 *
 * The renderer loads only the on-screen agent's ledger (`genie:agent-changed:<id>`, thousands of rows), so a lane per
 * agent could not be alive from it. This builds each agent's small feed (core/activity-feed.ts) from the session host's
 * own ledger, and pushes it when the host says that agent changed. Never on a timer, never polled:
 *
 *  - **Event-driven.** `host.subscribe` is the only trigger. A burst — a reply streaming in chunk by chunk — is
 *    coalesced into one push per {@link COALESCE_MS}, so the window is not sent a feed per chunk.
 *  - **Only what changed.** A feed equal to the last one sent for that agent is not sent again.
 *  - **Bounded.** One feed per agent (its newest items and 30 minutes of beats), never a copy of the ledger.
 *
 * A stopped agent's feed is its recorded history: `ledgerFor` reads it from the thread once and announces it when it
 * lands, which arrives here as any other change.
 */

export const COALESCE_MS = 250;

export interface ActivityHostPort {
    subscribe(listener: (agentId: AgentId) => void): () => void;
    ledgerFor(agentId: AgentId): readonly TimedEvent[];
    probe(agentId: AgentId): LiveSession | null;
}

export class ActivityFeeds {
    readonly #host: ActivityHostPort;
    readonly #clock: () => number;
    readonly #schedule: (fn: () => void, ms: number) => void;
    readonly #listeners = new Set<(feed: ActivityFeed) => void>();
    /** The last feed SENT per agent, as JSON — what "nothing changed" is compared against. */
    readonly #sent = new Map<string, string>();
    readonly #pending = new Set<string>();
    readonly #off: () => void;

    constructor(options: { host: ActivityHostPort; clock?: () => number; schedule?: (fn: () => void, ms: number) => void }) {
        this.#host = options.host;
        this.#clock = options.clock ?? Date.now;
        this.#schedule = options.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
        this.#off = this.#host.subscribe((agentId) => this.#changed(agentId));
    }

    /** One agent's feed now. Asking for it is also what starts a stopped agent's history loading. */
    feedFor(agentId: string): ActivityFeed {
        const feed = this.#build(agentId);
        this.#sent.set(agentId, JSON.stringify(feed));
        return feed;
    }

    subscribe(listener: (feed: ActivityFeed) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** An agent that is gone: its feed is forgotten, so the map holds only agents that exist. */
    forget(agentId: string): void {
        this.#sent.delete(agentId);
    }

    dispose(): void {
        this.#off();
        this.#listeners.clear();
    }

    #build(agentId: string): ActivityFeed {
        const id = agentId as AgentId;
        return activityFeed({ agentId, rows: this.#host.ledgerFor(id), session: this.#host.probe(id), now: this.#clock() });
    }

    #changed(agentId: string): void {
        if (this.#pending.has(agentId)) return;
        this.#pending.add(agentId);
        this.#schedule(() => {
            this.#pending.delete(agentId);
            const feed = this.#build(agentId);
            const json = JSON.stringify(feed);
            if (this.#sent.get(agentId) === json) return;
            this.#sent.set(agentId, json);
            for (const listener of this.#listeners) listener(feed);
        }, COALESCE_MS);
    }
}
