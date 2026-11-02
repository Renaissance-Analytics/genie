import type { AgentId, AgentRecord } from '../core/identity.js';
import type { StopVerdict } from '../core/session.js';

/**
 * TYNN COMES BACK, AND NOBODY HAS TO OPEN A WINDOW (P3.4 cut c; the owner: "this should not happen at all. fix it, don't bandaid it"). The host
 * owns the account and prepares its agents, so it also brings their Tynn tools back. When the account signs in, Tynn answers again, or an older
 * Genie's keys have moved, it restarts each agent that went without, on its conversation, at its next idle: never through a running turn. A
 * stopped agent is left stopped, since its next start prepares it anyway.
 *
 * THE ASKING. An account change is one way to hear it. An agent waiting on Tynn is the other reason to look: the account's own retries end, and
 * Tynn's agent endpoints can be down while /me is fine. So while someone waits, this asks again on a backoff; with nobody waiting, nothing is
 * scheduled. A restart comes only once the host holds the key (`names`, agent-tynn-prep.ts): until then the running agent is not touched.
 *
 * THE THREAD. With no window, the host only queues an agent's thread id for the next window, so the registry may not know it yet. `threadOf` is what
 * the host heard: resuming from the registry alone would quietly start a new conversation.
 */
export const RECOVERY_STEPS_MS: readonly number[] = [30_000, 120_000, 600_000, 1_800_000];
const BACK_NOTICE = 'Tynn is available again. Genie restarted this session on the same conversation to bring its Tynn tools up to date.';

export interface HostTynnRecoveryPorts {
    /** Who should restart to get their tools back. */
    names(asked: { readonly secretsMoved?: boolean }): Promise<string[]>;
    /** Is an agent running without what Tynn answering would give it? */
    waiting(): boolean;
    /** Ask Tynn who we are, so a Tynn that is back is heard. */
    recheck(): Promise<unknown>;
    readonly host: {
        probe(id: AgentId): { readonly running?: boolean | undefined; readonly inTurn?: boolean | undefined } | null;
        subscribe(listener: (id: AgentId) => void): () => void;
        notice(id: AgentId, text: string): boolean;
        stop(id: AgentId): boolean;
        ended(id: AgentId): Promise<StopVerdict | null>;
        start(record: AgentRecord, cwd: string): { ok: true } | { ok: false; reason: string } | Promise<{ ok: true } | { ok: false; reason: string }>;
        deliverOwed(id: AgentId): Promise<number>;
    };
    record(id: string): AgentRecord | null;
    threadOf(id: string): string | null;
    cwdFor(record: AgentRecord): string;
    readonly schedule?: (ms: number, fn: () => void) => () => void;
    readonly log?: (line: string) => void;
}

export function hostTynnRecovery(ports: HostTynnRecoveryPorts) {
    const log = ports.log ?? (() => {});
    const schedule = ports.schedule ?? ((ms: number, fn: () => void) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
    /** Named, and waiting for their turn to end. */
    const owed = new Set<string>();
    const restarting = new Set<string>();
    const toldWaiting = new Set<string>();

    const restart = async (id: string): Promise<void> => {
        const known = ports.record(id);
        if (!known) { log(`tynn recovery: no record for ${id}`); return; }
        const record: AgentRecord = { ...known, threadId: ports.threadOf(id) ?? known.threadId };
        log(`tynn recovery: restarting ${record.name} on ${record.threadId ?? 'a new conversation'}`);
        const agent = id as AgentId;
        ports.host.stop(agent);
        const verdict = await ports.host.ended(agent);
        if (verdict && !verdict.verified && verdict.survivors.length > 0) {
            log(`tynn recovery: ${record.name}'s previous run did not end, so it was not started again: ${verdict.reason}`);
            return;
        }
        const started = await ports.host.start(record, ports.cwdFor(record));
        if (!started.ok) { log(`tynn recovery: ${record.name} could not start again: ${started.reason}`); return; }
        // In the new run's chat, where it is seen, and only once it is true.
        ports.host.notice(agent, BACK_NOTICE);
        await ports.host.deliverOwed(agent);
    };

    /** At its idle, once. */
    const settle = (id: string): void => {
        if (!owed.has(id) || restarting.has(id)) return;
        const live = ports.host.probe(id as AgentId);
        if (!live || live.running === false) { owed.delete(id); return; }
        if (live.inTurn === true) {
            // Said once per wait: an agent parked on a question the person has not answered waits as long as that takes.
            if (!toldWaiting.has(id)) { toldWaiting.add(id); log(`tynn recovery: ${id} holds its key and waits for its turn to end before restarting`); }
            return;
        }
        toldWaiting.delete(id);
        owed.delete(id);
        restarting.add(id);
        void restart(id)
            .catch((error: unknown) => log(`tynn recovery: ${id}: ${error instanceof Error ? error.message : String(error)}`))
            .finally(() => { restarting.delete(id); });
    };
    ports.host.subscribe((id) => settle(id));

    let work: Promise<void> = Promise.resolve();
    const recover = (asked: { readonly secretsMoved?: boolean } = {}): Promise<void> => {
        const run = async (): Promise<void> => {
            for (const id of await ports.names(asked)) {
                if (owed.has(id) || restarting.has(id)) continue;
                owed.add(id);
                settle(id);
            }
        };
        const next = work.then(run, run).catch((error: unknown) => log(`tynn recovery: ${error instanceof Error ? error.message : String(error)}`));
        work = next;
        return next;
    };

    let step = 0;
    let looping = false;
    const tick = (): void => {
        if (!ports.waiting()) { looping = false; step = 0; return; }
        schedule(RECOVERY_STEPS_MS[Math.min(step, RECOVERY_STEPS_MS.length - 1)]!, () => {
            step += 1;
            void (async () => {
                await ports.recheck().catch(() => {});
                await recover();
            })().finally(tick);
        });
    };
    /** An agent was prepared: if it is waiting on Tynn, start asking. One loop however many agents. */
    const kick = (): void => {
        if (looping || !ports.waiting()) return;
        looping = true;
        tick();
    };

    return { recover, kick };
}
