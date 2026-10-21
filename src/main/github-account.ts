import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
    GENIE_GITHUB_CLIENT_ID,
    GITHUB_AUTHORIZATIONS_URL,
    GITHUB_INSTALL_URL,
    GithubApiError,
    GithubAuthError,
    GithubNotInstalledError,
    GithubRateLimitError,
    cloneAuthFor,
    createdRepoFrom,
    deviceCodeFrom,
    githubErrorMessage,
    githubInstallUrl,
    githubCapabilities,
    githubSignal,
    installationsFrom,
    pollOutcomeFrom,
    pushAuthFor,
    rateLimitWaitMs,
    refreshOutcomeFrom,
    v1GithubLogin,
    type CreatedRepo,
    type GithubInstallation,
    type GithubStatus,
    type GithubView,
    type TokenGrant,
} from '../core/github.js';

/**
 * THIS GENIE'S GITHUB SIGN-IN (beta.33 item 25, Tynn #780) — Genie 1's, carried over and ported.
 *
 * The owner (2026-10-20): "I already had github setup with this app with genie 1 so why is it not functional anymore?"
 *
 * CARRIED OVER, MEASURED (on the owner's machine, values never printed): Genie 1 keeps `github_token_enc` (base64 of
 * Electron `safeStorage.encryptString(token)`, a Chromium `v10` blob) and `github_user` in its `genie.db`, under
 * Chromium's userData (`%APPDATA%\genie`). Genie 2 runs with the SAME userData — both packages are named `genie` — so its
 * safeStorage uses the same `Local State` key: that key, unwrapped with DPAPI, AES-GCM-decrypted the blob to a 40-char
 * `ghu_` token, and GitHub answered `GET /user/installations` 200. So the import is: read Genie 1's row (read-only), decrypt
 * it with this Genie's cipher, keep it encrypted in Genie 2's own file. A blob that cannot be decrypted (another OS user,
 * a reset keychain, Linux on another password store) is said in words, and the fallback is the one-click device flow.
 *
 * SIGN IN is Genie 1's device flow (`v1:main/github/device-flow.ts`): GitHub hands a code, the browser opens at GitHub's
 * page, and Genie polls at the interval GitHub dictates — slowing when GitHub says `slow_down` (RFC 8628: that polling IS
 * the protocol; there is no push). No client secret, no scope (a GitHub App's permissions live on the App).
 *
 * THE TOKEN never leaves this object: not in a view, a message, an error or a log. At rest it is only ever encrypted
 * (the OS's encryption via safeStorage, passed in as the cipher, as main/workstation-identity.ts keeps the Tynn
 * workstation key); without OS encryption a sign-in is refused before GitHub is asked, so a token that could only be kept
 * in the clear is never minted. Sign out forgets it and records that, so Genie 1's login is not imported again.
 *
 * WRITES (add-workspace parity item 9; Genie 1's `v1:main/github/api.ts`): the same user token writes — JSON bodies,
 * GitHub's own error message (with `errors[]`), rate limits waited out when near and named when not. When the App
 * expires user tokens, GitHub's refresh token is kept beside the access token, encrypted the same way, and exchanged
 * (once, for every caller) when the access token is due or GitHub answers 401. A refused renewal ends the sign-in in
 * GitHub's words; a passing fault keeps it. A write refused on an account the App is not installed on carries the
 * install chooser for that account.
 */

/** Electron's safeStorage, as a port. */
export interface GithubCipher {
    isAvailable(): boolean;
    encrypt(text: string): Buffer;
    decrypt(bytes: Buffer): string;
}

export type GithubFetch = (url: string, init: { method: 'GET' | 'POST' | 'PATCH'; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; headers?: { get(name: string): string | null }; text(): Promise<string> }>;

/** What `createRepo` makes: a repository under the signed-in person (`owner` = their login) or an organization. */
export interface CreateRepoOptions {
    readonly owner: string;
    readonly name: string;
    readonly private: boolean;
    readonly description?: string;
}

export interface GithubAccountPorts {
    /** Genie 2's own file (`~/.genie/github.json`): the login in the clear, the token encrypted. */
    readonly file: string;
    readonly cipher: GithubCipher;
    readonly fetch: GithubFetch;
    /** Genie 1's settings table, read-only; `null` when there is none. */
    readonly v1Settings?: () => Readonly<Record<string, string>> | null;
    /** Opens the person's browser. */
    readonly openExternal?: (url: string) => Promise<void>;
    /** Waits between polls; rejects when the signal aborts. */
    readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    readonly now?: () => number;
}

export type GithubPage = { page: 'install' } | { page: 'device' } | { page: 'authorizations' } | { page: 'installation'; installationId: number };

/** What the Settings surface and the IPC need — the account as a port, faked in tests. */
export interface GithubAccountPort {
    view(): GithubView;
    startSignIn(): Promise<void>;
    cancelSignIn(): void;
    signOut(): Promise<void>;
    refresh(): Promise<void>;
    openPage(target: GithubPage): Promise<void>;
    onChange(listener: () => void): () => void;
}

/**
 * `refreshEnc` (encrypted like `tokenEnc`) and the two expiries (epoch ms) are there only when the App expires user
 * tokens; a file without them is a non-expiring token, as every file written before them was.
 */
type StoredFile =
    | { version: 1; state: 'signed-out' }
    | { version: 1; state: 'signed-in'; login: string; name: string | null; source: 'genie-1' | 'sign-in'; tokenEnc: string; refreshEnc?: string; accessExpiresAt?: number; refreshExpiresAt?: number };
type SignedInFile = Extract<StoredFile, { state: 'signed-in' }>;
/** The tokens in memory, decrypted: main only, never in a view, a message, an error or a log. */
type HeldTokens = { token: string; refreshToken: string | null; accessExpiresAt: number | null; refreshExpiresAt: number | null };

const API = 'https://api.github.com';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const NO_ENCRYPTION = 'OS encryption is unavailable, so Genie will not keep a GitHub sign-in (it would be in the clear). On Linux, install gnome-keyring / libsecret.';
const reach = (error: unknown) => `GitHub could not be reached (${error instanceof Error ? error.message : String(error)})`;
const NOT_ACCEPTED = 'GitHub no longer accepts this sign-in (it was revoked, or the app was uninstalled from your account). Sign in again.';
const PLACEHOLDER_LOGIN = 'your GitHub account';
/** An access token this close to its recorded expiry is renewed first, so a request never goes out on one about to die (Genie 1). */
const EXPIRY_SKEW_MS = 60_000;
/** The longest rate-limit wait Genie sits out by itself; a longer one is an error that says when to try again. */
const MAX_RATE_WAIT_MS = 60_000;

type Answer = { status: number; json: unknown; text: string; headers?: { get(name: string): string | null } };

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error('cancelled')); };
    signal.addEventListener('abort', onAbort, { once: true });
});

export class GithubAccount implements GithubAccountPort {
    readonly #ports: GithubAccountPorts;
    #status: GithubStatus = 'signed-out';
    #token: string | null = null;
    #refreshToken: string | null = null;
    #accessExpiresAt: number | null = null;
    #refreshExpiresAt: number | null = null;
    /** The one renewal under way: GitHub rotates the refresh token on use, so every caller shares it (Genie 1's single flight). */
    #renewing: Promise<string> | null = null;
    #user:{ login: string; name: string | null } | null = null;
    #device: GithubView['device'] = null;
    #installations: GithubInstallation[] | null = null;
    #checking = false;
    #message: string | null = null;
    #flow: { abort: AbortController; done: Promise<void> } | null = null;
    readonly #listeners = new Set<() => void>();

    private constructor(ports: GithubAccountPorts) {
        this.#ports = ports;
    }

    /** Reads this Genie's sign-in; with none ever made here, carries Genie 1's over. Does not touch the network. */
    static async open(ports: GithubAccountPorts): Promise<GithubAccount> {
        const account = new GithubAccount(ports);
        const stored = await account.#load();
        if (stored === null) await account.#importV1();
        else if (stored.state === 'signed-in') account.#restore(stored);
        return account;
    }

    view(): GithubView {
        const signedIn = this.#status === 'signed-in';
        return {
            status: this.#status,
            user: this.#user,
            device: this.#device,
            installations: this.#installations,
            capabilities: githubCapabilities({ signedIn, installations: signedIn ? this.#installations : null }),
            checking: this.#checking,
            signal: githubSignal({ status: this.#status, installations: this.#installations }),
            message: this.#message,
        };
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #changed(): void {
        for (const l of this.#listeners) l();
    }

    async #load(): Promise<StoredFile | null> {
        let text: string;
        try {
            text = await readFile(this.#ports.file, 'utf8');
        } catch {
            return null;
        }
        try {
            const parsed = JSON.parse(text) as Partial<StoredFile> | null;
            if (parsed?.state === 'signed-out') return { version: 1, state: 'signed-out' };
            if (parsed?.state === 'signed-in' && typeof parsed.login === 'string' && typeof parsed.tokenEnc === 'string') {
                const p = parsed as Partial<SignedInFile>;
                return {
                    version: 1, state: 'signed-in', login: parsed.login, name: typeof parsed.name === 'string' ? parsed.name : null, source: parsed.source === 'genie-1' ? 'genie-1' : 'sign-in', tokenEnc: parsed.tokenEnc,
                    ...(typeof p.refreshEnc === 'string' && p.refreshEnc ? { refreshEnc: p.refreshEnc } : {}),
                    ...(typeof p.accessExpiresAt === 'number' ? { accessExpiresAt: p.accessExpiresAt } : {}),
                    ...(typeof p.refreshExpiresAt === 'number' ? { refreshExpiresAt: p.refreshExpiresAt } : {}),
                };
            }
        } catch {
            // Damaged: treated as signed out here, and not re-imported over (a person's file is never second-guessed).
        }
        return { version: 1, state: 'signed-out' };
    }

    async #save(file: StoredFile): Promise<void> {
        await mkdir(dirname(this.#ports.file), { recursive: true });
        const tmp = `${this.#ports.file}.tmp`;
        await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
        await rename(tmp, this.#ports.file);
    }

    #decrypt(blob: string): { ok: true; token: string } | { ok: false; reason: 'unavailable' | 'failed' } {
        if (!this.#ports.cipher.isAvailable()) return { ok: false, reason: 'unavailable' };
        try {
            const token = this.#ports.cipher.decrypt(Buffer.from(blob, 'base64'));
            return token ? { ok: true, token } : { ok: false, reason: 'failed' };
        } catch {
            return { ok: false, reason: 'failed' };
        }
    }

    #restore(stored: SignedInFile): void {
        this.#user = { login: stored.login, name: stored.name };
        const t = this.#decrypt(stored.tokenEnc);
        if (t.ok) {
            this.#token = t.token;
            // A refresh token that no longer decrypts is no renewal: the access token is used until GitHub refuses it.
            const r = stored.refreshEnc ? this.#decrypt(stored.refreshEnc) : null;
            this.#refreshToken = r?.ok ? r.token : null;
            this.#accessExpiresAt = stored.accessExpiresAt ?? null;
            this.#refreshExpiresAt = stored.refreshExpiresAt ?? null;
            this.#status = 'signed-in';
            return;
        }
        this.#status = 'expired';
        this.#message = t.reason === 'unavailable'
            ? `${NO_ENCRYPTION} The saved sign-in for ${stored.login} cannot be read until it is.`
            : `This Genie cannot decrypt the saved GitHub sign-in for ${stored.login} (the OS keychain changed, or another OS user saved it). Sign in again.`;
    }

    /** Genie 1's login, decrypted with this Genie's key and kept encrypted in this Genie's file. Only when none was ever made here. */
    async #importV1(): Promise<void> {
        let settings: Readonly<Record<string, string>> | null = null;
        try {
            settings = this.#ports.v1Settings?.() ?? null;
        } catch {
            settings = null;
        }
        const v1 = v1GithubLogin(settings);
        if (!v1) return;
        const t = this.#decrypt(v1.tokenEnc);
        if (!t.ok) {
            // Nothing written: a later launch (encryption back, the right user) tries again.
            this.#message = t.reason === 'unavailable'
                ? `Genie 1’s GitHub sign-in is on this machine, but ${NO_ENCRYPTION}`
                : 'Genie 1’s GitHub sign-in is on this machine, but this Genie cannot decrypt it (it was saved under another OS user or keychain). Sign in once below.';
            return;
        }
        const login = v1.login ?? PLACEHOLDER_LOGIN;
        // Genie 1's refresh token and expiries come with it (a refresh token this Genie cannot decrypt is left behind).
        const r = v1.refreshEnc ? this.#decrypt(v1.refreshEnc) : null;
        const tokens: HeldTokens = { token: t.token, refreshToken: r?.ok ? r.token : null, accessExpiresAt: v1.accessExpiresAt ?? null, refreshExpiresAt: v1.refreshExpiresAt ?? null };
        try {
            await this.#save(this.#fileFor(tokens, login, null, 'genie-1'));
        } catch (error) {
            // Used for this run all the same; the next launch carries it over again.
            this.#message = `Genie 1’s GitHub sign-in is in use, but it could not be saved for next time (${error instanceof Error ? error.message : String(error)}).`;
        }
        this.#hold(tokens);
        this.#user = { login, name: null };
        this.#status = 'signed-in';
    }

    #fileFor(t: HeldTokens, login: string, name: string | null, source: SignedInFile['source']): SignedInFile {
        const encrypt = (text: string) => this.#ports.cipher.encrypt(text).toString('base64');
        return {
            version: 1, state: 'signed-in', login, name, source, tokenEnc: encrypt(t.token),
            ...(t.refreshToken ? { refreshEnc: encrypt(t.refreshToken) } : {}),
            ...(t.accessExpiresAt !== null ? { accessExpiresAt: t.accessExpiresAt } : {}),
            ...(t.refreshExpiresAt !== null ? { refreshExpiresAt: t.refreshExpiresAt } : {}),
        };
    }

    #hold(t: HeldTokens): void {
        this.#token = t.token;
        this.#refreshToken = t.refreshToken;
        this.#accessExpiresAt = t.accessExpiresAt;
        this.#refreshExpiresAt = t.refreshExpiresAt;
    }

    /** A grant GitHub just handed over, with its lifetimes made absolute. A renewal without a new refresh token keeps the old one. */
    #tokensFrom(grant: TokenGrant, keepRefresh: string | null = null): HeldTokens {
        const now = this.#now();
        return {
            token: grant.token,
            refreshToken: grant.refreshToken ?? keepRefresh,
            accessExpiresAt: grant.expiresIn !== undefined ? now + grant.expiresIn * 1000 : null,
            refreshExpiresAt: grant.refreshToken
                ? (grant.refreshExpiresIn !== undefined ? now + grant.refreshExpiresIn * 1000 : null)
                : keepRefresh ? this.#refreshExpiresAt : null,
        };
    }

    #now(): number {
        return (this.#ports.now ?? Date.now)();
    }

    /** One request with the given token, as sent: JSON in (with its Content-Type) when there is a body, the answer parsed. */
    async #api(path: string, token: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', body?: unknown): Promise<Answer> {
        const res = await this.#ports.fetch(`${API}${path}`, {
            method,
            headers: {
                Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Genie',
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const text = await res.text().catch(() => '');
        let json: unknown = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        return { status: res.status, json, text, ...(res.headers ? { headers: res.headers } : {}) };
    }

    /** The sign-in's access token, renewed first when its recorded expiry is (about to be) reached. */
    async #freshToken(): Promise<string> {
        if (this.#status !== 'signed-in' || !this.#token) throw new GithubAuthError(this.#status === 'expired' && this.#message ? this.#message : 'Sign in to GitHub first (Settings → GitHub).');
        if (this.#accessExpiresAt === null || this.#now() < this.#accessExpiresAt - EXPIRY_SKEW_MS) return this.#token;
        return this.#renew();
    }

    #renew(): Promise<string> {
        this.#renewing ??= this.#doRenew().finally(() => { this.#renewing = null; });
        return this.#renewing;
    }

    /** The sign-in is over: said in words, the Deck told, the tokens dropped. */
    #expire(message: string): GithubAuthError {
        this.#token = null;
        this.#refreshToken = null;
        this.#accessExpiresAt = null;
        this.#refreshExpiresAt = null;
        this.#status = 'expired';
        this.#installations = null;
        this.#message = message;
        this.#changed();
        return new GithubAuthError(message);
    }

    /**
     * Exchange the refresh token for a new pair (Genie 1's `doRenew`, `v1:main/github/api.ts`) and keep it encrypted. A
     * REFUSAL (GitHub's 200 with an `error`) ends the sign-in, in GitHub's words; a PASSING fault (5xx, 429, no network)
     * does not — the sign-in is kept and the caller is told to try again, so a blip never throws a good sign-in away.
     */
    async #doRenew(): Promise<string> {
        const refresh = this.#refreshToken;
        if (!refresh) throw this.#expire('The GitHub sign-in ran out, and there is nothing to renew it with. Sign in again.');
        if (this.#refreshExpiresAt !== null && this.#now() >= this.#refreshExpiresAt) throw this.#expire('The GitHub sign-in ran out, and so did its renewal. Sign in again.');
        const retry = (status: number, why: string) => new GithubApiError(status, `Genie could not renew the GitHub sign-in right now (${why}); try again in a moment.`);
        let res: Awaited<ReturnType<GithubFetch>>;
        try {
            res = await this.#ports.fetch(TOKEN_URL, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Genie' }, body: new URLSearchParams({ client_id: GENIE_GITHUB_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refresh }).toString() });
        } catch (error) {
            throw retry(0, reach(error));
        }
        if (!res.ok) throw retry(res.status, `GitHub answered ${res.status}`);
        let json: unknown = null;
        try { json = JSON.parse(await res.text()); } catch { json = null; }
        const outcome = refreshOutcomeFrom(json);
        if (outcome.kind === 'rejected') {
            // genie#263: GitHub's refresh grant wants the App's client secret, and Genie ships none (a secret in a desktop
            // app is not a secret). That is not a dead token, and saying it is sends the person round a loop.
            throw this.#expire(outcome.code === 'incorrect_client_credentials'
                ? 'GitHub will not renew this sign-in without the Genie AOS app’s client secret, which Genie does not carry. Sign in again (turning off “Expire user authorization tokens” on the app ends this for good).'
                : `GitHub refused to renew the sign-in: ${outcome.description ?? outcome.code}. Sign in again.`);
        }
        const tokens = this.#tokensFrom(outcome, refresh);
        this.#hold(tokens);
        const stored = await this.#load();
        try {
            if (stored?.state === 'signed-in') await this.#save(this.#fileFor(tokens, stored.login, stored.name, stored.source));
        } catch (error) {
            // GitHub has already rotated the refresh token: the new pair is used this run, and the person is told it is not kept.
            this.#message = `The GitHub sign-in was renewed, but could not be saved for next time (${error instanceof Error ? error.message : String(error)}).`;
            this.#changed();
        }
        return tokens.token;
    }

    /**
     * A request on the sign-in: renewed before when due, renewed and sent once more on a 401, a rate limit waited out when
     * GitHub's reset is near (once), and an error naming the wait when it is not. Answers every other status as it came.
     */
    async #request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<Answer> {
        let token = await this.#freshToken();
        let renewed = false;
        let waited = false;
        for (;;) {
            const answer = await this.#api(path, token, method, body);
            if (answer.status === 401) {
                if (!renewed && this.#refreshToken) { renewed = true; token = await this.#renew(); continue; }
                throw this.#expire(NOT_ACCEPTED);
            }
            const wait = rateLimitWaitMs(answer.status, answer.headers, this.#now());
            if (wait !== null) {
                if (!waited && wait <= MAX_RATE_WAIT_MS) {
                    waited = true;
                    await (this.#ports.sleep ?? defaultSleep)(wait, new AbortController().signal);
                    continue;
                }
                const minutes = Math.max(1, Math.ceil(wait / 60_000));
                throw new GithubRateLimitError(answer.status, `GitHub’s rate limit is reached (${githubErrorMessage(answer.status, answer.json, answer.text)}). It lifts in about ${minutes} min; try again then.`, wait);
            }
            return answer;
        }
    }

    /** `#request`, with anything but a 2xx thrown as GitHub said it. */
    async #call(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<unknown> {
        const answer = await this.#request(method, path, body);
        if (answer.status < 200 || answer.status >= 300) throw new GithubApiError(answer.status, githubErrorMessage(answer.status, answer.json, answer.text));
        return answer.json;
    }

    async #form(url: string, body: Record<string, string>): Promise<unknown> {
        const res = await this.#ports.fetch(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Genie' }, body: new URLSearchParams(body).toString() });
        if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
        const text = await res.text();
        return text ? (JSON.parse(text) as unknown) : null;
    }

    /** One installation's repositories: listed (every page) when it is a selection, counted when it is all. */
    async #repositories(id: number, selection: 'all' | 'selected'): Promise<{ repoCount: number | null; repos: string[] | null }> {
        if (selection === 'all') {
            const r = await this.#request('GET', `/user/installations/${id}/repositories?per_page=1`);
            const count = (r.json as { total_count?: unknown } | null)?.total_count;
            return { repoCount: typeof count === 'number' ? count : null, repos: null };
        }
        const repos: string[] = [];
        let total: number | null = null;
        for (let page = 1; page <= 50; page++) {
            const r = await this.#request('GET', `/user/installations/${id}/repositories?per_page=100&page=${page}`);
            const body = r.json as { total_count?: unknown; repositories?: Array<{ full_name?: unknown }> } | null;
            if (r.status !== 200 || !body) break;
            if (typeof body.total_count === 'number') total = body.total_count;
            const batch = Array.isArray(body.repositories) ? body.repositories : [];
            for (const repo of batch) if (typeof repo.full_name === 'string') repos.push(repo.full_name);
            if (batch.length < 100 || (total !== null && repos.length >= total)) break;
        }
        return { repoCount: total ?? repos.length, repos };
    }

    /** Read GitHub now: who this sign-in is, where the App is installed, the repositories and the permissions granted. */
    async refresh(): Promise<void> {
        if (!this.#token || this.#status === 'signing-in') return;
        this.#checking = true;
        this.#changed();
        try {
            // Through #request: a token due is renewed first, a 401 renewed once, and a sign-in GitHub no longer accepts
            // (and cannot renew) is marked expired there, in words.
            const me = await this.#request('GET', '/user');
            if (me.status !== 200) {
                this.#message = `GitHub answered ${me.status} when asked who this sign-in is. Check again in a moment.`;
                return;
            }
            const u = me.json as { login?: unknown; name?: unknown } | null;
            if (typeof u?.login === 'string') {
                const user = { login: u.login, name: typeof u.name === 'string' ? u.name : null };
                this.#user = user;
                // The file's login follows GitHub's (a renamed account), so the card is right before GitHub is read next time.
                const stored = await this.#load();
                if (stored?.state === 'signed-in' && (stored.login !== user.login || stored.name !== user.name)) await this.#save({ ...stored, login: user.login, name: user.name });
            }
            const list = await this.#request('GET', '/user/installations?per_page=100');
            if (list.status !== 200) {
                this.#message = `GitHub answered ${list.status} when asked where the Genie AOS app is installed. Check again in a moment.`;
                return;
            }
            const installs = installationsFrom(list.json);
            this.#installations = await Promise.all(installs.map(async (i) => ({ ...i, ...(await this.#repositories(i.id, i.selection)) })));
            this.#status = 'signed-in';
            this.#message = null;
        } catch (error) {
            // A sign-in that ended says so itself (#expire); a refused renewal or a rate limit is GitHub's own words.
            if (error instanceof GithubApiError) this.#message = error.message;
            else if (!(error instanceof GithubAuthError)) this.#message = reach(error);
        } finally {
            this.#checking = false;
            this.#changed();
        }
    }

    /** One button: GitHub's code shown, its page opened, then Genie waits for GitHub by itself. */
    async startSignIn(): Promise<void> {
        // A sign-in already under way ends first (and puts its status back), so two flows never share the state.
        const previous = this.#flow;
        this.cancelSignIn();
        if (previous) await previous.done;
        if (!this.#ports.cipher.isAvailable()) {
            this.#message = NO_ENCRYPTION;
            this.#changed();
            return;
        }
        let code: ReturnType<typeof deviceCodeFrom>;
        try {
            code = deviceCodeFrom(await this.#form(DEVICE_CODE_URL, { client_id: GENIE_GITHUB_CLIENT_ID }));
        } catch (error) {
            this.#message = reach(error);
            this.#changed();
            return;
        }
        if (!code) {
            this.#message = 'GitHub did not start a sign-in for the Genie AOS app. Try again in a moment.';
            this.#changed();
            return;
        }
        const now = this.#ports.now ?? Date.now;
        // Where to return if this flow is cancelled or fails: never 'signing-in' (the previous flow has ended above).
        const before = this.#status;
        this.#status = 'signing-in';
        this.#message = null;
        const expiresAt = now() + code.expiresIn * 1000;
        this.#device = { userCode: code.userCode, verificationUri: code.verificationUri, expiresAt };
        const abort = new AbortController();
        const done = this.#poll(code.deviceCode, code.interval, expiresAt, abort.signal, before);
        this.#flow = { abort, done };
        this.#changed();
        try {
            await this.#ports.openExternal?.(code.verificationUri);
        } catch {
            // No browser here: the page and the code stay on screen to use on any device.
        }
    }

    /** Settles when the sign-in under way ends, however it ends (for the tests and for main's ordering). */
    signInSettled(): Promise<void> {
        return this.#flow?.done ?? Promise.resolve();
    }

    cancelSignIn(): void {
        this.#flow?.abort.abort();
    }

    async #poll(deviceCode: string, interval: number, deadline: number, signal: AbortSignal, before: GithubStatus): Promise<void> {
        const sleep = this.#ports.sleep ?? defaultSleep;
        const now = this.#ports.now ?? Date.now;
        let seconds = interval;
        const end = (message: string | null) => {
            this.#device = null;
            this.#flow = null;
            // Back to where it was: a cancelled re-sign-in leaves an expired sign-in expired, a working one working.
            this.#status = before;
            this.#message = message;
            this.#changed();
        };
        for (;;) {
            try {
                await sleep(seconds * 1000, signal);
            } catch {
                end(null);
                return;
            }
            if (signal.aborted) { end(null); return; }
            if (now() > deadline) { end('The code expired before it was entered on GitHub. Sign in again for a fresh one.'); return; }
            let outcome;
            try {
                outcome = pollOutcomeFrom(await this.#form(TOKEN_URL, { client_id: GENIE_GITHUB_CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }));
            } catch (error) {
                end(reach(error));
                return;
            }
            if (signal.aborted) { end(null); return; }
            if (outcome.kind === 'pending') continue;
            if (outcome.kind === 'slow-down') { seconds = outcome.interval ?? seconds + 5; continue; }
            if (outcome.kind === 'failed') { end(outcome.message); return; }
            await this.#signedIn(outcome, before);
            return;
        }
    }

    async #signedIn(grant: TokenGrant, before: GithubStatus): Promise<void> {
        const token = grant.token;
        // GitHub's refresh token and lifetimes, kept with the token (a non-expiring sign-in has none).
        const tokens = this.#tokensFrom(grant);
        this.#flow = null;
        this.#device = null;
        let login: string | null = null;
        let name: string | null = null;
        try {
            const me = await this.#api('/user', token);
            const u = me.json as { login?: unknown; name?: unknown } | null;
            if (me.status === 200 && typeof u?.login === 'string') { login = u.login; name = typeof u.name === 'string' ? u.name : null; }
        } catch {
            // Read again by refresh below.
        }
        if (!this.#ports.cipher.isAvailable()) {
            this.#status = before;
            this.#message = NO_ENCRYPTION;
            this.#changed();
            return;
        }
        try {
            await this.#save(this.#fileFor(tokens, login ?? PLACEHOLDER_LOGIN, name, 'sign-in'));
        } catch (error) {
            this.#status = before;
            this.#message = `Signed in on GitHub, but the sign-in could not be saved (${error instanceof Error ? error.message : String(error)}). Try again.`;
            this.#changed();
            return;
        }
        this.#hold(tokens);
        this.#user = { login: login ?? PLACEHOLDER_LOGIN, name };
        this.#status = 'signed-in';
        this.#installations = null;
        this.#message = null;
        this.#changed();
        await this.refresh();
    }

    /** Forgets the token here (GitHub keeps the authorization until it is revoked on GitHub's page) and records it. */
    async signOut(): Promise<void> {
        this.cancelSignIn();
        await this.#flow?.done;
        await this.#save({ version: 1, state: 'signed-out' });
        this.#token = null;
        this.#refreshToken = null;
        this.#accessExpiresAt = null;
        this.#refreshExpiresAt = null;
        this.#user = null;
        this.#installations = null;
        this.#status = 'signed-out';
        this.#message = null;
        this.#changed();
    }

    /** Opens one of GitHub's pages — always a URL of Genie's own or GitHub's own answer, never one a window sent. */
    async openPage(target: GithubPage): Promise<void> {
        let url: string | null = null;
        if (target.page === 'install') url = GITHUB_INSTALL_URL;
        else if (target.page === 'authorizations') url = GITHUB_AUTHORIZATIONS_URL;
        else if (target.page === 'device') url = this.#device?.verificationUri ?? null;
        else url = this.#installations?.find((i) => i.id === target.installationId)?.settingsUrl ?? null;
        if (!url || !/^https:\/\/github\.com\//.test(url)) return;
        await this.#ports.openExternal?.(url);
    }

    /**
     * Create a repository (Genie 1's `createRepo`): under the signed-in person when `owner` is their login (POST
     * /user/repos), else under that organization (POST /orgs/{org}/repos). Main-side only — for the add-workspace wizard
     * to make its `<slug>.agi` (item 11). Never auto-initialised: the caller pushes its own first commit.
     *
     * - 422 "name already exists": the repository an earlier, half-finished run made is read back and handed over as
     *   `created: false` instead of dead-ending the retry (Genie 1).
     * - 403/404: the App is not installed on that account → GithubNotInstalledError with the install chooser for it.
     */
    async createRepo(opts: CreateRepoOptions): Promise<CreatedRepo> {
        const body = { name: opts.name, private: opts.private, auto_init: false, description: opts.description ?? '' };
        const personal = await this.#isPersonal(opts.owner);
        const path = personal ? '/user/repos' : `/orgs/${encodeURIComponent(opts.owner)}/repos`;
        let json: unknown;
        let created = true;
        try {
            json = await this.#call('POST', path, body);
        } catch (error) {
            if (!(error instanceof GithubApiError) || error instanceof GithubRateLimitError) throw error;
            if (error.status === 422 && /already exists/i.test(error.message)) {
                json = await this.#call('GET', `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.name)}`);
                created = false;
            } else if (error.status === 403 || error.status === 404) {
                throw await this.#notInstalled(error, opts.owner);
            } else {
                throw error;
            }
        }
        const repo = createdRepoFrom(json, created);
        if (!repo) throw new GithubApiError(0, `GitHub answered without the repository ${opts.owner}/${opts.name}.`);
        return repo;
    }

    /** Is `owner` the signed-in person (not an organization)? The installation says so when there is one; else their login. */
    async #isPersonal(owner: string): Promise<boolean> {
        const lower = owner.toLowerCase();
        const installation = this.#installations?.find((i) => i.account.toLowerCase() === lower);
        if (installation) return !installation.isOrg;
        let login = this.#user?.login ?? null;
        if (!login || login === PLACEHOLDER_LOGIN) {
            const me = await this.#call('GET', '/user');
            login = typeof (me as { login?: unknown } | null)?.login === 'string' ? (me as { login: string }).login : null;
        }
        return login !== null && login.toLowerCase() === lower;
    }

    /** The not-installed error for `account`, the chooser pre-targeted at its id when GitHub says it (best effort). */
    async #notInstalled(error: GithubApiError, account: string): Promise<GithubNotInstalledError> {
        let id: number | null = null;
        try {
            const r = await this.#request('GET', `/users/${encodeURIComponent(account)}`);
            const raw = (r.json as { id?: unknown } | null)?.id;
            if (r.status === 200 && typeof raw === 'number') id = raw;
        } catch {
            // The plain chooser still lands on GitHub's account picker.
        }
        return new GithubNotInstalledError(account, githubInstallUrl(id), error.status, error.message);
    }

    /** The credential for a clone of `url`, when this sign-in can read it (core/github.ts cloneAuthFor). Main-side only. */
    cloneAuth(url: string): { config: Array<[string, string]>; secrets: string[] } | null {
        return this.#status === 'signed-in' ? cloneAuthFor(url, this.#token, this.#installations) : null;
    }

    /** The credential for a push to `url`, when the App may WRITE there (core/github.ts pushAuthFor). Main-side only. */
    pushAuth(url: string): { config: Array<[string, string]>; secrets: string[] } | null {
        return this.#status === 'signed-in' ? pushAuthFor(url, this.#token, this.#installations) : null;
    }
}
