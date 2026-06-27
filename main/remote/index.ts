import { BrowserWindow } from 'electron';

/**
 * Work Mode — remote desktop (the local-main proxy).
 *
 * When this Genie is driving a HOST Genie in remote mode, the renderer keeps
 * calling `api()` and listening on the same IPC channels as always — but the
 * LOCAL MAIN reroutes those to the host over the tailnet. This module owns:
 *   - the active remote connection (host + session token) + status broadcast,
 *   - pairing (POST /api/pair — the host shows a desktop confirm, so it blocks
 *     until the user approves ON THE HOST),
 *   - `remoteRequest()` — the generic REST proxy the renderer bridge calls.
 *
 * The host-WS re-emit (/ws/events + per-terminal /ws/term → local IPC channels)
 * and terminal I/O forwarding land in the next increment; this is the connection
 * + REST foundation. The session token NEVER reaches the renderer — every host
 * call is proxied here, so the renderer can't leak it.
 */

export interface RemoteHost {
    ip: string;
    port: number;
    hostname: string;
}

interface RemoteState {
    host: RemoteHost | null;
    token: string | null;
    connected: boolean;
}

const state: RemoteState = { host: null, token: null, connected: false };

/** The host's base URL while connected, else null. */
export function remoteBase(): string | null {
    return state.host ? `http://${state.host.ip}:${state.host.port}` : null;
}

/** The active session token (main-only — never exposed to the renderer). */
export function remoteToken(): string | null {
    return state.token;
}

export function isRemote(): boolean {
    return state.connected;
}

/** Renderer-facing status — deliberately omits the token. */
export function remoteStatus(): { connected: boolean; host: RemoteHost | null } {
    return { connected: state.connected, host: state.host };
}

function broadcastStatus(): void {
    const s = remoteStatus();
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('remote:status', s);
    }
}

/**
 * Pair with + connect to a host Genie. `POST /api/pair {pin}` — the host pops a
 * desktop confirm, so this BLOCKS until the user approves on the host (or it's
 * declined / times out). On success we hold the token + enter remote mode.
 */
export async function connectRemote(
    host: RemoteHost,
    pin: string,
): Promise<{ ok: boolean; error?: string }> {
    let res: Response;
    try {
        res = await fetch(`http://${host.ip}:${host.port}/api/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin }),
        });
    } catch (e) {
        return { ok: false, error: `Couldn't reach ${host.hostname}: ${(e as Error).message}` };
    }
    if (!res.ok) {
        const error =
            res.status === 401
                ? 'Wrong PIN — check the host and try again.'
                : res.status === 403
                    ? 'The host declined this device.'
                    : res.status === 429
                        ? 'Too many attempts — wait a moment and retry.'
                        : `Pairing failed (HTTP ${res.status}).`;
        return { ok: false, error };
    }
    const data = (await res.json().catch(() => null)) as { token?: string } | null;
    if (!data?.token) return { ok: false, error: 'Malformed pairing response from the host.' };

    state.host = host;
    state.token = data.token;
    state.connected = true;
    broadcastStatus();
    return { ok: true };
}

/** Leave remote mode (viewer-only — never touches the host's terminals/processes). */
export function disconnectRemote(): void {
    state.host = null;
    state.token = null;
    state.connected = false;
    broadcastStatus();
}

/**
 * Proxy a REST call to the host (Bearer token attached). This is the generic
 * transport the renderer's remote bridge maps every desktop method onto. A 401
 * means the token died host-side → we drop remote mode so the UI returns local.
 */
export async function remoteRequest(
    path: string,
    init?: { method?: string; json?: unknown },
): Promise<unknown> {
    const base = remoteBase();
    if (!base || !state.token) throw new Error('Not connected to a host.');

    const headers: Record<string, string> = { Authorization: `Bearer ${state.token}` };
    let body: string | undefined;
    if (init?.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(init.json);
    }

    const res = await fetch(`${base}${path}`, {
        method: init?.method ?? 'GET',
        headers,
        body,
    });

    if (res.status === 401) {
        disconnectRemote();
        throw new Error('Remote session expired — re-pair with the host.');
    }
    if (res.status === 423) {
        throw new Error('The host has remote control locked.');
    }
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
            const d = (await res.json()) as { error?: string };
            if (d?.error) msg = d.error;
        } catch {
            /* non-JSON error body */
        }
        throw new Error(msg);
    }
    if (res.status === 204) return undefined;
    return res.json().catch(() => undefined);
}
