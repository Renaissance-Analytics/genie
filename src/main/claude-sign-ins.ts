import { randomUUID } from 'node:crypto';
import { claudeAccounts, claudeSignInUrl, type ClaudeAccountOptions } from '@particle-academy/prism-acp';
import type { AccountIdentity, AccountRecord } from '../core/accounts.js';
import { forgetRefusal } from '../core/account-settings.js';
import { claudeEmailHint, isClaudeSignInUrl, type ClaudeSignInView } from '../core/claude-accounts.js';
import type { CallContext } from '../core/remote-protocol.js';
import { afterSignedIn } from './login-host.js';

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
 * ONE SIGN-IN PER INTENT (the review of #2139): "sign this account in" and "use another account" are each one thing in
 * flight, reserved before anything is awaited, so a second click joins it instead of adding a second account, folder, CLI
 * and browser tab. An account ADDED for a sign-in that does not end signed in is taken away again with its folder.
 * `busy(dir)` tells the launcher to launch nothing in a folder while its sign-in runs; when it ends, however it ends,
 * `ended(dir)` lets what waited on it go. macOS is not supported by prism-acp's login.
 */
export interface ClaudeLoginOptions {
    readonly method?: 'subscription' | 'console';
    readonly email?: string;
    readonly onUrl: (url: string) => void;
    readonly onCodeRequested?: (signal: AbortSignal) => Promise<string>;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}

/** A folder removed, or why not. `partial`: the removal was started and did not finish, so the same step can finish it later. */
export type RemovedDir = { ok: true } | { ok: false; reason: string; partial?: boolean };

export interface ClaudeSignInPorts {
    readonly get: (id: string) => AccountRecord | null;
    readonly activeId: () => string;
    readonly addClaude: (input: { method: 'subscription' | 'console'; label?: string }) => Promise<AccountRecord>;
    readonly setActive: (id: string) => Promise<void>;
    /** An account became the active one: the agents move to it and are told their new room. */
    readonly activated: (provider: string, id: string) => void;
    readonly recordIdentity: (id: string, identity: AccountIdentity) => Promise<void>;
    readonly forget: (id: string) => Promise<void>;
    readonly removeDir: (configDir: string) => RemovedDir;
    /** Open a URL in the person's browser, on the machine of the window that asked (or this machine's). */
    readonly open: (url: string, context: CallContext | undefined) => Promise<void>;
    readonly changed: () => void;
    readonly tell: (words: string) => void;
    readonly platform: NodeJS.Platform;
    readonly login: (configDir: string, options: ClaudeLoginOptions) => Promise<{ readonly signedIn: boolean; readonly email?: string; readonly subscriptionType?: string }>;
    readonly logout: (configDir: string, options?: { signal?: AbortSignal }) => Promise<void>;
    readonly describe: (configDir: string) => Promise<{ readonly signedIn: boolean }>;
    /** How many agent runs are in that folder now (one still stopping included): a folder is never removed under one. */
    readonly inUse: (configDir: string) => number;
    /** Whether Claude Code says that account is signed in now; `null` when it could not be asked. */
    readonly signedInNow: (account: AccountRecord) => Promise<boolean | null>;
    /** Make the folder ready again (its history the shared one) before a sign-in runs in it. Throws, in words, when it cannot. */
    readonly prepare: (configDir: string) => void;
    /** A sign-in in that folder is over, however it ended, and the folder is free: what waited on it may go. */
    readonly ended: (configDir: string) => void;
    /** The ACTIVE account has just been signed in: health and attribution are read again, its signed-out agents come back. */
    readonly signedInActive: (provider: string, id: string) => void;
}

interface Running {
    readonly accountId: string;
    readonly label: string;
    readonly configDir: string;
    readonly abort: AbortController;
    readonly intent: string;
    /** Whether it becomes the active account once signed in. A later click that asks for it turns it on. */
    activate: boolean;
    /** Set when the sign-in ended with the ACTIVE account signed in: told once the folder is free again. */
    signedInActive: boolean;
    code: { requestId: string; resolve: (code: string) => void; reject: (e: unknown) => void } | null;
}

interface How {
    readonly activate: boolean;
    readonly intent: string;
    readonly email?: string | undefined;
    /** The default-home entry this account takes the place of, once signed in. */
    readonly replaces?: string;
    /** The account was added for this sign-in: if it does not end signed in, it goes again with its folder. */
    readonly created?: boolean;
}

type Result = { ok: true } | { ok: false; reason: string };
const MACOS = 'Signing in from Genie is not supported on macOS yet.';
const words = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** How many agents are in an account's folder, in the words Sign out and remove refuses with. */
export function inUseWords(count: number): string {
    return count === 1
        ? '1 agent is still using this account; it can be removed when it finishes its turn.'
        : `${count} agents are still using this account; it can be removed when they finish their turn.`;
}

/**
 * THE CLAUDE ACCOUNT SOME WORDS NAME (its email, else its label), for a caller that has no id. One match is that account;
 * `'several'` when more than one answers to them (two accounts may share an email: the default-home one and one with a
 * folder of its own), which is said, never resolved to whichever comes first; `null` for none.
 */
export function claudeAccountNamed(accounts: readonly AccountRecord[], named: string): AccountRecord | 'several' | null {
    const wanted = named.toLowerCase();
    const matches = accounts.filter((a) => a.provider === 'claude' && (a.identity.email?.toLowerCase() === wanted || a.label === named));
    return matches.length === 0 ? null : matches.length === 1 ? matches[0]! : 'several';
}

/**
 * THE ACTIVE CLAUDE ACCOUNT HAS JUST BEEN SIGNED IN, IN THE BROWSER (the review of #2139). What the terminal login did when
 * it ended signed in: whose readings they are is read again, the provider's health is read again, and the agents the
 * provider had signed out are started again with that account's limit hold opened (`afterSignedIn`), so no agent sits
 * waiting on the person once the cause is gone. Only those agents: one stopped for another reason is not in that list.
 */
export function claudeSignedInActive(deps: {
    readonly attribution: (provider: string) => void;
    readonly refreshHealth: (provider: string) => void;
    readonly refreshLive: () => void;
    readonly signedOutAgents: (provider: string, accountId?: string) => readonly string[];
    readonly restart: (id: string) => void;
    readonly resumeLimit: (provider: string, accountId?: string) => void;
}): (provider: string, id: string) => void {
    return (provider, id) => {
        deps.attribution(provider);
        deps.refreshHealth(provider);
        deps.refreshLive();
        afterSignedIn(provider, deps, id);
    };
}

export class ClaudeSignIns {
    readonly #p: ClaudeSignInPorts;
    readonly #running = new Map<string, Running>();
    /** Each intent being started or running, by its key: the answer every click on it gets. */
    readonly #intents = new Map<string, Promise<Result>>();

    constructor(ports: ClaudeSignInPorts) { this.#p = ports; }

    /** What windows show: each sign-in in the browser, and whether the CLI asked for a code. Never the code. */
    view(): ClaudeSignInView[] {
        return [...this.#running.values()].map((r) => ({ accountId: r.accountId, label: r.label, state: r.code ? 'code' : 'browser', ...(r.code ? { requestId: r.code.requestId } : {}) }));
    }

    /** A folder a sign-in is running in: nothing is launched there meanwhile. */
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
        // A click that asks for it to become active, on one already signing in, is heard.
        const flying = this.#running.get(id);
        if (flying && how.activate === true) flying.activate = true;
        return this.#once(`account:${id}`, async (intent) => {
            if (account.configDir !== undefined) return this.#start(account, context, { activate: how.activate === true, intent });
            const fresh = await this.#p.addClaude({ method: 'subscription', label: account.label });
            return this.#start(fresh, context, { activate: true, intent, email: account.identity.email ?? undefined, replaces: account.id, created: true });
        });
    }

    /** "Use another account": a new folder, signed in in the browser, active once it is. */
    async useAnother(method: 'subscription' | 'console', context?: CallContext): Promise<Result> {
        if (this.#p.platform === 'darwin') return { ok: false, reason: MACOS };
        return this.#once(`another:${method}`, async (intent) => {
            const fresh = await this.#p.addClaude({ method });
            return this.#start(fresh, context, { activate: true, intent, created: true });
        });
    }

    /**
     * SWITCH TO AN ACCOUNT, BY ITS ID (the review of #2139). Claude Code is asked whether THAT account is signed in: one that
     * is becomes the active account, with no login and no new folder; one that is not is signed in in the browser and is
     * active once it is. When Claude Code cannot be asked nothing is guessed: it is said, and nothing changes.
     */
    async switchTo(id: string, context?: CallContext): Promise<Result> {
        if (this.#p.platform === 'darwin') return { ok: false, reason: MACOS };
        const account = this.#p.get(id);
        if (!account || account.provider !== 'claude') return { ok: false, reason: 'Genie does not know that account.' };
        if (this.#p.activeId() === id) return { ok: true };
        // Already signing in: this click joins it, and it is active once it is in.
        if (this.#running.has(id) || this.#intents.has(`account:${id}`)) return this.signIn(id, context, { activate: true });
        let signedIn: boolean | null;
        try { signedIn = await this.#p.signedInNow(account); } catch { signedIn = null; }
        if (signedIn === null) return { ok: false, reason: `Genie could not ask Claude Code whether ${account.label} is signed in. Try again in a moment.` };
        if (!signedIn) return this.signIn(id, context, { activate: true });
        try { await this.#p.setActive(id); } catch (error) { return { ok: false, reason: words(error) }; }
        this.#p.activated('claude', id);
        return { ok: true };
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

    /**
     * ONE OF EACH INTENT AT A TIME. The key is taken BEFORE anything is awaited (an account is added with an await), so two
     * clicks in the same moment are one sign-in; it is given back when the sign-in ends, or at once when it could not start.
     */
    #once(intent: string, run: (intent: string) => Promise<Result>): Promise<Result> {
        const flying = this.#intents.get(intent);
        if (flying) return flying;
        const started = (async (): Promise<Result> => {
            let result: Result;
            try { result = await run(intent); } catch (error) { result = { ok: false, reason: words(error) }; }
            if (!result.ok) this.#intents.delete(intent);
            return result;
        })();
        this.#intents.set(intent, started);
        return started;
    }

    #start(account: AccountRecord, context: CallContext | undefined, how: How): Result {
        if (account.configDir === undefined) return { ok: false, reason: 'That account has no folder of its own.' };
        const flying = this.#running.get(account.id);
        if (flying) { if (how.activate) flying.activate = true; return { ok: true }; }
        const configDir = account.configDir;
        // Its history is made the shared one again first: a removal that stopped half-way may have left the folder without it.
        try { this.#p.prepare(configDir); } catch (error) {
            if (how.created) void this.#discard(account);
            return { ok: false, reason: words(error) };
        }
        const running: Running = { accountId: account.id, label: account.label, configDir, abort: new AbortController(), intent: how.intent, activate: how.activate, signedInActive: false, code: null };
        this.#running.set(account.id, running);
        this.#p.changed();
        // Only an email prism-acp will take as the hint; any other and the sign-in runs without one.
        const email = claudeEmailHint(how.email ?? account.identity.email);
        const options: ClaudeLoginOptions = {
            ...(account.method ? { method: account.method } : {}),
            ...(email !== undefined ? { email } : {}),
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
        void this.#p.login(configDir, options)
            .then((status) => this.#finished(running, account, how, status), (error: unknown) => this.#failed(running, account, how, error))
            // Nothing after a sign-in may end as a silent rejection: whatever went wrong is said.
            .catch((error: unknown) => { this.#say(`Signing in to ${account.label} ended, but Genie could not finish what follows it: ${words(error)}`); })
            .finally(() => {
                this.#running.delete(account.id);
                this.#intents.delete(how.intent);
                this.#quietly(() => this.#p.changed());
                // The folder is free now: a launch this sign-in refused, or a move that waited on it, goes.
                this.#quietly(() => this.#p.ended(configDir));
                // Only now, with the folder free: the agents it had signed out start in it, and a start is refused while it is busy.
                if (running.signedInActive) this.#quietly(() => this.#p.signedInActive('claude', account.id));
            });
        return { ok: true };
    }

    async #finished(running: Running, account: AccountRecord, how: How, status: { readonly signedIn: boolean; readonly email?: string; readonly subscriptionType?: string }): Promise<void> {
        if (!status.signedIn) {
            const kept = how.created ? await this.#discard(account) : null;
            this.#say(`${account.label} is not signed in. Sign in again when you are ready.${kept ? ` ${kept}` : ''}`);
            return;
        }
        // Who it is. A book that cannot be written now does not undo the sign-in: the next read of its state records it.
        if (status.email) await this.#p.recordIdentity(account.id, { name: null, email: status.email, plan: status.subscriptionType ?? null }).catch(() => undefined);
        if (running.activate) {
            try { await this.#p.setActive(account.id); } catch (error) {
                // Signed in and in the book, the active account unchanged: consistent, and said.
                this.#say(`${account.label} is signed in, but Genie could not make it the active account: ${words(error)}. Switch to it from the account menu.`);
                return;
            }
            if (how.replaces) await this.#p.forget(how.replaces).catch(() => undefined);
            this.#quietly(() => this.#p.activated('claude', account.id));
        }
        // The account every agent runs on is signed in now, whether it was switched to or signed ITSELF in again.
        if (this.#p.activeId() === account.id) running.signedInActive = true;
        this.#say(`${account.label} is signed in.`);
    }

    async #failed(running: Running, account: AccountRecord, how: How, error: unknown): Promise<void> {
        const code = (error as { code?: unknown } | null)?.code;
        const kept = how.created ? await this.#discard(account) : null;
        const said = code === 'aborted' || code === 'cancelled' || running.abort.signal.aborted ? `Signing in to ${account.label} was cancelled.`
            : code === 'timeout' ? `Signing in to ${account.label} took too long and was stopped. Sign in again when you are ready.`
            : `Signing in to ${account.label} did not finish: ${words(error)}`;
        this.#say(`${said}${kept ? ` ${kept}` : ''}`);
    }

    /**
     * An account added for a sign-in that did not end signed in goes again: its folder first, and the account only once the
     * folder is gone, so one that will not go is still in the book where "Sign out and remove" can finish it. Returns what to
     * say when something was kept, `null` when all of it went.
     */
    async #discard(account: AccountRecord): Promise<string | null> {
        if (account.configDir === undefined) return null;
        let removed: RemovedDir;
        try { removed = this.#p.removeDir(account.configDir); } catch (error) { removed = { ok: false, reason: words(error), partial: true }; }
        if (!removed.ok) return `The account made for it is still listed: ${removed.reason}`;
        try { await this.#p.forget(account.id); } catch (error) { return `The account made for it is still listed: ${words(error)}`; }
        return null;
    }

    #say(text: string): void { this.#quietly(() => this.#p.tell(text)); }
    #quietly(run: () => void): void { try { run(); } catch { /* a listener's own failure never undoes a sign-in */ } }

    /**
     * SIGN OUT AND REMOVE: prism-acp logout() for that folder; then, only if Claude Code says it is signed out, its folder goes,
     * and only once the folder is gone is the account forgotten. Never under a running agent: after a switch an agent is still
     * mid-turn in the old account's folder until its turn ends, so the folder is refused while any run is in it.
     */
    async signOut(id: string): Promise<Result> {
        if (this.#p.platform === 'darwin') return { ok: false, reason: MACOS };
        const account = this.#p.get(id);
        if (!account || account.provider !== 'claude') return { ok: false, reason: 'Genie does not know that account.' };
        if (account.configDir === undefined) return { ok: false, reason: `${account.label} has no folder of its own. Forget it here; sign it out in Claude Code.` };
        const configDir = account.configDir;
        const refused = forgetRefusal({ label: account.label, active: this.#p.activeId() === id });
        if (refused) return { ok: false, reason: refused };
        if (this.busy(configDir)) return { ok: false, reason: `${account.label} is signing in right now. Cancel that first.` };
        const using = this.#p.inUse(configDir);
        if (using > 0) return { ok: false, reason: inUseWords(using) };
        let gone = false;
        try { await this.#p.logout(configDir); } catch (error) {
            // A folder that is not there holds no sign-in: what is left is to forget the account (a removal finished elsewhere).
            if ((error as { code?: unknown } | null)?.code === 'missingDirectory') gone = true;
            else return { ok: false, reason: `Signing ${account.label} out did not finish: ${words(error)}` };
        }
        if (!gone) {
            let signedIn: boolean;
            try { signedIn = (await this.#p.describe(configDir)).signedIn; } catch {
                this.#p.tell(`${account.label} was signed out, but Genie could not confirm it with Claude Code, so it is kept for now. Use Sign out and remove again to finish.`);
                return { ok: true };
            }
            if (signedIn) { this.#p.tell(`${account.label} is still signed in, so Genie kept it.`); return { ok: true }; }
        }
        // Asked again after the waits above: a run that came into the folder meanwhile keeps it.
        const now = this.#p.inUse(configDir);
        if (now > 0) return { ok: false, reason: inUseWords(now) };
        const removed = this.#p.removeDir(configDir);
        if (!removed.ok && removed.partial === true) {
            this.#p.changed();
            this.#p.tell(`${account.label} is signed out, but its folder is not gone yet. ${removed.reason} Use Sign out and remove again to finish.`);
            return { ok: true };
        }
        await this.#p.forget(id);
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
