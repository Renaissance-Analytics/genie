/**
 * The GApp preload — a deliberately tiny surface (Tynn #250).
 *
 * This is what a Genie App can see of Genie. NOT `preload.ts`, which exposes the
 * whole desktop API and would hand a third-party page everything at once; this one
 * exposes two calls, both of which go through the permission-checked bridge in the
 * main process.
 *
 * It runs in a FULL Chromium sandbox, so it has no Node and no filesystem. That is
 * the point: even if a GApp's page found a way to run code in here, there is
 * nothing in here to run.
 *
 * The app never tells Genie who it is. Identity is the window it was given, which
 * Genie created and recorded — there is no field on either call for a page to
 * claim an app id, and adding one would be the whole vulnerability.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { APP_CALL_CHANNEL, APP_ME_CHANNEL } from './bridge';

export interface GenieAppIdentity {
    id: string;
    name: string;
    workspaceId: string;
    scope: 'self' | 'workspaces' | 'workstation';
    /** What the USER granted — not what the manifest asked for. */
    capabilities: string[];
}

export interface GenieAppCallResult {
    ok: boolean;
    result?: unknown;
    error?: string;
}

const api = {
    /** Who this app is and what it was granted. Null if the window is not an app's. */
    me: (): Promise<GenieAppIdentity | null> => ipcRenderer.invoke(APP_ME_CHANNEL),

    /**
     * Call a Genie tool. Refused unless the user granted the capability that
     * covers it and the workspace is inside the app's scope; the refusal comes
     * back as `{ ok: false, error }` in words the user could act on, rather than
     * as a throw, so an app can show it.
     */
    call: (
        tool: string,
        args?: Record<string, unknown>,
        workspaceId?: string,
    ): Promise<GenieAppCallResult> =>
        ipcRenderer.invoke(APP_CALL_CHANNEL, { tool, args, workspaceId }),
};

contextBridge.exposeInMainWorld('genieApp', api);
