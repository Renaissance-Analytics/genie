import { randomUUID } from 'node:crypto';
import { claudeAccounts, claudeSignInUrl, type ClaudeAccountOptions } from '@particle-academy/prism-acp';
import type { AccountIdentity, AccountRecord } from '../core/accounts.js';
import { forgetRefusal } from '../core/account-settings.js';
import { isClaudeSignInUrl, type ClaudeSignInView } from '../core/claude-accounts.js';
import type { CallContext } from '../core/remote-protocol.js';

/**
 * EVERY CLAUDE SIGN-IN IN THE BROWSER, NEVER A TERMINAL (Tynn #1011; the owner: "I should not see any terminals nor do we
 * store login keys"). prism-acp's `claudeAccounts.login(configDir, { method, email, onUrl, onCodeRequested, signal })` runs
 * Claude Code's own sign-in as a hidden process for one account folder; Genie opens the page it names in the person's browser
 * (only an https URL on Anthropic's sign-in hosts), shows a code field ONLY if the CLI asks for a pasted code, and hands that
 * code straight back, keeping it nowhere. Sign out is prism-acp's `logout(configDir)`.
 *
 * prism-acp's login() refuses the CLI's default folder, so every sign-in Genie runs is in a folder Genie made: an account of
 * its own is signed in where it is; a default-home account, or "Use another account", gets a new folder first (the email
 * prefilled when known), and becomes the active account once signed in.
 *
 * ONE sign-in per folder at a time (prism-acp's limit): a second click joins it, and `busy(dir)` tells the book and the
 * launcher to prepare and launch nothing there meanwhile. macOS is not supported by prism-acp's login.
 */
export interface ClaudeLoginOptions {
    readonly method?: 'subscription' | 'console';
    readonly email?: string;
    readonly onUrl: (url: string) => void;
    readonly onCodeRequested?: (signal: AbortSignal) => Promise<string>;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}

export interface ClaudeSignInPorts {
    readonly get: (id: string) => AccountRecord | null;
    readonly activeId: () => string;
    readonly addClaude: (input: { method: 'subscription' | 'console'; label?: string }) => Promise<AccountRecord>;
    readonly setActive: (id: string) => Promise<void>;
    /** A sign-in made an account the active one: the agents move to it and are told their new room. */
    readonly activated: (provider: string, id: string) => void;
    readonly recordIdentity: (id: string, identity: AccountIdentity) => Promise<void>;
    readonly forget: (id: string) => Promise<void>;
    readonly removeDir: (configDir: string) => { ok: true } | { ok: false; reason: string };
    /** Open a URL in the person's browser, on the machine of the window that asked (or this machine's). */
    readonly open: (url: string, context: CallContext | undefined) => Promise<void>;
    readonly changed: () => void;
    readonly tell: (words: string) => void;
    readonly platform: NodeJS.Platform;
    readonly login: (configDir: string, options: ClaudeLoginOptions) => Promise<{ readonly signedIn: boolean; readonly email?: string; readonly subscriptionType?: string }>;
    readonly logout: (configDir: string, options?: { signal?: AbortSignal }) => Promise<void>;
    readonly describe: (configDir: string) => Promise<{ readonly signedIn: boolean }>;
}

interface Running {
    readonly accountId: string;
    readonly label: string;
    readonly configDir: string;
    readonly abort: AbortController;
    code: { requestId: string; resolve: (code: string) => void; reject: (e: unknown) => void } | null;
}

type Result = { ok: true } | { ok: false; reason: string };
const MACOS = 'Signing in from Genie is not supported on macOS yet.';

export class ClaudeSignIns {
    readonly #p: ClaudeSignInPorts;
    readonly #running = new Map<string, Running>();

    constructor(ports: ClaudeSignInPorts) { this.#p = ports; }

    /** What windows show: each sign-in in the browser, and whether the CLI asked for a code. Never the code. */
    view(): ClaudeSignInView[] {
        return [...this.#running.values()].map((r) => ({ accountId: r.accountId, label: r.label, state: r.code ? 'code' : 'browser', ...(r.code ? { requestId: r.code.requestId } : {}) }));
    }

    /** A folder a sign-in is running in: nothing is prepared or launched there meanwhile. */
    busy(configDir: string): boolean {
        return [...this.#running.values()].some((r) => r.configDir === configDir);
    }

    /**
     * Sign an account in. An account of its own signs in where it is; one in the default home is signed in in a new folder of
     * its own (its email prefilled) and, once in, takes that entry's place and becomes active.
     */
    async signIn(id: string, context?: CallContext, how: { readonly activate?: boolean } = {}): Promise<Result> {
        if (this.#p.platform === 'darwin') return { ok: false, reason: MACOS };
        const account = this.#p.get(id);
        if (!account || account.provider !== 'claude') return { ok: false, reason: 'Genie does not know that account.' };
        if (account.configDir !== undefined) return this.#start(account, context, { activate: how.activate === true });
        const fresh = await this.#p.addClaude({ method: 'subscription', label: account.label });
        return this.#start(fresh, context, { activate: true, email: account.identity.email ?? undefined, replaces: account.id });
    }

    /** "Use another account": a new folder, signed in in the browser, active once it is. */
    async useAnother(method: 'subscription' | 'console', context?: CallContext): Promise<Result> {
        if (this.#p.platform === 'darwin') return { ok: false, reason: MACOS };
        const fresh = await this.#p.addClaude({ method });
        return this.#start(fresh, context, { activate: true });
    }

    cancel(id: string): boolean {
        const r = this.#running.get(id);
        if (!r) return false;
        r.abort.abort();
        r.code?.reject(new Error('cancelled'));
        return true;
    }

    /** The code the CLI asked for, straight to it. `false`: nothing asked for one under that id (or it was already sent). */
    submitCode(requestId: string, code: string): boolean {
        for (const r of this.#running.values()) {
            if (r.code?.requestId !== requestId) continue;
            const { resolve } = r.code;
            r.code = null;
            this.#p.changed();
            resolve(code);
            return true;
        }
        return false;
    }

    async #start(account: AccountRecord, context: CallContext | undefined, how: { activate: boolean; email?: string | undefined; replaces?: string }): Promise<Result> {
        if (account.configDir === undefined) return { ok: false, reason: 'That account has no folder of its own.' };
        if (this.#running.has(account.id)) return { ok: true };
        const configDir = account.configDir;
        const running: Running = { accountId: account.id, label: account.label, configDir, abort: new AbortController(), code: null };
        this.#running.set(account.id, running);
        this.#p.changed();
        const email = how.email ?? account.identity.email ?? undefined;
        const options: ClaudeLoginOptions = {
            ...(account.method ? { method: account.method } : {}),
            ...(email ? { email } : {}),
            signal: running.abort.signal,
            onUrl: (url) => {
                // Only Anthropic's own sign-in page: prism-acp's own check and Genie's; nothing else is ever opened.
                if (claudeSignInUrl(url) === null || !isClaudeSignInUrl(url)) return;
                void this.#p.open(url, context).catch(() => { this.#p.tell(`Genie could not open your browser for ${account.label}. Cancel and try again.`); });
            },
            onCodeRequested: (signal) => new Promise<string>((resolve, reject) => {
                const requestId = randomUUID();
                running.code = { requestId, resolve, reject };
                signal.addEventListener('abort', () => { if (running.code?.requestId === requestId) { running.code = null; reject(new Error('cancelled')); } }, { once: true });
                this.#p.changed();
            }),
        };
        void this.#p.login(configDir, options).then(
            async (status) => {
                if (!status.signedIn) { this.#p.tell(`${account.label} is not signed in. Sign in again when you are ready.`); return; }
                if (status.email) await this.#p.recordIdentity(account.id, { name: null, email: status.email, plan: status.subscriptionType ?? null });
                if (how.activate) {
                    await this.#p.setActive(account.id);
                    if (how.replaces) await this.#p.forget(how.replaces).catch(() => undefined);
                    this.#p.activated('claude', account.id);
                }
                this.#p.tell(`${account.label} is signed in.`);
            },
            (error: unknown) => {
                const code = (error as { code?: unknown } | null)?.code;
                this.#p.tell(code === 'aborted' || code === 'cancelled' || running.abort.signal.aborted ? `Signing in to ${account.label} was cancelled.`
                    : code === 'timeout' ? `Signing in to ${account.label} took too long and was stopped. Sign in again when you are ready.`
                    : `Signing in to ${account.label} did not finish: ${error instanceof Error ? error.message : String(error)}`);
            },
        ).finally(() => { this.#running.delete(account.id); this.#p.changed(); });
        return { ok: true };
    }

    /** prism-acp logout() for that folder; then, only if Claude Code says it is signed out, the account and its folder go. */
    async signOut(id: string): Promise<Result> {
        if (this.#p.platform === 'darwin') return { ok: false, reason: MACOS };
        const account = this.#p.get(id);
        if (!account || account.provider !== 'claude') return { ok: false, reason: 'Genie does not know that account.' };
        if (account.configDir === undefined) return { ok: false, reason: `${account.label} has no folder of its own. Forget it here; sign it out in Claude Code.` };
        const refused = forgetRefusal({ label: account.label, active: this.#p.activeId() === id });
        if (refused) return { ok: false, reason: refused };
        if (this.busy(account.configDir)) return { ok: false, reason: `${account.label} is signing in right now. Cancel that first.` };
        try { await this.#p.logout(account.configDir); } catch (error) { return { ok: false, reason: `Signing ${account.label} out did not finish: ${error instanceof Error ? error.message : String(error)}` }; }
        let signedIn = true;
        try { signedIn = (await this.#p.describe(account.configDir)).signedIn; } catch { /* unknown: kept */ }
        if (signedIn) { this.#p.tell(`${account.label} is still signed in, so Genie kept it.`); return { ok: true }; }
        await this.#p.forget(id);
        const removed = this.#p.removeDir(account.configDir);
        this.#p.changed();
        this.#p.tell(removed.ok ? `${account.label} is signed out and removed. Your conversations are kept.` : `${account.label} is signed out and removed from Genie. ${removed.reason}`);
        return { ok: true };
    }
}

/** The CLI a sign-in runs: the one Genie launches for Claude (a configured binary included), as `describe` uses it. */
export type ClaudeCliOptions = Pick<ClaudeAccountOptions, 'binary' | 'binaryArgs' | 'parentEnv' | 'allowEnv'>;

/** prism-acp 0.47.0's `claudeAccounts.login()` / `logout()`: Claude Code's own sign-in and sign-out, hidden, no terminal. */
export function realClaudeLogin(cli: () => ClaudeCliOptions): Pick<ClaudeSignInPorts, 'login' | 'logout'> {
    return {
        login: (configDir, options) => claudeAccounts.login(configDir, { ...cli(), ...options }),
        logout: async (configDir, options) => { await claudeAccounts.logout(configDir, { ...cli(), ...(options?.signal ? { signal: options.signal } : {}) }); },
    };
}
