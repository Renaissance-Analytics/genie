import type { GenieBridge } from '../bridge.js';
import { useRef } from 'react';
import { FilesPanelContainer } from './FilesPanelContainer.js';

/**
 * THE FILE PANEL IN ITS OWN WINDOW (§4.3) — `genie://files/<workspaceId>`. The panel and nothing
 * else: no rail, no title bar, no Deck; one control in the panel's header docks it back (closing
 * the window is the same thing). A workspace Genie no longer has is said, not drawn blank.
 */

export interface FilesWindowProps {
    workspace: { id: string; name?: string | undefined; path: string } | null;
    /** `true` while the host has not answered which workspaces exist — a skeleton, not "unknown". */
    loading?: boolean | undefined;
    /** Hide the live editor while retaining the person's unsaved buffers. */
    hibernated?: boolean | undefined;
    files: GenieBridge['files'];
    onBringBack: () => void;
    onPause?: ((agent: string, path: string) => void) | undefined;
    onResume?: ((agent: string, path: string) => void) | undefined;
}

export function FilesWindow({ workspace, loading = false, hibernated = false, files, onBringBack, onPause, onResume }: FilesWindowProps) {
    const remembered = useRef(workspace);
    if (workspace) remembered.current = workspace;
    const kept = workspace ?? (hibernated ? remembered.current : null);
    const notice = <p className="p-6 text-sm text-[var(--fg-3)]">This workspace is hibernated. Redock it to continue; your unsaved edits are kept.</p>;
    if (!kept) {
        return (
            <main data-surface="files" data-files-window={loading ? 'loading' : 'unknown'} className="flex h-screen w-screen items-center justify-center bg-[var(--bg-0)] text-[13px] text-[var(--fg-3)]">
                {hibernated ? notice : loading ? <div className="h-6 w-48 animate-pulse rounded-md bg-[var(--bg-2)]" /> : <p>This workspace is not in Genie any more. Close this window.</p>}
            </main>
        );
    }
    return (
        <main data-surface="files" data-workspace={kept.id} className="h-screen w-screen bg-[var(--bg-0)]">
            <div hidden={hibernated} inert={hibernated} className="h-full">
                <FilesPanelContainer workspace={kept} visible={!hibernated} files={files} pinned={false} popped onPin={() => {}} onClose={onBringBack} onPause={onPause} onResume={onResume} />
            </div>
            {hibernated ? notice : null}
        </main>
    );
}
