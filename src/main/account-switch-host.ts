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
        start(record: AgentRecord, cwd: string): { ok: true } | { ok: false; reason: string } | Promise<{ ok: true } | { ok: false; reason: string }>;
        deliverOwed(id: AgentId, then?: { text: string; by: string }): Promise<number>;
    };
    cwdFor(record: AgentRecord): string;
}

export type AccountSwitchResult =
    | { ok: true; moved: AgentId[]; failed: Array<{ id: AgentId; reason: string }> }
    | { ok: false; reason: string };

/** What each agent is told when it comes back: the account behind it changed, the conversation did not. */
export function switchNote(provider: string, from: Pick<AccountRecord, 'label'>, to: Pick<AccountRecord, 'label'>): string {
    const name = provider.charAt(0).toUpperCase() + provider.slice(1);
    return `Genie switched the ${name} account every agent runs on, from "${from.label}" to "${to.label}", and started you again on it. `
        + 'This is the same conversation and the same agent; only the account behind it changed, so usage now counts against the new account. '
        + 'Carry on with what you were doing.';
}

/**
 * SWITCHING A PROVIDER'S ACTIVE ACCOUNT MOVES EVERY AGENT STRAIGHT AWAY (Tynn #751; the owner: "move straight away"). Every
 * agent of the provider runs on its ONE active account, so the account is set first (a start from here on reads the new
 * one), every running agent of the provider is stopped cleanly — its turn ends, what was queued for it stays owed — and each
 * is started again on its own conversation with a note naming the switch, after what it was owed (`deliverOwed`). Another
 * provider's agents are never touched; an agent that cannot start again is reported, and the others still move.
 */
export async function switchActiveAccount(ports: AccountSwitchPorts, provider: AcpProvider, accountId: string): Promise<AccountSwitchResult> {
    const to = ports.accounts.get(accountId);
    if (!to || to.provider !== provider) return { ok: false, reason: `That is not one of the ${provider} accounts Genie knows; choose an account from its list.` };
    const from = ports.accounts.activeFor(provider);
    if (from.id === to.id) return { ok: true, moved: [], failed: [] };
    const running = ports.host.startedIds().map((id) => ports.registry.find(id)).filter((r): r is AgentRecord => r !== null && r.provider === provider);
    try { await ports.accounts.setActive(provider, to.id); }
    catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
    // Every stop is asked at once, so none of them keeps working on the old account while another is waited for.
    for (const record of running) ports.host.stop(record.id);
    const note = { text: switchNote(provider, from, to), by: 'genie' };
    const moved: AgentId[] = [];
    const failed: Array<{ id: AgentId; reason: string }> = [];
    await Promise.all(running.map(async (record) => {
        try {
            // Started again only once the old run has ended: two runs on one conversation is how it forks.
            const verdict = await ports.host.ended(record.id);
            if (verdict && !verdict.verified && verdict.survivors.length > 0) {
                failed.push({ id: record.id, reason: `${record.name}'s previous run did not end, so it was not started again: ${verdict.reason}` });
                return;
            }
            const started = await ports.host.start(ports.registry.find(record.id) ?? record, ports.cwdFor(record));
            if (!started.ok) { failed.push({ id: record.id, reason: started.reason }); return; }
            await ports.host.deliverOwed(record.id, note);
            moved.push(record.id);
        } catch (error) {
            failed.push({ id: record.id, reason: error instanceof Error ? error.message : String(error) });
        }
    }));
    return { ok: true, moved, failed };
}
