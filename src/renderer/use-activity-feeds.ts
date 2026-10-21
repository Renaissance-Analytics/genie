import { useEffect, useState } from 'react';
import type { ActivityFeed } from '../core/activity-feed.js';
import type { ActivityBridge } from './bridge.js';

/**
 * ONE WORKSPACE'S AGENTS' ACTIVITY FEEDS, LIVE (beta.33 item 10) — what the workspace Dashboard's lanes draw.
 *
 * Read once when the workspace opens, then kept current by the host's pushes (`activity.subscribe`): never polled. A
 * push that lands before the first read is kept — the read only fills agents the pushes have not. `null` workspace (not
 * on a workspace) or no bridge: nothing is held.
 */
export function useActivityFeeds(activity: ActivityBridge | undefined, workspaceId: string | null): Readonly<Record<string, ActivityFeed>> {
    const [feeds, setFeeds] = useState<Readonly<Record<string, ActivityFeed>>>({});
    useEffect(() => {
        setFeeds({});
        if (!activity || workspaceId === null) return;
        let live = true;
        const off = activity.subscribe((feed) => {
            if (live) setFeeds((prev) => ({ ...prev, [feed.agentId]: feed }));
        });
        void activity.feeds(workspaceId).then(
            (first) => { if (live) setFeeds((prev) => ({ ...first, ...prev })); },
            () => {},
        );
        return () => { live = false; off(); };
    }, [activity, workspaceId]);
    return feeds;
}

/**
 * A re-render each minute, on the minute — so a heartbeat slides and "14m" counts on while nothing is pushed. A clock
 * for the display; no data is fetched on it.
 */
export function useMinuteTick(): void {
    const [, setTick] = useState(0);
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout>;
        const arm = (): void => {
            timer = setTimeout(() => { setTick((t) => t + 1); arm(); }, 60_000 - (Date.now() % 60_000) + 50);
        };
        arm();
        return () => clearTimeout(timer);
    }, []);
}
