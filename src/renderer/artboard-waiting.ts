import { useCallback, useEffect, useState } from 'react';
import { waitingCount } from '../core/artboard.js';
import type { GenieBridge } from './bridge.js';

/**
 * HOW MANY ARTBOARD ITEMS WAIT FOR A VERDICT (Tynn #739): the badge on the workspace's ArtBoard tab. An item waits when it
 * asked for a verdict (`askVerdict`) and has none; a decided item, pinned or not, does not. Read from the board the tab
 * itself shows, and re-read when something under `.artboard/` changes on disk — so an agent's post flags the tab as it lands,
 * without the person opening it. Zero for a window with no ArtBoard host, or no workspace.
 */
export function useArtboardWaiting(workspaceId: string | null, artboard: GenieBridge['artboard'], files: Pick<GenieBridge['files'], 'subscribe'> | undefined): number {
    const [waiting, setWaiting] = useState(0);
    const read = useCallback(() => {
        if (!artboard || !workspaceId) { setWaiting(0); return; }
        // A board that cannot be read keeps the last count rather than flashing the badge off.
        void artboard.read(workspaceId).then((b) => setWaiting(waitingCount(b.posts)), () => {});
    }, [artboard, workspaceId]);
    useEffect(() => { read(); }, [read]);
    useEffect(() => {
        if (!files?.subscribe || !artboard || !workspaceId) return;
        return files.subscribe(workspaceId, {}, (event) => { if (!event.git && (!event.paths || event.paths.some((p) => p.startsWith('.artboard/')))) read(); });
    }, [files, artboard, workspaceId, read]);
    return waiting;
}
