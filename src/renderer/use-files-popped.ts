import { useEffect, useState } from 'react';
import type { GenieBridge } from './bridge.js';

/** The host's file panels in their own windows; a remote bridge has none. */
export function useFilesPopped(filesWindows: GenieBridge['files']['windows']): readonly string[] {
    const [filesPopped, setFilesPopped] = useState<readonly string[]>([]);
    useEffect(() => {
        if (!filesWindows) { setFilesPopped([]); return; }
        let live = true;
        void filesWindows.list().then((l) => { if (live) setFilesPopped(l); });
        const off = filesWindows.onChange((l) => { if (live) setFilesPopped(l); });
        return () => { live = false; off(); };
    }, [filesWindows]);
    return filesPopped;
}
