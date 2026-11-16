import { randomBytes } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { ACP_PROVIDERS, isAcpProvider, type AcpProvider } from '../core/engine.js';
import { accountIdentityOf, accountLabel, accountLabelOf, legacyAccountId, unknownAccountIdentity, type AccountIdentity, type AccountRecord } from '../core/accounts.js';
import { providerProtocol, sharedProtocol } from '../core/genie-protocol.js';
import { GENIE_SKILLS, skillFile } from './agent-skills.js';
import { writeGenieInstructions } from './genie-instructions.js';
import { runtimeDir } from './paths.js';
import { readJson, writeJsonAtomic } from './store.js';

export interface AccountsOptions {
    readonly root: string;
    readonly legacyHomes: Readonly<Record<AcpProvider, string>>;
    readonly now?: () => string;
    readonly mintId?: () => string;
    readonly provision?: (account: AccountRecord) => Promise<void>;
}

const MANAGED_ID = /^account_[0-9a-f]{32}$/;
/** `active` names the ONE account each provider runs on; absent (or a provider missing from it) = the legacy account. */
type Book = { version: 1; accounts: readonly AccountRecord[]; active?: Readonly<Partial<Record<AcpProvider, string>>> };
type Parsed = { accounts: AccountRecord[]; active: Partial<Record<AcpProvider, string>> };
const detached = (account: AccountRecord): AccountRecord => ({ ...account, identity: { ...account.identity } });
const homeFor = (root: string, provider: AcpProvider, id: string): string => join(root, 'accounts', provider, id);

function parseBook(value: unknown, root: string): Parsed {
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
        if (a.legacy ? a.id !== legacyAccountId(provider) : !MANAGED_ID.test(a.id) || resolve(a.home) !== homeFor(root, provider, a.id)) throw new Error('Invalid account id or home');
        seen.add(a.id);
        return { id: a.id, provider, label: accountLabelOf(a.label), labelEdited: a.labelEdited, home: a.home, legacy: a.legacy,
            identity: accountIdentityOf(a.identity), createdAt: a.createdAt };
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

/** Only generated Genie content. Never enumerate, read or copy a provider's existing home.
 * MCP servers/settings containing a caller's authority are supplied by SessionHost on EVERY launch, not stored here.
 */
export async function provisionAccountHome(account: AccountRecord): Promise<void> {
    const home = account.home;
    const words = `${sharedProtocol([])}\n\n${providerProtocol(account.provider)}\n`;
    await writeFile(join(home, account.provider === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'), words, { flag: 'wx', mode: 0o600 });
    const settings = account.provider === 'claude' ? ['settings.json', '{}\n'] : ['config.toml', 'cli_auth_credentials_store = "file"\n'];
    await writeFile(join(home, settings[0]!), settings[1]!, { flag: 'wx', mode: 0o600 });
    await writeGenieInstructions(join(home, 'genie'), []);
    for (const skill of GENIE_SKILLS) {
        const dir = join(home, 'skills', skill.name);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(join(dir, 'SKILL.md'), skillFile(skill), { flag: 'wx', mode: 0o600 });
    }
}

/** A single host owns this book. Every mutation is serialized, durable BEFORE it becomes visible, and rejects on failure.
 * Legacy homes are references only: even first boot does not traverse or provision them.
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
        if (stored !== missing) { const parsed = parseBook(stored, root); return new AccountsHost({ ...options, root }, parsed.accounts, parsed.active); }
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

    add(input: { provider: AcpProvider; label?: string }): Promise<AccountRecord> {
        return this.#queue(async () => {
            if (!isAcpProvider(input.provider)) throw new Error('Invalid account provider');
            const id = (this.#options.mintId ?? (() => `account_${randomBytes(16).toString('hex')}`))();
            if (!MANAGED_ID.test(id) || this.get(id)) throw new Error('Invalid or occupied account id');
            const account: AccountRecord = { id, provider: input.provider,
                label: input.label === undefined ? accountLabel(null, this.#accounts.filter(a => a.provider === input.provider).length + 1) : accountLabelOf(input.label),
                labelEdited: input.label !== undefined, home: homeFor(this.#options.root, input.provider, id), legacy: false,
                identity: unknownAccountIdentity(), createdAt: (this.#options.now ?? (() => new Date().toISOString()))() };
            // Never follow a planted link or reuse an existing directory; no cleanup deletes provider-owned files.
            for (const dir of [join(this.#options.root, 'accounts'), join(this.#options.root, 'accounts', input.provider)]) {
                await mkdir(dir, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
                const stat = await lstat(dir);
                if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Account directory is a link or redirected directory');
            }
            await mkdir(account.home, { mode: 0o700 });
            await (this.#options.provision ?? provisionAccountHome)(detached(account));
            const next = [...this.#accounts, account];
            await this.#write(next, this.#active); this.#accounts = next;
            return detached(account);
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
