import { claudeAccounts, type ClaudeAccountSelection, type ClaudeAccountStatus } from '@particle-academy/prism-acp';
import type { AccountIdentity, AccountRecord } from '../core/accounts.js';
import { claudeLiveOf, type ClaudeAccountLive } from '../core/claude-accounts.js';

/**
 * EACH CLAUDE ACCOUNT'S LIVE STATE (Tynn #1011), asked of Claude Code itself with prism-acp's `describe` (`claude auth status
 * --json` in that directory, credentials withheld) and compared with what the person chose (`compare`: ready, signed out, or a
 * mismatch with typed differences). Nothing is read from a credential file; nothing the CLI said is parsed as text.
 *
 * An account with its own directory is described there. The default home is described once, and its status belongs only to the
 * default-home account whose email it reports: another default-home account is not signed in now, and is shown with no live
 * state rather than someone else's. A describe that fails says nothing.
 */
export interface ClaudeAccountsLivePorts {
    readonly accounts: () => readonly AccountRecord[];
    readonly describe: (configDir: string | null) => Promise<ClaudeAccountStatus>;
    /** The default account's directory as a launch uses it (`claudeLaunchConfigDir`): `null`, or Genie's own CLAUDE_CONFIG_DIR. */
    readonly defaultDir: () => string | null;
    /** Record what the CLI reported about who an account is (email, plan). */
    readonly recordIdentity: (id: string, identity: AccountIdentity) => Promise<void>;
    /** Something shown changed: windows re-read the accounts. */
    readonly changed: () => void;
}

const sameEmail = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * WHETHER CLAUDE CODE SAYS AN ACCOUNT IS SIGNED IN NOW, asked fresh for a Switch (the review of #2139): never the popover's
 * last view, which may be seconds old or not read yet. An account with a folder of its own is asked there. The default home
 * holds ONE sign-in: it is a default-home account's when it reports that account's email, or, for the account nobody has
 * named yet, when it is no other default-home account's (the rule the book uses for who signed in, `recordSignedIn`).
 * `null` when Claude Code could not be asked: the caller says so and guesses nothing.
 */
export async function claudeSignedInNow(account: AccountRecord, ports: Pick<ClaudeAccountsLivePorts, 'accounts' | 'defaultDir'> & { readonly describe: (configDir: string | null) => Promise<{ readonly signedIn: boolean; readonly email?: string | null }> }): Promise<boolean | null> {
    try {
        if (account.configDir !== undefined) return (await ports.describe(account.configDir)).signedIn;
        const status = await ports.describe(ports.defaultDir());
        if (!status.signedIn) return false;
        const home = ports.accounts().filter((a) => a.provider === 'claude' && a.configDir === undefined);
        const owner = home.find((a) => sameEmail(a.identity.email, status.email)) ?? home.find((a) => a.identity.email === null);
        return owner?.id === account.id;
    } catch {
        return null;
    }
}

export class ClaudeAccountsLive {
    readonly #p: ClaudeAccountsLivePorts;
    #view: Readonly<Record<string, ClaudeAccountLive>> = {};
    #running: Promise<void> | null = null;
    #at = 0;

    constructor(ports: ClaudeAccountsLivePorts) { this.#p = ports; }

    view(): Readonly<Record<string, ClaudeAccountLive>> { return this.#view; }

    /** The view now, and a refresh behind it when it is older than `maxAgeMs`: a window reading the accounts is when to ask again. */
    current(maxAgeMs: number): Readonly<Record<string, ClaudeAccountLive>> {
        this.refreshIfOlder(maxAgeMs);
        return this.#view;
    }

    /** Refresh when the last one is older than `maxAgeMs` (a window opening the popover asks for this). */
    refreshIfOlder(maxAgeMs: number, now = Date.now()): void {
        if (this.#running === null && now - this.#at >= maxAgeMs) void this.refresh();
    }

    refresh(): Promise<void> {
        if (this.#running) return this.#running;
        this.#running = this.#refresh().finally(() => { this.#running = null; this.#at = Date.now(); });
        return this.#running;
    }

    async #refresh(): Promise<void> {
        const claude = this.#p.accounts().filter((a) => a.provider === 'claude');
        const next: Record<string, ClaudeAccountLive> = {};
        const tell = async (account: AccountRecord, status: ClaudeAccountStatus, configDir: string | null) => {
            const selection: ClaudeAccountSelection = {
                configDir,
                // What the person chose; a default-home account never chose, so the CLI's own answer is what it expects.
                method: account.method ?? (status.method === 'console' ? 'console' : 'subscription'),
                ...(account.identity.email ? { email: account.identity.email } : {}),
            };
            next[account.id] = claudeLiveOf(status, claudeAccounts.compare(selection, status));
            if (account.configDir !== undefined && status.email && (!sameEmail(status.email, account.identity.email) || (status.subscriptionType ?? null) !== account.identity.plan)) {
                await this.#p.recordIdentity(account.id, { name: null, email: status.email, plan: status.subscriptionType ?? null }).catch(() => undefined);
            }
        };
        await Promise.all(claude.filter((a) => a.configDir !== undefined).map(async (account) => {
            try { await tell(account, await this.#p.describe(account.configDir!), account.configDir!); } catch { /* says nothing */ }
        }));
        const home = claude.filter((a) => a.configDir === undefined);
        if (home.length > 0) {
            const dir = this.#p.defaultDir();
            try {
                const status = await this.#p.describe(dir);
                const owner = home.find((a) => sameEmail(a.identity.email, status.email));
                if (owner) await tell(owner, status, dir);
            } catch { /* says nothing */ }
        }
        const before = JSON.stringify(this.#view);
        this.#view = next;
        if (JSON.stringify(next) !== before) this.#p.changed();
    }
}
