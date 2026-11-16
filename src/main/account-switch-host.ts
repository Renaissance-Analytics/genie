import type { AcpProvider } from '../core/engine.js';
import type { AccountRecord } from '../core/accounts.js';
import type { AgentId, AgentRecord } from '../core/identity.js';
import type { StopVerdict } from '../core/session.js';

/** What switching a provider's active account reads and drives (Tynn #751). */
export interface AccountSwitchPorts {
    readonly accounts: {
        get(id: string): AccountRecord | null;
        activeFor(provider: AcpProvider): AccountRecord;
        setActive(provider: AcpProvider, id: string): Promise<void>;
    };
    readonly registry: { find(id: string): AgentRecord | null };
    readonly host: {
        startedIds(): AgentId[];
        stop(id: AgentId): unknown;
        ended(id: AgentId): Promise<StopVerdict | null>;
        start(record: AgentRecord, cwd: string): { ok: true } | { ok: false; reason: string };
        deliverOwed(id: AgentId, then?: { text: string; by: string }): Promise<number>;
    };
    cwdFor(record: AgentRecord): string;
}

export type AccountSwitchResult =
    | { ok: true; moved: AgentId[]; failed: Array<{ id: AgentId; reason: string }> }
    | { ok: false; reason: string };

/** RED STUB (Tynn #751): inert. */
export async function switchActiveAccount(_ports: AccountSwitchPorts, _provider: AcpProvider, _accountId: string): Promise<AccountSwitchResult> {
    return { ok: false, reason: 'not implemented' };
}
