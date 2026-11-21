import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DESIGN_LOGIN } from '../core/design-login.js';
import { type ProviderAccountHome } from '../core/accounts.js';
import { providerLogin } from '../core/provider-login.js';
import type { TerminalHost } from './terminal-host.js';

/**
 * THE LOGIN WINDOW (the owner, 2026-10-18: "it should open this in a throwaway window that auto loads the tui in a scratch
 * folder and then prompts the login command if possible. if not, make sure the window … includes a loud notice that
 * tells the user what to do").
 *
 * `start(provider)` makes a fresh scratch folder under the caller's scratch (`<root>/cache/tmp/<this process>`, P7), runs the provider's own login there
 * (`core/provider-login.ts`) — or, for a provider Genie has no login for, its own CLI — and opens it in a window of its own
 * (`genie://takeover/<id>?login=<provider>`), whose notice says what to do. One login per ACCOUNT (Tynn #479): a second click on
 * the same account brings the same window back, and another account of the provider signs in beside it. It runs in genie-host;
 * a window only shows the terminal. The terminal is killed and removed, and the folder deleted, on every way the step ends:
 * the status answered, the status failed, `cancel`, or `dispose` (Genie 1's wizard did the same on close, cancel or finish).
 *
 * When that terminal ends, the provider's status command is asked (exit 0 = signed in) in the same folder; signed in,
 * `onSignedIn` brings THAT ACCOUNT's signed-out agents back. The scratch folder is removed either way — it is the one
 * path this host created, removed by that exact path.
 *
 * CLAUDE DESIGN (#1081): `start(DESIGN_LOGIN)` opens the interactive `claude` itself — no arguments; `/design-login` as an
 * argument is undocumented, and Genie has no tested way to type into a terminal once it is ready — so the window's notice
 * says to type it. It has no status command: when that terminal ends, `onDesignLoginEnded` tells the agents that waited
 * to retry, and a retry refused again raises the prompt again.
 */
/**
 * SIGNED IN THROUGH GENIE: the agents the provider signed out are restarted, and — the account may be another one now (Tynn
 * #699: the owner switched accounts at his limit and his agent never resumed) — every agent held on that provider's limit is
 * released and what waited goes, as when the limit resets.
 */
export function afterSignedIn(provider: string, deps: { signedOutAgents: (provider: string, accountId?: string) => readonly string[]; restart: (id: string) => void; resumeLimit: (provider: string, accountId?: string) => void }, accountId?: string): void {
    // One account's sign-in resumes that account's agents and that account's hold, never another account's (Tynn #479).
    for (const id of accountId === undefined ? deps.signedOutAgents(provider) : deps.signedOutAgents(provider, accountId)) deps.restart(id);
    if (accountId === undefined) deps.resumeLimit(provider);
    else deps.resumeLimit(provider, accountId);
}

/** The sign-in terminal a Take Over route shows, or `null` when the route is not a sign-in's. */
export function loginTerminalOf(route: string): string | null {
    const prefix = 'genie://takeover/';
    if (!route.startsWith(prefix)) return null;
    const [id, query] = route.slice(prefix.length).split('?');
    return id && query?.startsWith('login=') ? decodeURIComponent(id) : null;
}

/** The Take Over window's route for a sign-in terminal: the window only shows it (Tynn #479). */
export function loginRoute(terminalId: string, provider: string, switching = false, choose?: string): string {
    // A switch may name the account to choose (Tynn #483); the window's steps say it.
    const named = switching && choose ? `&choose=${encodeURIComponent(choose)}` : '';
    return `genie://takeover/${terminalId}?login=${encodeURIComponent(provider)}${switching ? '&switch=1' : ''}${named}`;
}

export interface LoginHostOptions {
    terminals: Pick<TerminalHost, 'open' | 'onExit' | 'close'>;
    openWindow: (route: string) => void;
    /** Run a status command in `cwd` through the shell, in the provider's normal home; resolves with its exit code. */
    runStatus: (command: string, cwd: string) => Promise<number>;
    /** The host book's account, to refuse a provider it does not know; it sets no environment (Tynn #753). */
    accountFor?: (provider: string, accountId?: string) => (ProviderAccountHome & { id?: string }) | null;
    onSignedIn: (provider: string, accountId?: string) => void;
    /** An account switch's login is over (Tynn #482): `signedIn` is the provider's status answer. Called once per switch. */
    onSwitchEnded?: ((provider: string, signedIn: boolean) => void) | undefined;
    /** The Claude Design login window ended (there is no status to ask): the agents that waited are told to retry. */
    onDesignLoginEnded?: (() => void) | undefined;
    /** The provider CLI's resolved path, when it is not simply on PATH (`providerBinary`). */
    binaryFor?: ((provider: string) => string | null) | undefined;
    /** The workspace a login terminal belongs to: Genie's own, not a project's. */
    workspaceId?: string | undefined;
    /** The folder a login's throwaway folder is made in: this process's scratch under Genie's root (scratch-area.ts), never the OS temp. */
    scratch: () => string;
    /** The environment a Claude account's own-directory sign-in is built from (prism-acp strips credentials from it). Default `process.env`. */
    parentEnv?: Readonly<Record<string, string | undefined>> | undefined;
}

interface Live {
    /** What the sign-in is keyed by: the ACCOUNT's id (or the Design key; or the provider when no book is composed). */
    key: string;
    provider: string;
    /** The account signed in to; `undefined` when no book is composed. */
    accountId?: string | undefined;
    terminalId: string;
    scratch: string;
    /** An account switch (Tynn #753): the provider's own login, in its one home, with the steps on screen. */
    switching?: boolean;
}

const OS_WORKSPACE = '__genie__';

/** An unknown provider's name IS the shell line, so it may only be a plain name. A record's provider is checked where it is written (isAcpProvider); this is the last place before a shell. */
const PLAIN_NAME = /^[A-Za-z0-9._-]+$/;
/** A resolved path goes inside double quotes in a shell line. These leave them, or are read inside them: a quote, a line break, cmd's %, a POSIX shell's $ and backtick, and a final backslash, which eats the closing quote. */
const quotable = (path: string): boolean => !/["\r\n%$`]/.test(path) && !path.endsWith('\\');

/**
 * A provider's status command as a shell line, its first word the resolved CLI when there is one; `null` for a provider
 * Genie has no status for, or a path Genie will not put in a command.
 */
export function statusCommandFor(provider: string, binary: string | null): string | null {
    const known = providerLogin(provider);
    if (!known) return null;
    if (binary === null) return known.status;
    if (!quotable(binary)) return null;
    return `"${binary}"${known.status.slice(known.status.indexOf(' '))}`;
}

export class LoginHost {
    readonly #options: LoginHostOptions;
    readonly #live = new Map<string, Live>();

    constructor(options: LoginHostOptions) {
        this.#options = options;
        options.terminals.onExit((id) => {
            for (const [key, live] of this.#live) {
                if (live.terminalId !== id) continue;
                this.#live.delete(key);
                void this.#finish(live);
            }
        });
    }

    start(provider: string, accountId?: string): { ok: true; terminalId: string } | { ok: false; reason: string } {
        const design = provider === DESIGN_LOGIN;
        const known = design ? null : providerLogin(provider);
        if (!design && !PLAIN_NAME.test(provider)) return { ok: false, reason: 'That provider’s login could not start: its name is not one Genie can run.' };
        // Claude Design's login runs in Claude Code's own CLI.
        const cli = design ? 'claude' : provider;
        let resolvedId: string | undefined;
        if (this.#options.accountFor) {
            const account = this.#options.accountFor(cli, design ? undefined : accountId);
            if (!account || account.provider !== cli) return { ok: false, reason: 'The provider account is unavailable; reconnect Genie’s host before logging in.' };
            resolvedId = account.id;
        }
        // One sign-in per ACCOUNT: two clicks on one account join it; another account of the provider gets its own (Tynn #479).
        const key = design ? DESIGN_LOGIN : resolvedId ?? provider;
        const existing = this.#live.get(key);
        if (existing) {
            this.#options.openWindow(this.#route(existing));
            return { ok: true, terminalId: existing.terminalId };
        }
        const binary = this.#options.binaryFor?.(cli) ?? null;
        if (binary !== null && !quotable(binary)) return { ok: false, reason: `The ${known?.name ?? provider} login could not start: the path set for it has a character Genie will not put in a command.` };
        const program = binary === null ? cli : `"${binary}"`;
        // The provider's documented login, its first word the resolved CLI; with none known (or Claude Design), the CLI itself.
        const command = known ? `${program}${known.login.slice(known.login.indexOf(' '))}` : program;
        let scratch: string;
        try {
            scratch = mkdtempSync(join(this.#options.scratch(), `genie-login-${provider}-`));
        } catch (error) {
            return { ok: false, reason: `The ${known?.name ?? provider} login could not start: its scratch folder could not be made (${(error as Error).message}).` };
        }
        let opened: { id: string };
        try {
            opened = this.#options.terminals.open({ workspaceId: this.#options.workspaceId ?? OS_WORKSPACE, cwd: scratch, command, shell: true, limited: false });
        } catch (error) {
            rmSync(scratch, { recursive: true, force: true });
            return { ok: false, reason: `The ${known?.name ?? provider} login could not start: ${(error as Error).message}` };
        }
        const live: Live = { key, provider, ...(resolvedId !== undefined ? { accountId: resolvedId } : {}), terminalId: opened.id, scratch };
        this.#live.set(key, live);
        this.#options.openWindow(this.#route(live));
        return { ok: true, terminalId: opened.id };
    }

    /**
     * SWITCH ACCOUNT (Tynn #753): the provider's OWN login, unmodified, in the provider's one normal home, so every agent keeps
     * its threads. Claude Code's interactive CLI opens (the person types `/logout`, then `/login`); Codex runs its own
     * `logout` then its own `login`. The window says what to do (`accountSwitchSteps`). Genie types nothing and sees no code
     * or token. When the terminal ends and the provider's status says signed in, `onSignedIn` re-reads who it is.
     */
    startSwitch(provider: string): { ok: true; terminalId: string } | { ok: false; reason: string } {
        const known = providerLogin(provider);
        if (!known || !PLAIN_NAME.test(provider)) return { ok: false, reason: `Genie has no account switch for the provider "${provider}".` };
        const key = `switch:${provider}`;
        const existing = this.#live.get(key);
        if (existing) {
            this.#options.openWindow(this.#route(existing));
            return { ok: true, terminalId: existing.terminalId };
        }
        const binary = this.#options.binaryFor?.(provider) ?? null;
        if (binary !== null && !quotable(binary)) return { ok: false, reason: `The ${known.name} switch could not start: the path set for it has a character Genie will not put in a command.` };
        const program = binary === null ? provider : `"${binary}"`;
        const command = provider === 'codex' ? `${program} logout && ${program} login` : program;
        let scratch: string;
        try {
            scratch = mkdtempSync(join(this.#options.scratch(), `genie-login-${provider}-`));
        } catch (error) {
            return { ok: false, reason: `The ${known.name} switch could not start: its scratch folder could not be made (${(error as Error).message}).` };
        }
        let opened: { id: string };
        try {
            opened = this.#options.terminals.open({ workspaceId: this.#options.workspaceId ?? OS_WORKSPACE, cwd: scratch, command, shell: true, limited: false });
        } catch (error) {
            rmSync(scratch, { recursive: true, force: true });
            return { ok: false, reason: `The ${known.name} switch could not start: ${(error as Error).message}` };
        }
        const live: Live = { key, provider, terminalId: opened.id, scratch, switching: true };
        this.#live.set(key, live);
        this.#options.openWindow(this.#route(live));
        return { ok: true, terminalId: opened.id };
    }

    /**
     * The person closed or cancelled the sign-in window: its terminal is killed and removed and its folder deleted. Nobody is
     * signed in and no agent moves, so the agent stays on its old account. A key that is not live is nothing to do.
     */
    cancel(key: string): void {
        // By the account's key, or — from a window that only knows the terminal it shows — by that terminal's id.
        const live = this.#live.get(key) ?? [...this.#live.values()].find((l) => l.terminalId === key);
        if (!live) return;
        this.#live.delete(live.key);
        // A SWITCH's window is closed when it is done (its steps say so, Tynn #482): that is its end, so the provider's status
        // is asked and the switch told, as when its terminal exits. The terminal and folder go either way.
        if (live.switching === true) { void this.#finish(live); return; }
        this.#release(live);
    }

    /** Genie's host is going: every sign-in still open is cancelled. */
    dispose(): void {
        // Released, never settled: a host that is going asks no provider anything (a switch's close would).
        for (const live of [...this.#live.values()]) { this.#live.delete(live.key); this.#release(live); }
    }

    /** The one place a sign-in's terminal and folder are removed, whichever way the step ended. */
    #release(live: Live): void {
        try { this.#options.terminals.close(live.terminalId); } catch { /* already gone */ }
        rmSync(live.scratch, { recursive: true, force: true });
    }

    #route(live: Live): string {
        return loginRoute(live.terminalId, live.provider, live.switching === true);
    }

    async #finish(live: Live): Promise<void> {
        try {
            if (live.provider === DESIGN_LOGIN) {
                this.#options.onDesignLoginEnded?.();
                return;
            }
            const known = providerLogin(live.provider);
            if (known) {
                const binary = this.#options.binaryFor?.(live.provider) ?? null;
                const status = binary === null ? known.status : `"${binary}"${known.status.slice(known.status.indexOf(' '))}`;
                const code = await this.#options.runStatus(status, live.scratch).catch(() => 1);
                if (code === 0) this.#options.onSignedIn(live.provider, live.accountId);
                if (live.switching === true) this.#options.onSwitchEnded?.(live.provider, code === 0);
            }
        } catch {
            // A failed hand-off is not a reason to leave a terminal behind; the step is over either way.
        } finally {
            this.#release(live);
        }
    }
}
