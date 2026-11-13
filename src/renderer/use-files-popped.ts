import { useEffect, useState } from 'react';
import type { GenieBridge } from './bridge.js';

/** The host's file panels in their own windows; a remote bridge has none. */
export function useFilesPopped(filesWindows: GenieBridge['files']['windows']): readonly string[] {
    const [filesPopped, setFilesPopped] = useState<readonly string[]>([]);
    useEffect(() => {
        if (!filesWindows) { setFilesPopped([]); return; }
        let live = true;
        const failed = (error: unknown): void => {
            if (!live) return;
            try { console.error('[files] Could not read detached file windows; waiting for the next update.', error); }
            catch { /* Diagnostic reporting must not reject this background read. */ }
        };
        // Keep the current list on failure; a later real push can still recover it (#636).
        try { void filesWindows.list().then((l) => { if (live) setFilesPopped(l); }).catch(failed); }
        catch (error) { failed(error); }
        const off = filesWindows.onChange((l) => { if (live) setFilesPopped(l); });
        return () => { live = false; off(); };
    }, [filesWindows]);
    return filesPopped;
}
