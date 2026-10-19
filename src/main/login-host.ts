import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerLogin } from '../core/provider-login.js';
import type { TerminalHost } from './terminal-host.js';

/**
 * THE LOGIN WINDOW (the owner, 2026-10-18: "it should open this in a throwaway window that auto loads the tui in a scratch
 * folder and then prompts the login command if possible. if not, make sure the window … includes a loud notice that
 * tells the user what to do").
 *
 * `start(provider)` makes a fresh scratch folder under the OS temp directory, runs the provider's own login there
 * (`core/provider-login.ts`) — or, for a provider Genie has no login for, its own CLI — and opens it in a window of its own
 * (`genie://takeover/<id>?login=<provider>`), whose notice says what to do. One login per provider: a second click brings
 * the same window back.
 *
 * When that terminal ends, the provider's status command is asked (exit 0 = signed in) in the same folder; signed in,
 * `onSignedIn` brings the provider's signed-out agents back. The scratch folder is removed either way — it is the one
 * path this host created, removed by that exact path.
 */
export interface LoginHostOptions {
    terminals: Pick<TerminalHost, 'open' | 'onExit'>;
    openWindow: (route: string) => void;
    /** Run a status command in `cwd` through the shell; resolves with its exit code. */
    runStatus: (command: string, cwd: string) => Promise<number>;
    onSignedIn: (provider: string) => void;
    /** The provider CLI's resolved path, when it is not simply on PATH (`providerBinary`). */
    binaryFor?: ((provider: string) => string | null) | undefined;
    /** The workspace a login terminal belongs to: Genie's own, not a project's. */
    workspaceId?: string | undefined;
}

interface Live {
    provider: string;
    terminalId: string;
    scratch: string;
}

const OS_WORKSPACE = '__genie__';

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
        const known = providerLogin(provider);
        const binary = this.#options.binaryFor?.(provider) ?? null;
        const program = binary === null ? provider : `"${binary}"`;
        // The provider's documented login, its first word the resolved CLI; with none known, the CLI itself.
        const command = known ? `${program}${known.login.slice(known.login.indexOf(' '))}` : program;
        const scratch = mkdtempSync(join(tmpdir(), `genie-login-${provider}-`));
        let opened: { id: string };
        try {
            opened = this.#options.terminals.open({ workspaceId: this.#options.workspaceId ?? OS_WORKSPACE, cwd: scratch, command, shell: true });
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
