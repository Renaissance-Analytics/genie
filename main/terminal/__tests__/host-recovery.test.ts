import { describe, it, expect, vi } from 'vitest';
import { recoverFromHostLoss, type HostRecoveryDeps } from '../host-service';

/**
 * Fix C (genie#203) — the pure recovery orchestrator. When the single shared
 * detached pty-host dies mid-session, the package only reverts to in-process +
 * toasts; it does NOT snapshot, respawn, or re-attach, so every terminal stays
 * frozen. This orchestrator drives the recovery the package leaves undone:
 *
 *   snapshot the dead host's ids  →  respawn a backend  →  re-attach the ids
 *   (renderer replays each from its snapshot)  →  surface a structured status.
 *
 * It is detection-agnostic (whatever notices the death calls it), re-entrancy
 * guarded (an overlapping death signal must not double-recover), and NEVER
 * throws (a recovery that itself crashes would strand the user worse than the
 * freeze).
 */

/** A deferred promise so a test can hold `respawn` open and probe re-entrancy. */
function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

function deps(over: Partial<HostRecoveryDeps> = {}): {
    d: HostRecoveryDeps;
    order: string[];
    status: string[];
} {
    const order: string[] = [];
    const status: string[] = [];
    const d: HostRecoveryDeps = {
        affectedIds: () => ['t-1', 't-2'],
        snapshotAffected: (ids) => { order.push(`snapshot:${ids.join(',')}`); },
        respawn: async () => { order.push('respawn'); return { host: true }; },
        reattach: (ids) => { order.push(`reattach:${ids.join(',')}`); },
        emitStatus: (s) => { order.push(`status:${s}`); status.push(s); },
        ...over,
    };
    return { d, order, status };
}

describe('recoverFromHostLoss', () => {
    it('snapshots BEFORE respawn and re-attaches AFTER, ending in "recovered" when a host returns', async () => {
        const { d, order, status } = deps();

        const outcome = await recoverFromHostLoss(d);

        expect(outcome).toBe('recovered');
        // snapshot must precede respawn (the dead client's scrollback is the only
        // copy), and re-attach must follow it (needs the fresh backend).
        expect(order).toEqual([
            'snapshot:t-1,t-2',
            'status:recovering',
            'respawn',
            'reattach:t-1,t-2',
            'status:recovered',
        ]);
        expect(status).toEqual(['recovering', 'recovered']);
    });

    it('still snapshots + re-attaches but reports "degraded" when only in-process comes back', async () => {
        const { d, status } = deps({ respawn: async () => ({ host: false }) });

        const outcome = await recoverFromHostLoss(d);

        expect(outcome).toBe('degraded'); // terminals work, but not host-backed
        expect(status).toEqual(['recovering', 'degraded']);
    });

    it('is re-entrancy guarded: a death signal DURING recovery is a no-op ("busy")', async () => {
        const gate = deferred<{ host: boolean }>();
        const { d, order } = deps({ respawn: () => { order.push('respawn'); return gate.promise; } });

        const first = recoverFromHostLoss(d); // parks awaiting respawn
        const second = await recoverFromHostLoss(d); // fires mid-recovery

        expect(second).toBe('busy');
        gate.resolve({ host: true });
        await first;
        // Exactly ONE recovery ran — no duplicated snapshot/reattach.
        expect(order.filter((o) => o.startsWith('snapshot')).length).toBe(1);
        expect(order.filter((o) => o.startsWith('reattach')).length).toBe(1);
    });

    it('never throws and still emits a terminal status when a dep blows up', async () => {
        const { d, status } = deps({
            reattach: () => { throw new Error('reattach exploded'); },
        });

        const outcome = await recoverFromHostLoss(d);

        expect(outcome).toBe('recovered'); // reattach failure doesn't abort recovery
        expect(status.at(-1)).toBe('recovered'); // status still surfaced
    });

    it('degrades (not throws) when respawn itself rejects', async () => {
        const { d, status } = deps({
            respawn: async () => { throw new Error('spawn failed'); },
        });

        const outcome = await recoverFromHostLoss(d);

        expect(outcome).toBe('degraded');
        expect(status).toEqual(['recovering', 'degraded']);
    });
});
