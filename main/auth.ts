import { app, BrowserWindow, session, shell } from 'electron';
import path from 'node:path';
import { tynnHost, whoami, TynnAuthError } from './tynn-api';
import { showMainWindow } from './background';

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

export async function startSignIn(): Promise<void> {
    const host = tynnHost();
    const ret = encodeURIComponent('genie://oauth/callback');
    const url = `${host}/login?return=${ret}`;
    await shell.openExternal(url);
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

export async function handleGenieUrl(rawUrl: string): Promise<void> {
    try {
        const url = new URL(rawUrl);
        // Path is /oauth/callback. Query carries the token.
        if (url.host !== 'oauth' || url.pathname !== '/callback') {
            console.warn('Unknown genie:// URL ignored:', rawUrl);
            return;
        }
        const token = url.searchParams.get('token');
        if (!token) {
            console.warn('genie://oauth/callback missing token');
            return;
        }
        await redeemToken(token);
    } catch (e) {
        if (e instanceof TynnAuthError) {
            notifyAuthChanged(false);
            return;
        }
        console.error('Auth callback failed:', e);
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
    } else {
        notifyAuthChanged(false);
    }
}

export async function isSignedIn(): Promise<boolean> {
    return (await whoami()) !== null;
}
