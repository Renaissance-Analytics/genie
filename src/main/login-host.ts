import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DESIGN_LOGIN } from '../core/design-login.js';
import { providerLogin } from '../core/provider-login.js';
import type { TerminalHost } from './terminal-host.js';

/**
 * THE LOGIN WINDOW (the owner, 2026-10-18: "it should open this in a throwaway window that auto loads the tui in a scratch
 * folder and then prompts the login command if possible. if not, make sure the window … includes a loud notice that
 * tells the user what to do").
 *
 * `start(provider)` makes a fresh scratch folder under the caller's scratch (`<root>/cache/tmp/<this process>`, P7), runs the provider's own login there
 * (`core/provider-login.ts`) — or, for a provider Genie has no login for, its own CLI — and opens it in a window of its own
 * (`genie://takeover/<id>?login=<provider>`), whose notice says what to do. One login per provider: a second click brings
 * the same window back.
 *
 * When that terminal ends, the provider's status command is asked (exit 0 = signed in) in the same folder; signed in,
 * `onSignedIn` brings the provider's signed-out agents back. The scratch folder is removed either way — it is the one
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
export function afterSignedIn(provider: string, deps: { signedOutAgents: (provider: string) => readonly string[]; restart: (id: string) => void; resumeLimit: (provider: string) => void }): void {
    for (const id of deps.signedOutAgents(provider)) deps.restart(id);
    deps.resumeLimit(provider);
}

export interface LoginHostOptions {
    terminals: Pick<TerminalHost, 'open' | 'onExit'>;
    openWindow: (route: string) => void;
    /** Run a status command in `cwd` through the shell; resolves with its exit code. */
    runStatus: (command: string, cwd: string) => Promise<number>;
    onSignedIn: (provider: string) => void;
    /** The Claude Design login window ended (there is no status to ask): the agents that waited are told to retry. */
    onDesignLoginEnded?: (() => void) | undefined;
    /** The provider CLI's resolved path, when it is not simply on PATH (`providerBinary`). */
    binaryFor?: ((provider: string) => string | null) | undefined;
    /** The workspace a login terminal belongs to: Genie's own, not a project's. */
    workspaceId?: string | undefined;
    /** The folder a login's throwaway folder is made in: this process's scratch under Genie's root (scratch-area.ts), never the OS temp. */
    scratch: () => string;
}

interface Live {
    provider: string;
    terminalId: string;
    scratch: string;
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
            for (const [provider, live] of this.#live) {
                if (live.terminalId !== id) continue;
                this.#live.delete(provider);
                void this.#finish(live);
            }
        });
    }

    start(provider: string): { ok: true; terminalId: string } | { ok: false; reason: string } {
        const existing = this.#live.get(provider);
        if (existing) {
            this.#options.openWindow(this.#route(existing));
            return { ok: true, terminalId: existing.terminalId };
        }
        const design = provider === DESIGN_LOGIN;
        const known = design ? null : providerLogin(provider);
        if (!design && !PLAIN_NAME.test(provider)) return { ok: false, reason: 'That provider’s login could not start: its name is not one Genie can run.' };
        // Claude Design's login runs in Claude Code's own CLI.
        const cli = design ? 'claude' : provider;
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
        const live: Live = { provider, terminalId: opened.id, scratch };
        this.#live.set(provider, live);
        this.#options.openWindow(this.#route(live));
        return { ok: true, terminalId: opened.id };
    }

    #route(live: Live): string {
        return `genie://takeover/${live.terminalId}?login=${encodeURIComponent(live.provider)}`;
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
                if (code === 0) this.#options.onSignedIn(live.provider);
            }
        } finally {
            rmSync(live.scratch, { recursive: true, force: true });
        }
    }
}
