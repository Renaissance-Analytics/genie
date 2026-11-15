import type { AcpProvider } from '../core/engine.js';
import type { AccountIdentity, AccountRecord } from '../core/accounts.js';

export interface AccountsOptions {
    readonly root: string;
    readonly legacyHomes: Readonly<Record<AcpProvider, string>>;
    readonly now?: () => string;
    readonly mintId?: () => string;
    readonly provision?: (account: AccountRecord) => Promise<void>;
}

/** Assertion-based RED seam. The implementation follows the measured RED. */
export class AccountsHost {
    static async open(options: AccountsOptions): Promise<AccountsHost> { void options; return new AccountsHost(); }
    list(): readonly AccountRecord[] { return []; }
    get(id: string): AccountRecord | null { void id; return null; }
    defaultFor(provider: AcpProvider): AccountRecord | null { void provider; return null; }
    async add(input: { provider: AcpProvider; label?: string }): Promise<AccountRecord> {
        return { id: '', provider: input.provider, label: '', labelEdited: false, home: '', legacy: false,
            identity: { name: null, email: null, plan: null }, createdAt: '' };
    }
    async rename(id: string, label: string): Promise<void> { void id; void label; }
    async recordIdentity(id: string, identity: AccountIdentity): Promise<void> { void id; void identity; }
}
