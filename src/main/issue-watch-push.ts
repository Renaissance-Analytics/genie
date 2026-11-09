import type { AgentId } from '../core/identity.js';
import type { IssueWatchDelivery } from './issue-watch-delivery.js';
import { wireInboxPush, type InboxPushPorts } from './inbox-push.js';

/** The part of IssueWatch's delivery queue its push reads. */
export type IssueWatchQueue = Pick<IssueWatchDelivery, 'onQueued' | 'due' | 'settled' | 'wakes'>;

/**
 * ISSUEWATCH'S PUSH (Tynn #806; the host split, P5c). What changed reaches an agent through the SAME delivery as mail —
 * Genie's notice, at the agent's next step even mid-turn (genie#1411), told again if it was not delivered — read from
 * IssueWatch's own queue (issue-watch-delivery.ts), never from the inbox: it is not mail. Each agent by its own setting:
 * `push` starts a stopped agent through the caller's wake, under the refusals a person's start has; `next-turn` waits
 * for it to be running. Not `cumulative`: each notice names only what is new.
 *
 * genie-host wires it inside its mail wake (host-mail-wake.ts), with that wake.
 */
export function wireIssueWatchPush(p: {
    readonly delivery: IssueWatchQueue;
    readonly host: InboxPushPorts['host'];
    readonly wake: (agentId: string) => boolean | Promise<boolean>;
}): () => void {
    return wireInboxPush({
        inbox: { onSend: (listener) => p.delivery.onQueued(listener) },
        host: p.host,
        reminders: (input) => p.delivery.due(input),
        settled: (agentId, delivered) => p.delivery.settled(agentId, delivered),
        // `push` wakes a stopped agent as mail does; `next-turn` waits for it to be running.
        wake: (agentId: AgentId) => p.delivery.wakes(agentId) && p.wake(agentId),
    });
}
