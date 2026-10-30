import { startTransition, useEffect, useState } from 'react';
import { share } from '../core/share.js';
import { EMPTY_SNAPSHOT, type GenieBridge, type GenieSnapshot } from './bridge.js';

/**
 * A PUSHED UPDATE GIVES WAY TO THE PERSON (genie#1340). Main pushes the estate up to twenty times a second while any agent
 * works, and the watched agent's detail as often. Rendered at React's default priority, each push is drawn in one
 * uninterrupted task, and a keystroke that arrives meanwhile waits for all of it — measured on omarchy-test with eleven
 * agents streaming, keystroke → paint was 140 ms–1 s at p95. As a TRANSITION the render yields to input every few
 * milliseconds: the keystroke is committed first, and the push is drawn after it (or folded into the next one).
 */
export function pushed(update: () => void): void {
    startTransition(update);
}

/** The estate, read once and then kept current by main's pushes. */
export function useSnapshot(bridge: Pick<GenieBridge, 'snapshot' | 'subscribe'> | undefined): GenieSnapshot {
    const [snapshot, setSnapshot] = useState<GenieSnapshot>(EMPTY_SNAPSHOT);

    useEffect(() => {
        if (!bridge) return;
        let live = true;

        // One read to start from, then PUSH. No interval anywhere: a polled dashboard is wrong
        // for up to its interval, and with thirty agents it re-reads the registry a hundred
        // times a minute to learn nothing.
        // Each push arrives as a new object graph (a structured clone): what did not change keeps its identity
        // (core/share.ts), so a view keyed on an agent's row or a workspace draws only when that changed.
        void bridge.snapshot().then((s) => { if (live) setSnapshot((prev) => share(prev, s)); });
        const off = bridge.subscribe((s) => { if (live) pushed(() => setSnapshot((prev) => share(prev, s))); });

        return () => { live = false; off(); };
    }, [bridge]);

    return snapshot;
}
