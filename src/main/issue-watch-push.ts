import type { IssueWatchDelivery } from './issue-watch-delivery.js';
import type { InboxPushPorts } from './inbox-push.js';

/** The part of IssueWatch's delivery queue its push reads. */
export type IssueWatchQueue = Pick<IssueWatchDelivery, 'onQueued' | 'due' | 'settled' | 'wakes'>;

/**
 * ISSUEWATCH'S PUSH (Tynn #806; the host split, P5c). P5c RED: the types only; built next.
 */
export function wireIssueWatchPush(p: {
    readonly delivery: IssueWatchQueue;
    readonly host: InboxPushPorts['host'];
    readonly wake: (agentId: string) => boolean | Promise<boolean>;
}): () => void {
    void p;
    return () => {};
}
