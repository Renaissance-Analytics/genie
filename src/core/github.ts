/**
 * GITHUB FOR REAL — the pure half (beta.33 item 25, Tynn #780).
 *
 * The owner (2026-10-20), on Settings → GitHub's two hand-ticked "done" chips: "our Github integration and login needs to
 * be way easier than this and it needs to be functional not some dumb list … I already had github setup with this app
 * with genie 1 so why is it not functional anymore?"
 *
 * Genie 1 (`v1:main/github/*`) signed in to the `genie-aos` GitHub App with the DEVICE FLOW (no embedded browser, no
 * client secret, no loopback listener), kept the user token encrypted, read the API for who you are and where the App is
 * installed, and gated features by the permissions GitHub GRANTED each installation. Genie 2 does the same; this file is
 * the part that is data in, data out: GitHub's answers parsed, what each permission enables, the Deck's signal, Genie 1's
 * stored login, and the clone credential. The account itself — the token, the network, the file — is
 * main/github-account.ts. The token NEVER appears in anything this file returns to a window.
 */

/** The `genie-aos` App's public client id (Genie 1's `GENIE_GITHUB_CLIENT_ID`). Public: the device flow needs no secret. */
export const GENIE_GITHUB_CLIENT_ID = 'Iv23liPssWsCpaUIxtIT';
export const GENIE_GITHUB_APP_SLUG = 'genie-aos';
/**
 * The `genie-aos[bot]` ACCOUNT's user id (Genie 1's `GENIE_GITHUB_BOT_USER_ID`), NOT the App id: GitHub links a commit to
 * an account only when its email resolves to one, and the bot's noreply address is built from this id.
 */
export const GENIE_GITHUB_BOT_USER_ID = 294734720;
/**
 * Who a commit Genie makes is by when the machine has NO git identity (Genie 1's `GENIE_FALLBACK_IDENTITY`, genie#215):
 * the App's bot, an address GitHub links and nobody can mistake for a person. Only a fallback — a configured identity
 * is the person's and is kept.
 */
export const GENIE_FALLBACK_IDENTITY = {
    name: `${GENIE_GITHUB_APP_SLUG}[bot]`,
    email: `${GENIE_GITHUB_BOT_USER_ID}+${GENIE_GITHUB_APP_SLUG}[bot]@users.noreply.github.com`,
} as const;
/** Install the App on more accounts or repositories: GitHub's own chooser. */
export const GITHUB_INSTALL_URL = `https://github.com/apps/${GENIE_GITHUB_APP_SLUG}/installations/new`;
/** Where a person revokes Genie's access to their account entirely (sign-out here only forgets the token). */
export const GITHUB_AUTHORIZATIONS_URL = 'https://github.com/settings/apps/authorizations';
export const GITHUB_ROUTE = 'genie://settings/github';

export type GhAccess = 'read' | 'write' | 'admin';
const RANK: Record<GhAccess, number> = { read: 1, write: 2, admin: 3 };
const isAccess = (v: unknown): v is GhAccess => v === 'read' || v === 'write' || v === 'admin';

/** One account the App is installed on, as GitHub reports it. `repos` is listed for a selection; `repoCount` for both. */
export interface GithubInstallation {
    readonly id: number;
    readonly account: string;
    readonly isOrg: boolean;
    readonly selection: 'all' | 'selected';
    /** How many repositories it covers; `null` = GitHub did not say. */
    readonly repoCount: number | null;
    /** The repositories by full name when the installation is a selection; `null` for "all" (could be thousands). */
    readonly repos: readonly string[] | null;
    /** What GitHub GRANTED this installation — narrower than (or equal to) what the App asks for. */
    readonly permissions: Readonly<Record<string, GhAccess>>;
    /** Its own page on GitHub: change the repositories, approve a permission update, uninstall. */
    readonly settingsUrl: string;
}

export type GithubStatus = 'signed-out' | 'signing-in' | 'signed-in' | 'expired';

export interface GithubCapability {
    readonly id: 'clone-private' | 'issue-watch';
    readonly label: string;
    readonly enabled: boolean;
    readonly note: string | null;
}

/** What a window is shown. Never the token. */
export interface GithubView {
    readonly status: GithubStatus;
    readonly user: { readonly login: string; readonly name: string | null } | null;
    /** The device flow under way: the code to type, where, and until when (epoch ms). */
    readonly device: { readonly userCode: string; readonly verificationUri: string; readonly expiresAt: number } | null;
    /** `null` = not read from GitHub yet (a skeleton, never an empty list). */
    readonly installations: readonly GithubInstallation[] | null;
    readonly capabilities: readonly GithubCapability[];
    /** GitHub is being read now. */
    readonly checking: boolean;
    /** The Deck's "GitHub permissions are blocking features", only when something real blocks. */
    readonly signal: { readonly label: string; readonly route: string } | null;
    /** The last thing that went wrong, in words. */
    readonly message: string | null;
}

export function signedOutGithubView(message: string | null): GithubView {
    return { status: 'signed-out', user: null, device: null, installations: null, capabilities: githubCapabilities({ signedIn: false, installations: null }), checking: false, signal: null, message };
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

export interface DeviceCode {
    readonly deviceCode: string;
    readonly userCode: string;
    readonly verificationUri: string;
    readonly expiresIn: number;
    /** Seconds between polls, as GitHub dictates (RFC 8628's default 5 when it does not say). */
    readonly interval: number;
}

/** `POST https://github.com/login/device/code`'s answer, or `null` when GitHub refused or answered nonsense. */
export function deviceCodeFrom(json: unknown): DeviceCode | null {
    const o = obj(json);
    if (!o || o.error !== undefined) return null;
    const deviceCode = str(o.device_code);
    const userCode = str(o.user_code);
    const verificationUri = str(o.verification_uri);
    if (!deviceCode || !userCode || !verificationUri) return null;
    return { deviceCode, userCode, verificationUri, expiresIn: num(o.expires_in) ?? 900, interval: Math.max(5, num(o.interval) ?? 5) };
}

export type PollOutcome =
    | { readonly kind: 'token'; readonly token: string }
    | { readonly kind: 'pending' }
    /** GitHub asks for slower polling: its new interval in seconds, or `null` (then +5 s, RFC 8628 §3.5). */
    | { readonly kind: 'slow-down'; readonly interval: number | null }
    | { readonly kind: 'failed'; readonly code: string; readonly message: string };

/** One answer of `POST https://github.com/login/oauth/access_token` while the person is approving. */
export function pollOutcomeFrom(json: unknown): PollOutcome {
    const o = obj(json) ?? {};
    const token = str(o.access_token);
    if (token) return { kind: 'token', token };
    const code = str(o.error) ?? 'unknown';
    if (code === 'authorization_pending') return { kind: 'pending' };
    if (code === 'slow_down') return { kind: 'slow-down', interval: num(o.interval) };
    if (code === 'expired_token') return { kind: 'failed', code, message: 'The code expired before it was entered on GitHub. Sign in again for a fresh one.' };
    if (code === 'access_denied') return { kind: 'failed', code, message: 'Sign-in was denied or cancelled on GitHub.' };
    return { kind: 'failed', code, message: str(o.error_description) ?? `GitHub refused the sign-in (${code}).` };
}

export function installationSettingsUrl(i: { readonly id: number; readonly account: string; readonly isOrg: boolean }): string {
    return i.isOrg ? `https://github.com/organizations/${encodeURIComponent(i.account)}/settings/installations/${i.id}` : `https://github.com/settings/installations/${i.id}`;
}

/** `GET /user/installations`, each installation the person can act on — without its repositories (read separately). */
export function installationsFrom(json: unknown): Array<Omit<GithubInstallation, 'repoCount' | 'repos'>> {
    const list = obj(json)?.installations;
    if (!Array.isArray(list)) return [];
    const out: Array<Omit<GithubInstallation, 'repoCount' | 'repos'>> = [];
    for (const raw of list) {
        const i = obj(raw);
        const id = num(i?.id);
        const account = obj(i?.account);
        const login = str(account?.login);
        if (!i || id === null || !login) continue;
        const permissions: Record<string, GhAccess> = {};
        for (const [name, level] of Object.entries(obj(i.permissions) ?? {})) if (isAccess(level)) permissions[name] = level;
        const isOrg = account!.type === 'Organization';
        out.push({ id, account: login, isOrg, selection: i.repository_selection === 'selected' ? 'selected' : 'all', permissions, settingsUrl: installationSettingsUrl({ id, account: login, isOrg }) });
    }
    return out;
}

export function grants(i: Pick<GithubInstallation, 'permissions'>, permission: string, access: GhAccess): boolean {
    const have = i.permissions[permission];
    return have !== undefined && RANK[have] >= RANK[access];
}

/**
 * What GitHub's permissions let THIS Genie do, each with why not. Genie 2's GitHub-dependent features, honestly:
 *
 * - Cloning private repositories (Add workspace → from a git URL) over HTTPS with this sign-in: needs Contents (read) on
 *   the installation covering the repository's account. Without it, git's own credentials are used, as before.
 * - IssueWatch is NOT this App's: Tynn reads GitHub with its own GitHub App and pushes what it finds (Tynn #806). Listed
 *   so nobody looks here for why IssueWatch is quiet.
 *
 * Genie 1's repository create and fork are not in Genie 2 (yet); nothing here pretends they are.
 */
export function githubCapabilities(input: { signedIn: boolean; installations: readonly GithubInstallation[] | null }): GithubCapability[] {
    const issueWatch: GithubCapability = { id: 'issue-watch', label: 'IssueWatch (issues, pull requests, security alerts)', enabled: true, note: 'Comes through Tynn: Tynn reads GitHub with its own app. Link the workspace to a Tynn project.' };
    const label = 'Clone private repositories with this sign-in';
    if (!input.signedIn) return [{ id: 'clone-private', label, enabled: false, note: 'Sign in to GitHub to clone private repositories over HTTPS. Public repositories, and your own git credentials, work without it.' }, issueWatch];
    if (input.installations === null) return [{ id: 'clone-private', label, enabled: false, note: 'Reading GitHub…' }, issueWatch];
    if (input.installations.length === 0) return [{ id: 'clone-private', label, enabled: false, note: 'The Genie AOS app is not installed on any account yet: install it on the repositories Genie should reach.' }, issueWatch];
    const reading = input.installations.filter((i) => grants(i, 'contents', 'read')).map((i) => i.account);
    if (reading.length === 0) return [{ id: 'clone-private', label, enabled: false, note: 'No installation grants Contents: approve the Contents permission on the installation’s page on GitHub.' }, issueWatch];
    return [{ id: 'clone-private', label, enabled: true, note: `Repositories of ${reading.join(', ')}.` }, issueWatch];
}

/** The Deck's signal: a sign-in GitHub stopped accepting, the App installed nowhere, or no Contents anywhere. Signed out is not a fault. */
export function githubSignal(input: { status: GithubStatus; installations: readonly GithubInstallation[] | null }): { label: string; route: string } | null {
    const blocked = input.status === 'expired'
        || (input.status === 'signed-in' && input.installations !== null && (input.installations.length === 0 || !input.installations.some((i) => grants(i, 'contents', 'read'))));
    return blocked ? { label: 'GitHub permissions are blocking features', route: GITHUB_ROUTE } : null;
}

/**
 * Genie 1's stored login (its `settings` table, `v1:main/github/storage.ts`): `github_token_enc` — base64 of what
 * Electron's `safeStorage.encryptString` returned — and `github_user`. `null` when there is none.
 */
export function v1GithubLogin(settings: Readonly<Record<string, string>> | null): { tokenEnc: string; login: string | null } | null {
    const tokenEnc = settings?.github_token_enc?.trim();
    if (!tokenEnc) return null;
    return { tokenEnc, login: settings!.github_user?.trim() || null };
}

/** `https://github.com/<owner>/<repo>` → owner, lower-cased; anything else (ssh, another host) → `null`. */
function githubHttpsOwner(url: string): string | null {
    const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/[^/\s]+\/?$/i.exec(url.trim());
    return m ? m[1]!.toLowerCase() : null;
}

/**
 * The clone credential (Genie 1's `githubCloneAuth`), only where it helps: an https github.com repository of an account
 * whose installation grants Contents. Anywhere else a header would SHADOW the person's own credential helper, which may
 * reach a repository this App cannot — so the clone goes exactly as it did without a sign-in. The token rides as git
 * config for that one command (`http.<github>.extraheader`, the GitHub Actions checkout pattern), never in the URL and
 * never written into the clone; `secrets` are what any error must be scrubbed of.
 */
export function cloneAuthFor(url: string, token: string | null, installations: readonly GithubInstallation[] | null): { config: Array<[string, string]>; secrets: string[] } | null {
    if (!token || !installations) return null;
    const owner = githubHttpsOwner(url);
    if (!owner) return null;
    if (!installations.some((i) => i.account.toLowerCase() === owner && grants(i, 'contents', 'read'))) return null;
    const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
    return { config: [['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${basic}`]], secrets: [token, basic] };
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
    let out = text;
    for (const s of secrets) if (s) out = out.split(s).join('***');
    return out;
}
