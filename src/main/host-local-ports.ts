import { editorBytesOfDump } from '../core/plugin-editors.js';
import type { GAppBookApi, GAppsApi } from '../core/gapps.js';
import type { CallContext } from '../core/remote-protocol.js';
import type { MarketplaceApi } from '../core/marketplace.js';
import type { ChatDraftStore } from './chat-draft-store.js';
import type { HostApiDeps } from './host-api.js';
import type { LocalFilesDeps } from './local-files-api.js';
import { createNativeTerminalPort } from './local-terminal-native.js';
import { artboardReadFiles, artboardReview, repoCall, type PanelsHostDeps } from './official-panels-host.js';
import type { PluginsDump } from './plugins-host.js';
import type { TerminalHost } from './terminal-host.js';

/**
 * GENIE-HOST'S OWN LOCAL PORTS (Tynn #898 step 2d-3a, story #905). The families this machine's window asks of its host
 * (the file panel and the Repository panel, chat drafts, the ArtBoard, the window's own terminals, the Marketplace and
 * the GApp book) built from what genie-host owns, so its answers (host-alone-api.ts) serve them with no window in
 * between. The window's main process builds the same ports over the same functions (main.ts `buildHostApi`), reaching
 * these parts through the engine link; at 2d-4 it stops, and the window is served here.
 *
 * What only a window can do stays the window's: an app's own window and a workspace's preview of one are Electron
 * windows. Since step 2d-4b they open in the window that asked (`appWindow`); with no window to ask, refused in words.
 */
export interface HostLocalSources {
    /** The workspaces a terminal opens in: the roster's, with their folders. */
    readonly workspaces: () => readonly { id: string; path: string }[];
    /** A workspace's folder, asleep or not (the ArtBoard and the Repository panel); null = no such workspace. */
    readonly workspacePath: (id: string) => string | null;
    /** genie-host's files host: the same confinement, size cap and git state the window's panel had. */
    readonly files: LocalFilesDeps['files'];
    /** genie-host's plugins: which editor may read and save a file's bytes. */
    readonly plugins: { dump(): PluginsDump };
    /** An ArtBoard verdict, to the agent that posted it, as an AgentInbox message from the person. */
    readonly sendFromPerson: (agentId: string, text: string) => Promise<void>;
    readonly drafts: Pick<ChatDraftStore, 'all' | 'save' | 'putFile' | 'openFile' | 'release'>;
    readonly terminals: () => Pick<TerminalHost, 'openReady' | 'lastCwd' | 'write' | 'resize' | 'close' | 'list' | 'attach' | 'streamSnapshot' | 'onData' | 'onExit'> | null;
    /** Whether a new terminal opens where the last one was (the `track_cwd` setting). */
    readonly trackCwd: () => unknown;
    /** A person's shell sees what an agent's does: the workspace's service variables and Genie's MCP endpoint. */
    readonly terminalEnv: (workspaceId: string) => Record<string, string>;
    readonly marketplace: () => MarketplaceApi | null;
    /** The GApp book's actions (gapps-api.ts `gappsApi`); null while it is not open. */
    readonly gapps: () => GAppBookApi | null;
    readonly onGappsChanged: (listener: () => void) => () => void;
    /**
     * An app's window, opened by the window that asked (Tynn #898 step 2d-4b): a window-local client operation, done in
     * that window's process (gapp-windows-electron.ts). `context` is the caller RemoteHost admitted; absent = refused in words.
     */
    readonly appWindow?: (context: CallContext | undefined, packageId: string, preview: boolean) => Promise<void>;
    readonly say: (line: string) => void;
    readonly now?: () => Date;
}

export const APP_WINDOW = 'an app’s window opens in a Genie window: open it from Genie on this machine';

export type HostLocalPorts = Required<Pick<HostApiDeps, 'marketplace' | 'gapps' | 'gappsChanged' | 'localTerminals' | 'localFiles' | 'artboard' | 'chatDrafts'>>;

export function hostLocalPorts(sources: HostLocalSources): HostLocalPorts {
    const panels: PanelsHostDeps = {
        workspacePath: sources.workspacePath,
        send: sources.sendFromPerson,
        now: () => (sources.now?.() ?? new Date()).toISOString(),
    };
    const gapps = (context?: CallContext): GAppsApi | null => {
        const book = sources.gapps();
        if (!book) return null;
        const appWindow = sources.appWindow;
        return {
            ...book,
            open: async (id) => { if (!appWindow) throw new Error(APP_WINDOW); await appWindow(context, id, false); },
            preview: async (id) => { if (!appWindow) throw new Error(APP_WINDOW); await appWindow(context, id, true); },
            onChanged: (listener) => sources.onGappsChanged(listener),
        };
    };
    return {
        marketplace: sources.marketplace,
        gapps,
        // The Apps list follows installs and removals (Tynn #596), as a signal; the window reads the list (step 2d-4a).
        gappsChanged: { subscribe: (listener) => sources.onGappsChanged(listener) },
        localFiles: {
            files: sources.files,
            editor: () => {
                const files = sources.files();
                return files ? { gate: (pluginId, path) => editorBytesOfDump(sources.plugins.dump(), pluginId, path), files } : null;
            },
            repo: (op, id, rel, a, b) => repoCall(panels, op, id, rel, a, b),
        },
        artboard: {
            read: (id) => artboardReadFiles(panels, id),
            review: (id, post, verdict, comment) => artboardReview(panels, id, post, verdict, comment),
        },
        chatDrafts: {
            all: () => sources.drafts.all(),
            save: (agentId, raw) => sources.drafts.save(agentId, raw),
            putFile: (bytes) => sources.drafts.putFile(bytes),
            // Read as a stream: a draft's file may be large, and the protocol sends it in chunks (local-blobs).
            readFile: (ref) => sources.drafts.openFile(ref),
            release: (refs) => sources.drafts.release(refs),
        },
        localTerminals: createNativeTerminalPort({
            terminals: sources.terminals,
            workspaces: sources.workspaces,
            trackCwd: sources.trackCwd,
            environment: sources.terminalEnv,
            freshSnapshot: async (id) => {
                const terminals = sources.terminals();
                const value = terminals?.attach(id) ?? null;
                if (!terminals || !value) return null;
                const position = terminals.streamSnapshot(id);
                return { ...value, epoch: position?.epoch ?? null, endOffset: position?.endOffset ?? null };
            },
            listen: (data, exit) => {
                const terminals = sources.terminals();
                const offData = terminals?.onData((id, text, position) => data({ id, data: text, ...(position ? { epoch: position.epoch, offset: position.offset } : {}) })) ?? (() => {});
                const offExit = terminals?.onExit((id, code, position) => exit({ id, exitCode: code, ...(position ?? {}) })) ?? (() => {});
                return () => { offData(); offExit(); };
            },
            openError: (path, error) => sources.say(`[terminal] open failed in ${path}: ${error instanceof Error ? error.message : String(error)}`),
        }),
    };
}
