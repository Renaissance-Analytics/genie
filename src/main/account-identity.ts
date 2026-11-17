import { codexAccountReadInput, CODEX_ACCOUNT_READ_REPLY, parseClaudeAuthStatus, parseCodexAccountRead } from '../core/account-identity.js';
import { type AccountIdentity, type AccountRecord } from '../core/accounts.js';
import { ACP_PROVIDERS, type AcpProvider } from '../core/engine.js';
import { argvFor, locateProviderProgram, type ProviderHealthPorts } from './provider-health.js';

/**
 * WHO IS SIGNED IN (Tynn #477, Accounts S4; one home per provider since #753), asked of the provider and nothing else. Claude:
 * `claude auth status`. Codex: the App Server's `account/read` with `refreshToken:false` (email, planType). Both run in the
 * provider's normal home, exactly as a person's own terminal would. No credential file is opened here or anywhere under src/
 * (test/account-identity-477).
 *
 * A command that could not run or answer says nothing (`null`: nothing changes). One that ran and reported no account is an
 * unknown identity, which records nothing: the account that was active stays active. A field the provider did not report is
 * never filled in.
 */

const CLAUDE_STATUS_TIMEOUT_MS = 30_000;
const CODEX_APP_SERVER_TIMEOUT_MS = 30_000;

export async function readAccountIdentity(account: Pick<AccountRecord, 'provider'>, ports: ProviderHealthPorts): Promise<AccountIdentity | null> {
    const program = locateProviderProgram(account.provider, ports);
    if (program === null || !program.exists) return null;
    try {
        if (account.provider === 'claude') {
            const [binary, args] = argvFor('claude', program, ['auth', 'status'], ports);
            const answer = await ports.run(binary, args, { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS });
            // Signed out exits non-zero and prints no account: that is an identity of "unknown", not a failure to read.
            return parseClaudeAuthStatus(answer.streams?.stdout ?? answer.stdout);
        }
        const [binary, args] = argvFor('codex', program, ['app-server', '--listen', 'stdio://'], ports);
        const answer = await ports.run(binary, args, { timeoutMs: CODEX_APP_SERVER_TIMEOUT_MS, input: codexAccountReadInput(), endInputOnOutput: CODEX_ACCOUNT_READ_REPLY });
        return parseCodexAccountRead(answer.streams?.stdout ?? answer.stdout);
    } catch {
        return null;
    }
}

/** What reading who is signed in records: the book matches the email to a known account and makes it the active one. */
interface IdentityBook {
    recordSignedIn(provider: AcpProvider, identity: AccountIdentity): Promise<AccountRecord | null>;
    activeFor(provider: AcpProvider): Pick<AccountRecord, 'provider'>;
}

/** Told when a read of who is signed in starts and when it has ended: the account a reading belongs to may change in between. */
export interface IdentityReadHooks {
    readStart(provider: AcpProvider): void;
    readEnd(provider: AcpProvider): void;
}

/**
 * Reads WHO IS SIGNED IN to each provider's one home (Tynn #753): at host start, after a sign-in or a switch, and whenever the
 * provider's health is measured again. The signed-in account becomes the provider's active one, and usage is attributed to it
 * from then on. One read per provider at a time.
 */
export class AccountIdentityReader {
    readonly #book: IdentityBook;
    readonly #ports: () => ProviderHealthPorts;
    readonly #log: (line: string) => void;
    readonly #inFlight = new Map<AcpProvider, Promise<void>>();

    readonly #hooks: IdentityReadHooks | undefined;

    constructor(book: IdentityBook, ports: () => ProviderHealthPorts, log: (line: string) => void = () => {}, hooks?: IdentityReadHooks) {
        this.#book = book; this.#ports = ports; this.#log = log; this.#hooks = hooks;
    }

    refreshProvider(provider: AcpProvider): Promise<void> {
        const running = this.#inFlight.get(provider);
        if (running) return running;
        // The hooks hear the start before anything is read and the end after the account found is recorded, failed or not.
        this.#hook('readStart', provider);
        const run = this.#read(provider).finally(() => { this.#inFlight.delete(provider); this.#hook('readEnd', provider); });
        this.#inFlight.set(provider, run);
        return run;
    }

    refreshAll(): Promise<void> {
        return Promise.all(ACP_PROVIDERS.map(provider => this.refreshProvider(provider))).then(() => undefined);
    }

    #hook(which: keyof IdentityReadHooks, provider: AcpProvider): void {
        try { this.#hooks?.[which](provider); } catch (error) { this.#log(`[account-identity] ${provider}: ${which}: ${error instanceof Error ? error.message : String(error)}`); }
    }

    async #read(provider: AcpProvider): Promise<void> {
        try {
            const identity = await readAccountIdentity(this.#book.activeFor(provider), this.#ports());
            if (identity === null || identity.email === null) return;
            await this.#book.recordSignedIn(provider, identity);
        } catch (error) {
            this.#log(`[account-identity] ${provider}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
