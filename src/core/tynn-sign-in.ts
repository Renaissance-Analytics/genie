/**
 * SIGN IN TO TYNN THE WAY GENIE 1 DID (the owner, 2026-10-19: "this is not how we handle tynn logins. Look at Genie 1")
 * — the pure half.
 *
 * Sign in opens `<host>/genie/callback` in the browser. Not `/login`: for someone already signed in to Tynn, Fortify
 * answers `/login` with the dashboard and the return URL is lost. `/genie/callback` signs a visitor in first when needed,
 * then mints a single-use 64-character code and offers it back through `genie://oauth/callback?token=…` — and shows it on
 * the page to paste, for a machine whose protocol handler did not fire. Genie takes the code from either and nothing else.
 */

export const TYNN_CALLBACK = 'genie://oauth/callback';

/** The code Tynn mints: `Str::random(64)`, letters and digits. */
const CODE = /^[A-Za-z0-9]{64}$/;

export function tynnSignInUrl(host: string): string {
    return `${host.trim().replace(/\/+$/, '')}/genie/callback?return=${encodeURIComponent(TYNN_CALLBACK)}`;
}

/** The code in what was pasted — the bare code or the whole callback URL — or in the URL a second launch was handed. */
export function signInCodeFrom(input: string): string | null {
    const text = input.trim();
    if (CODE.test(text)) return text;
    if (!text.startsWith('genie://')) return null;
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        return null;
    }
    if (url.host !== 'oauth' || url.pathname.replace(/\/+$/, '') !== '/callback') return null;
    const token = url.searchParams.get('token') ?? '';
    return CODE.test(token) ? token : null;
}

/** The `genie://` URL among a launch's arguments, where Electron and Chromium put their own switches beside it. */
export function genieUrlIn(argv: readonly string[]): string | null {
    return argv.find((a) => a.startsWith('genie://')) ?? null;
}

/**
 * A Tynn share link, opened (Tynn #839): Tynn's landing page opens `genie://workstation/open?id=…[&workspace=…][&name=…]`
 * (WorkstationController::genieWorkspaceDeepLink) — the workstation to open over the Tynn relay. Anything else, or an id
 * that is not a workstation id, is not one.
 */
export function workstationOpenFrom(url: string): { id: string; workspace: string | null; name: string | null } | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'genie:' || parsed.hostname !== 'workstation' || parsed.pathname !== '/open') return null;
    const id = parsed.searchParams.get('id');
    if (id === null || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
    const workspace = parsed.searchParams.get('workspace');
    const name = parsed.searchParams.get('name');
    return { id, workspace: workspace || null, name: name || null };
}
