import { randomBytes } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { ACP_PROVIDERS, isAcpProvider, type AcpProvider } from '../core/engine.js';
import { accountIdentityOf, accountLabel, accountLabelOf, legacyAccountId, unknownAccountIdentity, type AccountIdentity, type AccountRecord } from '../core/accounts.js';
import { forgetRefusal } from '../core/account-settings.js';
import { isClaudeLoginMethod } from '../core/claude-accounts.js';
import { prepareAccountDir, syncCleanupPeriod } from './claude-account-dirs.js';
import { runtimeDir } from './paths.js';
import { readJson, writeJsonAtomic } from './store.js';

export interface AccountsOptions {
    readonly root: string;
    readonly legacyHomes: Readonly<Record<AcpProvider, string>>;
    readonly now?: () => string;
    readonly mintId?: () => string;
    /** The ONE session store every Claude account directory links its history to (Tynn #1011): the default home's `projects`. */
    readonly sharedSessionStore?: string;
}

const MANAGED_ID = /^account_[0-9a-f]{32}$/;
/** `active` names the ONE account each provider runs on; absent (or a provider missing from it) = the legacy account. */
type Book = { version: 1; accounts: readonly AccountRecord[]; active?: Readonly<Partial<Record<AcpProvider, string>>> };
type Parsed = { accounts: AccountRecord[]; active: Partial<Record<AcpProvider, string>> };
const detached = (account: AccountRecord): AccountRecord => ({ ...account, identity: { ...account.identity } });

function parseBook(value: unknown): Parsed {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid account book');
    const book = value as Record<string, unknown>;
    if (book.version !== 1 || !Array.isArray(book.accounts)) throw new Error('Invalid account book version or accounts');
    const seen = new Set<string>();
    const accounts = book.accounts.map((raw: unknown): AccountRecord => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Invalid account record');
        const a = raw as Record<string, unknown>;
        if (!isAcpProvider(a.provider as string) || typeof a.id !== 'string' || seen.has(a.id) || typeof a.legacy !== 'boolean' ||
            typeof a.label !== 'string' || typeof a.labelEdited !== 'boolean' || typeof a.home !== 'string' || !isAbsolute(a.home) ||
            typeof a.createdAt !== 'string' || !Number.isFinite(Date.parse(a.createdAt))) throw new Error('Invalid account record');
        const provider = a.provider as AcpProvider;
        if (a.legacy ? a.id !== legacyAccountId(provider) : !MANAGED_ID.test(a.id)) throw new Error('Invalid account id');
        seen.add(a.id);
        // A Claude account of its own (Tynn #1011): an absolute directory and the method chosen, both or neither; never on Codex.
        const own = a.configDir !== undefined || a.method !== undefined;
        if (own && (provider !== 'claude' || a.legacy || typeof a.configDir !== 'string' || !isAbsolute(a.configDir) || !isClaudeLoginMethod(a.method))) throw new Error('Invalid account directory');
        return { id: a.id, provider, label: accountLabelOf(a.label), labelEdited: a.labelEdited, home: a.home, legacy: a.legacy,
            identity: accountIdentityOf(a.identity), createdAt: a.createdAt,
            ...(own ? { configDir: a.configDir as string, method: a.method as 'subscription' | 'console' } : {}) };
    });
    for (const provider of ACP_PROVIDERS) if (!seen.has(legacyAccountId(provider))) throw new Error('Invalid account book: missing legacy default');
    const active: Partial<Record<AcpProvider, string>> = {};
    if (book.active !== undefined) {
        if (typeof book.active !== 'object' || book.active === null || Array.isArray(book.active)) throw new Error('Invalid active accounts');
        for (const [provider, id] of Object.entries(book.active as Record<string, unknown>)) {
            if (!isAcpProvider(provider) || typeof id !== 'string' || !accounts.some(a => a.id === id && a.provider === provider)) throw new Error('Invalid active account');
            active[provider] = id;
        }
    }
    return { accounts, active };
}

/** A single host owns this book. Every mutation is serialized, durable BEFORE it becomes visible, and rejects on failure.
 * Every account is a reference to the provider's one normal home (Tynn #753): nothing here creates, traverses or provisions a
 * provider home. An account folder an earlier build made is left exactly as it is.
 */
export class AccountsHost {
    readonly #options: AccountsOptions;
    readonly #file: string;
    #accounts: readonly AccountRecord[];
    #active: Readonly<Partial<Record<AcpProvider, string>>>;
    #tail: Promise<unknown> = Promise.resolve();

    private constructor(options: AccountsOptions, accounts: readonly AccountRecord[], active: Readonly<Partial<Record<AcpProvider, string>>> = {}) {
        this.#options = options; this.#accounts = accounts; this.#active = active;
        this.#file = join(runtimeDir(options.root), 'accounts.json');
    }

    static async open(options: AccountsOptions): Promise<AccountsHost> {
        if (!isAbsolute(options.root)) throw new Error('Account root must be absolute');
        const root = resolve(options.root);
        const at = join(runtimeDir(root), 'accounts.json');
        const missing = Symbol('missing account book');
        const stored = await readJson<unknown>(at, missing);
        if (stored !== missing) { const parsed = parseBook(stored); return new AccountsHost({ ...options, root }, parsed.accounts, parsed.active); }
        const createdAt = (options.now ?? (() => new Date().toISOString()))();
        const accounts = ACP_PROVIDERS.map((provider): AccountRecord => {
            const home = options.legacyHomes[provider];
            if (!isAbsolute(home)) throw new Error('Legacy account home must be absolute');
            return { id: legacyAccountId(provider), provider, label: accountLabel(null, 1), labelEdited: false, home,
                legacy: true, identity: unknownAccountIdentity(), createdAt };
        });
        const host = new AccountsHost({ ...options, root }, accounts);
        await host.#write(accounts, {});
        return host;
    }

    list(): readonly AccountRecord[] { return this.#accounts.map(detached); }
    get(id: string): AccountRecord | null { const a = this.#accounts.find(a => a.id === id); return a ? detached(a) : null; }
    /**
     * THE ACCOUNT EVERY AGENT OF THE PROVIDER RUNS ON (Tynn #751; the owner: "the logged in account is the active account
     * on the host machine. All agents use the logged in account"). One per provider; the legacy account until another is chosen.
     */
    activeFor(provider: AcpProvider): AccountRecord {
        return this.get(this.#active[provider] ?? legacyAccountId(provider)) ?? this.get(legacyAccountId(provider))!;
    }

    /** Choose the provider's active account: durable BEFORE it is visible; an unknown account, or another provider's, is refused. */
    setActive(provider: AcpProvider, id: string): Promise<void> {
        return this.#queue(async () => {
            if (!isAcpProvider(provider)) throw new Error('Invalid account provider');
            const account = this.#accounts.find(a => a.id === id);
            if (!account) throw new Error('Unknown account');
            if (account.provider !== provider) throw new Error('That account belongs to another provider');
            const next = { ...this.#active, [provider]: id };
            await this.#write(this.#accounts, next); this.#active = next;
        });
    }

    /**
     * A KNOWN ACCOUNT (Tynn #753). It has no folder of its own: every account of a provider runs in the provider's ONE normal
     * home, so its `home` is that reference and nothing is created on disk.
     */
    add(input: { provider: AcpProvider; label?: string }): Promise<AccountRecord> {
        return this.#queue(async () => {
            const account = this.#newAccount(input.provider, input.label, null);
            const next = [...this.#accounts, account];
            await this.#write(next, this.#active); this.#accounts = next;
            return detached(account);
        });
    }

    /**
     * A CLAUDE ACCOUNT OF ITS OWN (Tynn #1011): a configuration directory under Genie's data, made now with its session history
     * linked to the one shared store (claude-account-dirs.ts), and the method the person chose. Nothing is signed in yet: the
     * person signs in with Claude Code's own login in a terminal they see. No credential is written, read or kept here.
     */
    addClaude(input: { method: 'subscription' | 'console'; label?: string }): Promise<AccountRecord> {
        return this.#queue(async () => {
            if (!isClaudeLoginMethod(input.method)) throw new Error('Invalid sign-in method');
            const base = this.#newAccount('claude', input.label, null);
            const configDir = resolve(this.#options.root, 'accounts', 'claude', base.id);
            const prepared = prepareAccountDir(configDir, this.#sharedStore());
            if (!prepared.ok) throw new Error(prepared.reason);
            syncCleanupPeriod(configDir, this.#options.legacyHomes.claude);
            const account: AccountRecord = { ...base, configDir, method: input.method };
            const next = [...this.#accounts, account];
            await this.#write(next, this.#active); this.#accounts = next;
            return detached(account);
        });
    }

    /**
     * KEEP EVERY DIRECTORY GENIE MADE IN STEP (at the host's start): its history still shared, and its `cleanupPeriodDays` the
     * default account's, so no account prunes the shared store sooner than the default does. A directory that refuses is left
     * as it is; its account still works on its own history.
     */
    syncClaudeDirs(busy: (configDir: string) => boolean = () => false): void {
        for (const a of this.#accounts) {
            // Never while a sign-in runs in that folder (prism-acp: one process per folder at a time).
            if (a.provider !== 'claude' || a.configDir === undefined || busy(a.configDir)) continue;
            try { prepareAccountDir(a.configDir, this.#sharedStore()); syncCleanupPeriod(a.configDir, this.#options.legacyHomes.claude); } catch { /* left as it is */ }
        }
    }

    /** The one store every Claude account directory shares: the default home's own `projects`. */
    #sharedStore(): string {
        return this.#options.sharedSessionStore ?? join(this.#options.legacyHomes.claude, 'projects');
    }

    /**
     * THE ACCOUNT SIGNED IN TO THE PROVIDER'S ONE HOME NOW (Tynn #753): matched by email to a known account, which becomes the
     * provider's active one; a new email becomes a new known account (labelled by its email until renamed). A placeholder that
     * has never been told who it is (the legacy account on a fresh book) is the account that was in use, so it takes the first
     * email. An identity with no email says nothing about who is signed in and changes nothing. Usage is attributed to the
     * active account from here on; no agent is touched.
     */
    recordSignedIn(provider: AcpProvider, identity: AccountIdentity): Promise<AccountRecord | null> {
        return this.#queue(async () => {
            if (!isAcpProvider(provider)) throw new Error('Invalid account provider');
            const reported = accountIdentityOf(identity);
            const email = reported.email?.toLowerCase() ?? null;
            if (email === null) return null;
            // Only the accounts that live in the provider's ONE default home: one with its own directory (Tynn #1011) is chosen,
            // never taken over by whoever signs in to the default home, even with the same email.
            const mine = this.#accounts.filter(a => a.provider === provider && a.configDir === undefined);
            const match = mine.find(a => a.identity.email?.toLowerCase() === email) ?? mine.find(a => a.identity.email === null);
            let accounts: readonly AccountRecord[];
            let account: AccountRecord;
            if (match) {
                const ordinal = mine.findIndex(a => a.id === match.id) + 1;
                const kept = { ...reported, email: match.identity.email ?? reported.email };
                account = { ...detached(match), identity: kept, label: match.labelEdited ? match.label : accountLabel(kept.email, ordinal) };
                accounts = this.#accounts.map(a => a.id === match.id ? account : a);
            } else {
                account = this.#newAccount(provider, undefined, reported);
                accounts = [...this.#accounts, account];
            }
            const active = { ...this.#active, [provider]: account.id };
            await this.#write(accounts, active); this.#accounts = accounts; this.#active = active;
            return detached(account);
        });
    }

    #newAccount(provider: AcpProvider, label: string | undefined, identity: AccountIdentity | null): AccountRecord {
        if (!isAcpProvider(provider)) throw new Error('Invalid account provider');
        const id = (this.#options.mintId ?? (() => `account_${randomBytes(16).toString('hex')}`))();
        if (!MANAGED_ID.test(id) || this.get(id)) throw new Error('Invalid or occupied account id');
        const ordinal = this.#accounts.filter(a => a.provider === provider).length + 1;
        return { id, provider, label: label === undefined ? accountLabel(identity?.email ?? null, ordinal) : accountLabelOf(label),
            labelEdited: label !== undefined, home: this.#options.legacyHomes[provider], legacy: false,
            identity: identity ?? unknownAccountIdentity(), createdAt: (this.#options.now ?? (() => new Date().toISOString()))() };
    }

    /**
     * FORGET A KNOWN ACCOUNT (Tynn #484). The account signed in now is refused, and says so: every agent of its provider uses
     * it. Another is removed from the book. The provider's first account (the book's placeholder, which the book always keeps)
     * is reset to an unnamed placeholder instead, so the next account signed in that Genie does not know takes its place.
     * Nothing on disk but the book changes; no credential is touched.
     */
    forget(id: string): Promise<void> {
        return this.#queue(async () => {
            const account = this.#accounts.find((a) => a.id === id);
            if (!account) throw new Error('Unknown account');
            const refused = forgetRefusal({ label: account.label, active: this.activeFor(account.provider).id === id });
            if (refused) throw new Error(refused);
            const ordinal = this.#accounts.filter((a) => a.provider === account.provider).findIndex((a) => a.id === id) + 1;
            const next = account.legacy
                ? this.#accounts.map((a) => a.id === id ? { ...detached(a), identity: unknownAccountIdentity(), label: accountLabel(null, ordinal), labelEdited: false } : a)
                : this.#accounts.filter((a) => a.id !== id);
            await this.#write(next, this.#active); this.#accounts = next;
        });
    }

    rename(id: string, label: string): Promise<void> {
        return this.#update(id, a => ({ ...a, label: accountLabelOf(label), labelEdited: true }));
    }

    /** S4's status adapter is the only producer; this method performs no provider or credential I/O. */
    recordIdentity(id: string, identity: AccountIdentity): Promise<void> {
        return this.#update(id, a => {
            const reported = accountIdentityOf(identity);
            return { ...a, identity: reported, label: a.labelEdited ? a.label : accountLabel(reported.email, this.#accounts.filter(x => x.provider === a.provider).findIndex(x => x.id === id) + 1) };
        });
    }

    #update(id: string, update: (a: AccountRecord) => AccountRecord): Promise<void> {
        return this.#queue(async () => {
            if (!this.get(id)) throw new Error('Unknown account');
            const next = this.#accounts.map(a => a.id === id ? update(detached(a)) : a);
            await this.#write(next, this.#active); this.#accounts = next;
        });
    }

    #queue<T>(run: () => Promise<T>): Promise<T> {
        const next = this.#tail.catch(() => undefined).then(run);
        this.#tail = next;
        return next;
    }

    #write(accounts: readonly AccountRecord[], active: Readonly<Partial<Record<AcpProvider, string>>>): Promise<void> {
        const book: Book = { version: 1, accounts, ...(Object.keys(active).length > 0 ? { active } : {}) };
        return writeJsonAtomic(this.#file, book);
    }
}
