import { codexAccountReadInput, CODEX_ACCOUNT_READ_REPLY, parseClaudeAuthStatus, parseCodexAccountRead } from '../core/account-identity.js';
import { providerAccountEnv, type AccountIdentity, type AccountRecord } from '../core/accounts.js';
import type { AcpProvider } from '../core/engine.js';
import { argvFor, locateProviderProgram, type ProviderHealthPorts } from './provider-health.js';

/**
 * WHO EACH ACCOUNT IS (Tynn #477, Accounts S4), asked of the provider and nothing else. Claude: `claude auth status` run in
 * the account's own home. Codex: the App Server's `account/read` with `refreshToken:false` (email, planType). Both run with
 * `providerAccountEnv` of the whole account record, so a legacy account inherits the parent environment exactly and a
 * managed one gets its own home. No credential file is opened here or anywhere under src/ (test/account-identity-477).
 *
 * A command that could not run or answer says nothing (`null`: the last identity stays). One that ran and reported no
 * account makes every field unknown. A field the provider did not report is never filled in.
 */

const CLAUDE_STATUS_TIMEOUT_MS = 30_000;
const CODEX_APP_SERVER_TIMEOUT_MS = 30_000;

export async function readAccountIdentity(account: AccountRecord, ports: ProviderHealthPorts): Promise<AccountIdentity | null> {
    const program = locateProviderProgram(account.provider, ports);
    if (program === null || !program.exists) return null;
    const env = providerAccountEnv(account, ports.env);
    try {
        if (account.provider === 'claude') {
            const [binary, args] = argvFor('claude', program, ['auth', 'status'], ports);
            const answer = await ports.run(binary, args, { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS, env });
            // Signed out exits non-zero and prints no account: that is an identity of "unknown", not a failure to read.
            return parseClaudeAuthStatus(answer.streams?.stdout ?? answer.stdout);
        }
        const [binary, args] = argvFor('codex', program, ['app-server', '--listen', 'stdio://'], ports);
        const answer = await ports.run(binary, args, { timeoutMs: CODEX_APP_SERVER_TIMEOUT_MS, env, input: codexAccountReadInput(), endInputOnOutput: CODEX_ACCOUNT_READ_REPLY });
        return parseCodexAccountRead(answer.streams?.stdout ?? answer.stdout);
    } catch {
        return null;
    }
}

interface IdentityBook {
    list(): readonly AccountRecord[];
    get(id: string): AccountRecord | null;
    recordIdentity(id: string, identity: AccountIdentity): Promise<void>;
}

const same = (a: AccountIdentity, b: AccountIdentity): boolean => a.name === b.name && a.email === b.email && a.plan === b.plan;

/** Feeds `AccountsHost.recordIdentity`: at host start, after a login, and whenever the provider's status is measured again. */
export class AccountIdentityReader {
    readonly #book: IdentityBook;
    readonly #ports: () => ProviderHealthPorts;
    readonly #log: (line: string) => void;
    readonly #inFlight = new Map<string, Promise<void>>();

    constructor(book: IdentityBook, ports: () => ProviderHealthPorts, log: (line: string) => void = () => {}) {
        this.#book = book; this.#ports = ports; this.#log = log;
    }

    /** One account, one read at a time. */
    refresh(id: string): Promise<void> {
        const running = this.#inFlight.get(id);
        if (running) return running;
        const run = this.#read(id).finally(() => this.#inFlight.delete(id));
        this.#inFlight.set(id, run);
        return run;
    }

    refreshProvider(provider: AcpProvider): Promise<void> {
        return Promise.all(this.#book.list().filter(a => a.provider === provider).map(a => this.refresh(a.id))).then(() => undefined);
    }

    refreshAll(): Promise<void> {
        return Promise.all(this.#book.list().map(a => this.refresh(a.id))).then(() => undefined);
    }

    async #read(id: string): Promise<void> {
        const account = this.#book.get(id);
        if (!account) return;
        try {
            const identity = await readAccountIdentity(account, this.#ports());
            if (identity === null || same(identity, account.identity)) return;
            await this.#book.recordIdentity(id, identity);
        } catch (error) {
            this.#log(`[account-identity] ${account.provider}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
