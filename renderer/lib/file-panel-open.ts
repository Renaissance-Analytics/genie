import { emitOpenInPanelAndWait } from './editor-open';
import { api } from './genie';

/**
 * OPENING A FILE BY PATH, from anywhere in the renderer.
 *
 * The gap this fills was written down in `master.tsx` rather than hidden: the Agent view's
 * Files and Changes tabs hand `onOpenFile` a PATH, and the handler could only open the panel,
 * because *"`selectFile` is private to `CodePanel` and `on.editorOpenFile` is inbound from the
 * MCP tool, so a cross-component channel would have to be built"*. This is that channel.
 *
 * It adds no new transport. Both halves already exist and are reused:
 *
 *  - **In this window** — `editor-open.ts`'s `onOpenInPanel` / `emitOpenInPanelAndWait` bus,
 *    which a mounted `CodePanel` already subscribes to by spec id. What was missing is the
 *    WORKSPACE → mounted panel mapping, which is all {@link registerFilePanel} adds.
 *  - **In another window** (popped out, or a second master) — main's
 *    `FilePanelWindows.routeOpenFile`, which focuses the owning window and queues until it is
 *    ready. That is the path the `openFileForUser` MCP tool already takes.
 *
 * And one state neither covers: the panel is not open at all. The request waits here until a
 * panel for that workspace mounts — which is exactly what the caller's own "open the panel"
 * step causes. Queued, not dropped, and not reported as opened either.
 *
 * ## The distinction every return value keeps
 *
 * A request is LANDED only when something accepted it. `emitOpenInPanelAndWait` resolves FALSE
 * for a file that failed to open, and that false is honoured: the channel keeps looking and, if
 * nothing takes it, says `queued`. A channel that reported success for a file nobody opened
 * would be worse than no channel, because the caller stops looking for a better route.
 */

/** Where a file should be opened. Mirrors main's `OpenFileRequest` payload. */
export interface PanelOpenRequest {
    workspaceId: string;
    /**
     * The directory the panel roots at — the workspace's own path for a real workspace.
     *
     * Carried even though the local bus ignores it, because {@link OpenFilePorts.route} does
     * not: a master window resolves the tab against `root`, so an empty one silently re-opens
     * the file as a System panel rooted somewhere else (`editor-open.ts` records that bug).
     */
    root: string;
    /** The tab path, relative to `root`. */
    relPath: string;
    /** 1-based line to reveal. */
    line?: number;
}

export interface OpenFilePorts {
    /**
     * Ask MAIN to route this to whichever window owns the workspace's panel. `false` ⇒ no
     * window owns one, which is a real answer and not a failure.
     *
     * Defaults to the IPC, so a call site does not have to know the channel OR remember that
     * `root` has to be in the payload — a master window resolves the tab against it.
     */
    route?: (req: PanelOpenRequest) => Promise<boolean>;
    now?: () => number;
}

export interface FilePanelRegistration {
    specId: string;
    workspaceId: string;
    /** How to reach this panel. Defaults to the bus `editor-open.ts` already runs, so a real
     *  `CodePanel` registers with nothing but its two ids. */
    deliver?: (relPath: string, line?: number) => Promise<boolean>;
    now?: () => number;
}

/**
 * How long a queued request stays openable.
 *
 * A workspace's panel can mount hours later — the user never opened that workspace. Opening a
 * file somebody asked for before lunch is a surprise rather than a service, so the request
 * expires instead of waiting indefinitely.
 */
export const PENDING_MS = 30_000;

export type FileLanding = {
    /** `live` delivered to a panel here · `routed` handed to the window that owns it ·
     *  `queued` nothing could take it yet, and the caller's next step is to open the panel. */
    kind: 'live' | 'routed' | 'queued';
    /** The panel that took it, when it was one in this window. */
    specId: string | null;
};

interface MountedPanel {
    specId: string;
    workspaceId: string;
    deliver: (relPath: string, line?: number) => Promise<boolean>;
    now: () => number;
}

const mounted: MountedPanel[] = [];
const pending = new Map<string, { req: PanelOpenRequest; at: number }>();

/**
 * Announce a mounted file panel and the workspace it is rooted at. Returns an unregister.
 *
 * Registering also DRAINS a request queued for that workspace, which is what makes "open the
 * panel, then the file lands in it" one act rather than a race the caller has to win.
 */
export function registerFilePanel(registration: FilePanelRegistration): () => void {
    const entry: MountedPanel = {
        specId: registration.specId,
        workspaceId: registration.workspaceId,
        deliver:
            registration.deliver ??
            ((relPath, line) => emitOpenInPanelAndWait(registration.specId, relPath, line)),
        now: registration.now ?? Date.now,
    };
    mounted.push(entry);
    void drain(entry);
    return () => {
        const at = mounted.indexOf(entry);
        if (at >= 0) mounted.splice(at, 1);
    };
}

/** The panels mounted for a workspace IN THIS WINDOW. `[]` is measured — nothing is mounted. */
export function mountedFilePanels(workspaceId: string): string[] {
    return mounted.filter((entry) => entry.workspaceId === workspaceId).map((entry) => entry.specId);
}

/**
 * Hand a queued request to a panel that just mounted.
 *
 * The entry is removed BEFORE the first await, so two panels mounting together cannot both
 * open it — one click opens one file.
 */
async function drain(entry: MountedPanel): Promise<void> {
    const waiting = pending.get(entry.workspaceId);
    if (!waiting) return;
    pending.delete(entry.workspaceId);
    if (entry.now() - waiting.at > PENDING_MS) return;
    await entry.deliver(waiting.req.relPath, waiting.req.line);
}

/**
 * Open `req.relPath` in the workspace's file panel, wherever that panel is.
 *
 * Tried in order of how directly the file can actually appear: a panel mounted HERE, then the
 * window that owns one, then the queue. The order matters — routing while a panel is mounted
 * here would focus another window and move the user away from the thing they clicked.
 */
export async function openFileInPanel(
    req: PanelOpenRequest,
    ports: OpenFilePorts = {},
): Promise<FileLanding> {
    for (const entry of mounted.filter((panel) => panel.workspaceId === req.workspaceId)) {
        if (await entry.deliver(req.relPath, req.line)) return { kind: 'live', specId: entry.specId };
    }
    const route = ports.route ?? ((request: PanelOpenRequest) =>
        api().files.openInPanelWindow(request).catch(() => false));
    if (await route(req)) return { kind: 'routed', specId: null };
    // Newest wins: a second click is a change of mind, not a second tab to open later.
    pending.set(req.workspaceId, { req, at: (ports.now ?? Date.now)() });
    return { kind: 'queued', specId: null };
}
