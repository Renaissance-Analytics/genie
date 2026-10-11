import type { GenieBridge } from '../bridge.js';
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
    files: GenieBridge['files'];
    onBringBack: () => void;
    onPause?: ((agent: string, path: string) => void) | undefined;
    onResume?: ((agent: string, path: string) => void) | undefined;
}

export function FilesWindow({ workspace, loading = false, files, onBringBack, onPause, onResume }: FilesWindowProps) {
    if (!workspace) {
        return (
            <main data-surface="files" data-files-window={loading ? 'loading' : 'unknown'} className="flex h-screen w-screen items-center justify-center bg-[var(--bg-0)] text-[13px] text-[var(--fg-3)]">
                {loading ? <div className="h-6 w-48 animate-pulse rounded-md bg-[var(--bg-2)]" /> : <p>This workspace is not in Genie any more. Close this window.</p>}
            </main>
        );
    }
    return (
        <main data-surface="files" data-workspace={workspace.id} className="h-screen w-screen bg-[var(--bg-0)]">
            <FilesPanelContainer workspace={workspace} files={files} pinned={false} popped onPin={() => {}} onClose={onBringBack} onPause={onPause} onResume={onResume} />
        </main>
    );
}
