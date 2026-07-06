import { app, BrowserWindow, dialog, session, shell } from 'electron';
import path from 'node:path';
import { tynnHost, whoami, TynnAuthError } from './tynn-api';
import { showMainWindow } from './background';
import { getTynnBackend } from './backend/registry';
import { openWorkstationById } from './workstation-open';

/**
 * Sign-in via custom protocol handoff.
 *
 *   1. Genie calls startSignIn() → opens the system browser to
 *      <host>/login?return=genie://oauth/callback
 *   2. User signs in to Tynn the normal way (password or any wired
 *      Socialite provider — Google/GitHub/Facebook/Discord).
 *   3. Tynn redirects to genie://oauth/callback?token=… on success.
 *   4. Electron picks up the URL via 'open-url' (macOS) or
 *      'second-instance' argv (Windows), we extract the token, store
 *      a session cookie, and notify the renderer that auth changed.
 *
 * NO Agents — Genie is the user. The cookie lives in Electron's default
 * session under the configured Tynn host.
 */

const SIGN_IN_LISTENERS = new Set<(signedIn: boolean) => void>();

export function onAuthChanged(cb: (signedIn: boolean) => void): () => void {
    SIGN_IN_LISTENERS.add(cb);
    return () => SIGN_IN_LISTENERS.delete(cb);
}

function notifyAuthChanged(signedIn: boolean): void {
    for (const cb of SIGN_IN_LISTENERS) cb(signedIn);
    // Broadcast to any open BrowserWindow.
    for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('auth:changed', signedIn);
    }
}

export function registerProtocolHandler(): void {
    // Register genie:// so the OS hands incoming URLs to us. The entry
    // path MUST be absolute, otherwise the OS resolves it against its own
    // cwd at launch time (usually C:\WINDOWS\system32 on Windows) and
    // refuses to launch the app. process.argv[1] from `electron .` is
    // sometimes a bare "." or a relative path, so resolve it explicitly.
    if (process.defaultApp) {
        if (process.argv.length >= 2 && process.argv[1]) {
            const entry = path.resolve(process.argv[1]);
            app.setAsDefaultProtocolClient('genie', process.execPath, [entry]);
        }
    } else {
        app.setAsDefaultProtocolClient('genie');
    }
}

export async function startSignIn(): Promise<{ url: string }> {
    const host = tynnHost();
    const ret = encodeURIComponent('genie://oauth/callback');
    // Send the user straight to /genie/callback, not /login. The
    // callback endpoint handles BOTH cases:
    //   - already signed in → renders the handoff page that fires
    //     genie://oauth/callback?token=... immediately.
    //   - signed out → bounces them through /login?return=... and
    //     comes back here automatically after auth.
    // Hitting /login first short-circuits when the user has an active
    // Tynn session — Fortify sees them as already-authenticated and
    // redirects to /dashboard, dropping the return URL on the floor.
    const url = `${host}/genie/callback?return=${ret}`;
    // Best-effort open the LOCAL browser. On a headless / browserless /
    // remotely-driven machine this no-ops or throws — so we always RETURN
    // the URL too, and the renderer shows it for manual copy: open it on
    // any other device, sign in, then paste the code back into Genie.
    try {
        await shell.openExternal(url);
    } catch {
        /* no local browser — the manual copy-URL path covers this */
    }
    return { url };
}

export async function signOut(): Promise<void> {
    const host = tynnHost();
    const cookies = await session.defaultSession.cookies.get({ url: host });
    for (const c of cookies) {
        // c.domain can be undefined; rebuild a URL the cookie store accepts.
        const cookieUrl = `${c.secure ? 'https' : 'http'}://${c.domain?.replace(/^\./, '') ?? new URL(host).host}${c.path ?? '/'}`;
        try {
            await session.defaultSession.cookies.remove(cookieUrl, c.name);
        } catch {
            /* best effort */
        }
    }
    notifyAuthChanged(false);
}

/**
 * A genie://workstation/open deep link that arrived while the Tynn session was
 * DEAD. We stash it, kick off the browser sign-in, and replay it from
 * redeemToken() the moment a live session lands. Single-slot: the newest deep
 * link wins (a second click while signing in just overwrites the target).
 */
let pendingWorkstationOpen: { workstationId: string; name?: string } | null = null;

export async function handleGenieUrl(rawUrl: string): Promise<void> {
    try {
        const url = new URL(rawUrl);
        // genie://oauth/callback?token=… — finish the browser sign-in handoff.
        if (url.host === 'oauth' && url.pathname === '/callback') {
            const token = url.searchParams.get('token');
            if (!token) {
                console.warn('genie://oauth/callback missing token');
                return;
            }
            await redeemToken(token);
            return;
        }
        // genie://workstation/open?id=…&name=… — connect to a Virtual Workstation.
        if (url.host === 'workstation' && url.pathname === '/open') {
            await handleWorkstationOpenUrl(url);
            return;
        }
        console.warn('Unknown genie:// URL ignored:', rawUrl);
    } catch (e) {
        if (e instanceof TynnAuthError) {
            notifyAuthChanged(false);
            return;
        }
        console.error('Auth callback failed:', e);
    }
}

/**
 * genie://workstation/open?id=…&name=… — the CONNECT deep link. Needs a live
 * Tynn session (connectGrant is session-cookied). If we're signed out, stash the
 * request, open the browser sign-in, and let redeemToken() replay it once the
 * session lands. Otherwise open it straight away.
 */
async function handleWorkstationOpenUrl(url: URL): Promise<void> {
    const workstationId = url.searchParams.get('id')?.trim();
    if (!workstationId) {
        console.warn('genie://workstation/open missing id');
        return;
    }
    const name = url.searchParams.get('name')?.trim() || undefined;

    const me = await getTynnBackend().whoami();
    if (!me) {
        pendingWorkstationOpen = { workstationId, name };
        await startSignIn();
        return;
    }
    await performWorkstationOpen({ workstationId, name });
}

/**
 * Resolve the display name (if the deep link omitted it), open the workstation,
 * and surface any failure — not-entitled (connectGrant 403), not-found, or a
 * dead relay — as a dialog. Never throws: a bad deep link must not crash main.
 */
async function performWorkstationOpen(req: { workstationId: string; name?: string }): Promise<void> {
    try {
        let name = req.name;
        if (!name) {
            // Resolve the human-readable name by id; fall back to the id itself.
            const list = await getTynnBackend().listConnectableWorkstations();
            name = list.find((w) => w.id === req.workstationId)?.name ?? req.workstationId;
        }
        const res = await openWorkstationById(req.workstationId, name);
        if (!res.ok) await showWorkstationOpenError(res.error);
    } catch (e) {
        await showWorkstationOpenError(e instanceof Error ? e.message : String(e));
    }
}

async function showWorkstationOpenError(detail?: string): Promise<void> {
    try {
        await dialog.showMessageBox({
            type: 'error',
            title: 'Could not open workstation',
            message: 'Could not open the workstation.',
            detail: detail ?? 'Please try again from the Hosts list in Genie.',
        });
    } catch {
        // No window / headless — the dialog is best-effort; log so it isn't silent.
        console.error('Workstation open failed:', detail);
    }
}

/**
 * Manual code-paste fallback. When the OS protocol handler fails to
 * launch Electron (common in dev, or when shell associations are stale),
 * the Tynn handoff page prints the code so the user can copy + paste it
 * into Genie's sign-in screen. Same exchange flow, no protocol hop.
 */
export async function redeemCode(rawCode: string): Promise<boolean> {
    const code = rawCode.trim();
    if (!code || code.length > 256) return false;
    try {
        await redeemToken(code);
        return (await whoami()) !== null;
    } catch (e) {
        console.error('redeemCode failed:', e);
        notifyAuthChanged(false);
        return false;
    }
}

/**
 * Shared exchange: drop the single-use token as a genie_token cookie on
 * the Tynn origin, then hit /api/v1/me — that swaps it for a real session
 * cookie. Used by both handleGenieUrl (protocol path) and redeemCode
 * (manual paste path).
 */
async function redeemToken(token: string): Promise<void> {
    const host = tynnHost();
    const tynnUrl = new URL(host);
    await session.defaultSession.cookies.set({
        url: host,
        name: 'genie_token',
        value: token,
        domain: tynnUrl.hostname,
        path: '/',
        secure: tynnUrl.protocol === 'https:',
        httpOnly: false,
    });

    const me = await whoami();
    if (me) {
        notifyAuthChanged(true);
        showMainWindow();
        // Replay a genie://workstation/open deep link that arrived while signed
        // out (see handleWorkstationOpenUrl). Fire-and-forget: errors surface via
        // the dialog inside performWorkstationOpen.
        const pending = pendingWorkstationOpen;
        pendingWorkstationOpen = null;
        if (pending) void performWorkstationOpen(pending);
    } else {
        notifyAuthChanged(false);
    }
}

export async function isSignedIn(): Promise<boolean> {
    return (await whoami()) !== null;
}
