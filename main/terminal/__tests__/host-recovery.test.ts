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
        reattachProcesses: () => { order.push('processes'); },
        reattachAgents: () => { order.push('agents'); },
        emitStatus: (s) => { order.push(`status:${s}`); status.push(s); },
        ...over,
    };
    return { d, order, status };
}

describe('recoverFromHostLoss', () => {
    it('revives agents host-side before asking any renderer to reattach', async () => {
        const { d, order } = deps();
        Object.assign(d, { reattachAgents: () => order.push('agents') });
        await recoverFromHostLoss(d);
        expect(order).toContain('agents');
        expect(order.indexOf('agents')).toBeGreaterThan(order.indexOf('respawn'));
        expect(order.indexOf('agents')).toBeLessThan(order.indexOf('reattach:t-1,t-2'));
    });
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
            'agents',
            'reattach:t-1,t-2',
            // The HEADLESS half (genie#655). `reattach` is a broadcast to the
            // renderer, and a supervised process has no pane to remount — so
            // without this step the queue workers that died with the host stay
            // dead while the supervisor still reports them running.
            'processes',
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

/**
 * "RECOVERED" MUST MEAN THE AGENTS CAME BACK.
 *
 * The outcome was decided on one fact — whether a host process returned:
 *
 *     const outcome = host ? 'recovered' : 'degraded';
 *
 * Nothing asked whether a single terminal survived. So when the shared host died
 * of an access violation with 22 terminals live, recovery respawned a host,
 * relaunched every agent, every `claude --resume` exited 1 milliseconds later —
 * and the banner said RECOVERED. The owner saw "[process exited with code 1]" on
 * every screen in every workspace while Genie reported success.
 *
 * That is the blast radius made permanent. The host fault is survivable; a
 * recovery that cannot tell whether it worked is not, because nobody is told to
 * look.
 *
 * A revival that relaunched nothing is DEGRADED. The word is already wired to a
 * banner; it just has to be true.
 */
describe('the outcome tells the truth about the agents', () => {
    it('is DEGRADED when every agent failed to come back, even though a host did', async () => {
        const { d, status } = deps();
        Object.assign(d, { reattachAgents: () => ({ attempted: 3, revived: 0 }) });

        expect(await recoverFromHostLoss(d)).toBe('degraded');
        expect(status).toContain('degraded');
    });

    it('is DEGRADED when only some came back', async () => {
        // Partial is not success. One dead agent is a person waiting on a turn
        // that will never start.
        const { d } = deps();
        Object.assign(d, { reattachAgents: () => ({ attempted: 3, revived: 2 }) });

        expect(await recoverFromHostLoss(d)).toBe('degraded');
    });

    it('CONTROL: is RECOVERED when every agent came back', async () => {
        // Without this, "degraded" would pass against a build that had simply
        // stopped saying recovered at all.
        const { d } = deps();
        Object.assign(d, { reattachAgents: () => ({ attempted: 3, revived: 3 }) });

        expect(await recoverFromHostLoss(d)).toBe('recovered');
    });

    it('CONTROL: is RECOVERED when there were no agents to revive', async () => {
        // A host that died holding only plain shells recovered fine. Reporting
        // degraded here would cry wolf and teach people to ignore the banner.
        const { d } = deps();
        Object.assign(d, { reattachAgents: () => ({ attempted: 0, revived: 0 }) });

        expect(await recoverFromHostLoss(d)).toBe('recovered');
    });

    it('still reports degraded when no host returned at all', async () => {
        const { d } = deps();
        Object.assign(d, {
            respawn: async () => ({ host: false }),
            reattachAgents: () => ({ attempted: 2, revived: 2 }),
        });

        expect(await recoverFromHostLoss(d)).toBe('degraded');
    });

    it('tolerates a reattachAgents that reports nothing, as it used to', async () => {
        // The old signature returned void. A caller that has not been updated
        // must not make recovery claim a failure it did not observe.
        const { d } = deps();
        Object.assign(d, { reattachAgents: () => undefined });

        expect(await recoverFromHostLoss(d)).toBe('recovered');
    });

    it('a THROWING revival is degraded, not silently recovered', async () => {
        // It was already caught so one failure could not sink the rest. Caught is
        // right; calling the result "recovered" afterwards is not.
        const { d } = deps();
        Object.assign(d, {
            reattachAgents: () => {
                throw new Error('revival blew up');
            },
        });

        expect(await recoverFromHostLoss(d)).toBe('degraded');
    });
});
