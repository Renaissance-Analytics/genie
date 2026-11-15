import type { AccountIdentity, AccountRecord } from '../core/accounts.js';
import type { AcpProvider } from '../core/engine.js';
import type { ProviderHealthPorts } from './provider-health.js';

// RED stub (Tynn #477): the public surface, inert, so the tests fail on their assertions and not on a missing import.
export async function readAccountIdentity(_account: AccountRecord, _ports: ProviderHealthPorts): Promise<AccountIdentity | null> { return null; }

interface IdentityBook {
    list(): readonly AccountRecord[];
    get(id: string): AccountRecord | null;
    recordIdentity(id: string, identity: AccountIdentity): Promise<void>;
}

export class AccountIdentityReader {
    constructor(_book: IdentityBook, _ports: () => ProviderHealthPorts, _log: (line: string) => void = () => {}) {}
    async refresh(_id: string): Promise<void> {}
    async refreshProvider(_provider: AcpProvider): Promise<void> {}
    async refreshAll(): Promise<void> {}
}
