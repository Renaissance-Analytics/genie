import { useEffect, useState } from 'react';
import { EMPTY_SNAPSHOT, type GenieBridge, type GenieSnapshot } from './bridge.js';

/** The estate, read once and then kept current by main's pushes. */
export function useSnapshot(bridge: Pick<GenieBridge, 'snapshot' | 'subscribe'> | undefined): GenieSnapshot {
    const [snapshot, setSnapshot] = useState<GenieSnapshot>(EMPTY_SNAPSHOT);

    useEffect(() => {
        if (!bridge) return;
        let live = true;

        // One read to start from, then PUSH. No interval anywhere: a polled dashboard is wrong
        // for up to its interval, and with thirty agents it re-reads the registry a hundred
        // times a minute to learn nothing.
        void bridge.snapshot().then((s) => { if (live) setSnapshot(s); });
        const off = bridge.subscribe((s) => { if (live) setSnapshot(s); });

        return () => { live = false; off(); };
    }, [bridge]);

    return snapshot;
}
