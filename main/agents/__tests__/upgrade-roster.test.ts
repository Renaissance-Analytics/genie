import { describe, expect, it, vi } from 'vitest';
import { upgradeRosterPlan } from '../drain';
import {
    planRestoreNotice,
    restoreEntryIsRunning,
    type DrainRestoreEntry,
    type DrainRestoreOutcome,
} from '../drain-restore';

/**
 * THE RESTORE LIST IS WRITTEN BY THE UPGRADE, NOT BY THE DRAIN (genie#551).
 *
 * genie#389 built the roster inside `beginUpgradeDrain`, which made "we recorded
 * what was running" a consequence of "we decided to nudge the agents". Those are
 * different questions, and the gate that answers the second answers it with
 * `describeRestartInterruption()` — a probe of *what the installer swap tears
 * down*, which is deliberately ZERO whenever the pty host is expected to survive
 * (a service host, or a detached host on the standalone Node runtime, which is
 * the default once the OS service is unavailable).
 *
 * So on those machines `restartPlanForUpgrade` reads "0 live agents", plans
 * `apply`, and `beginUpgradeDrain` never runs — no roster is ever written, and
 * the whole restore half of genie#389 has nothing to restore. When the host then
 * does NOT survive, every running agent is gone and unrecorded, which is exactly
 * the owner's report: *"Agents don't restart after an upgrade if they are
 * forcefully shutdown unless I click on their workspace."*
 *
 * The fix is not to drain more. It is that RECORDING is unconditional on the
 * apply path, and the drain's own recording is the special case that must not be
 * overwritten.
 */

describe('upgradeRosterPlan', () => {
    it('RECORDS a fresh roster when the upgrade applies without a drain', () => {
        // The bug. A surviving-host machine never drains, so this is the only
        // chance the restore list gets to exist at all.
        expect(upgradeRosterPlan({ drainCleared: false })).toBe('record');
    });

    it('KEEPS the drain\'s roster when a drain already cleared', () => {
        // The drain writes its roster BEFORE the first nudge, deliberately, so
        // it is the snapshot of what was running. By the time the drain has
        // cleared those agents have stopped — re-recording here would replace a
        // correct list with an empty one, which is worse than not recording.
        expect(upgradeRosterPlan({ drainCleared: true })).toBe('keep');
    });
});

const outcome = (over: Partial<DrainRestoreOutcome> = {}): DrainRestoreOutcome => ({
    entry: { kind: 'agent', ref: 'ws1:moic', label: 'moic', workspaceId: 'ws1' },
    status: 'started',
    at: 0,
    ...over,
});

/**
 * A RESTORE THAT FAILED MUST SAY SO (genie#551, second defect).
 *
 * The restore reported every non-`started` outcome to `console.log` and nowhere
 * else, so an agent that did not come back was invisible unless somebody read
 * the main-process log. That is why this bug needed a human to notice at all.
 *
 * A SKIP is not a failure — "you stopped it" and "it is already running" are
 * decisions the restore made correctly, and toasting them would train the user
 * to dismiss the one that matters.
 */
describe('planRestoreNotice', () => {
    it('says nothing when everything came back', () => {
        expect(
            planRestoreNotice([outcome(), outcome({ entry: { kind: 'site', ref: 's', label: 'web', workspaceId: 'ws1' } })]),
        ).toBeNull();
    });

    it('says nothing about a SKIP — a deliberate decision is not a failure', () => {
        expect(
            planRestoreNotice([
                outcome({ status: 'skipped', reason: 'You stopped it. An upgrade is not a reason to undo that.' }),
                outcome({ status: 'skipped', reason: 'It is already running.' }),
            ]),
        ).toBeNull();
    });

    it('names the ONE thing that did not come back, and why', () => {
        const notice = planRestoreNotice([
            outcome(),
            outcome({
                entry: { kind: 'agent', ref: 'ws1:hand', label: 'hand', workspaceId: 'ws1' },
                status: 'failed',
                reason: 'the agent could not be started',
            }),
        ]);
        expect(notice).not.toBeNull();
        expect(notice!.title).toContain('hand');
        expect(notice!.body).toContain('the agent could not be started');
    });

    it('counts them when several failed, and still names each one', () => {
        const notice = planRestoreNotice([
            outcome({ entry: { kind: 'agent', ref: 'a', label: 'moic', workspaceId: 'ws1' }, status: 'failed', reason: 'no terminal' }),
            outcome({ entry: { kind: 'site', ref: 'b', label: 'web', workspaceId: 'ws1' }, status: 'failed', reason: 'port in use' }),
            outcome({ entry: { kind: 'process', ref: 'c', label: 'queue', workspaceId: 'ws1' }, status: 'failed', reason: 'no such spec' }),
        ]);
        expect(notice!.title).toContain('3');
        expect(notice!.body).toContain('moic');
        expect(notice!.body).toContain('web');
        expect(notice!.body).toContain('queue');
    });

    it('does not let a huge roster produce an unreadable toast', () => {
        const many = Array.from({ length: 12 }, (_, i) =>
            outcome({
                entry: { kind: 'agent', ref: `a${i}`, label: `agent-${i}`, workspaceId: 'ws1' },
                status: 'failed',
                reason: 'nope',
            }),
        );
        const notice = planRestoreNotice(many);
        expect(notice!.title).toContain('12');
        // Every failure is COUNTED; only the first few are listed by name, and
        // the remainder is a number rather than twelve lines of toast.
        expect(notice!.body.split('\n')).toHaveLength(5);
        expect(notice!.body).toContain('agent-0');
        expect(notice!.body).toContain('8 more');
    });
});

/**
 * IS THIS ROSTER ENTRY ALREADY UP? (genie#551)
 *
 * The roster is now written on EVERY upgrade apply, not only a drained one — so
 * the common case is an upgrade whose pty host survived, where every entry on
 * the list is still running and the restore has nothing to do. It has to be able
 * to SAY that.
 *
 * Agents were exempted from this question ("`startRegisteredAgent` reattaches to
 * a live agent rather than minting a second one, so an agent needs no equivalent
 * check"). That reasoning is right about correctness and wrong about cost: a
 * warm reattach is a no-op that still counts as a START, so it spends the 3s
 * inter-start gap — and on a surviving-host upgrade that is the entire roster,
 * delaying the site resume behind a queue of no-ops.
 */
describe('restoreEntryIsRunning', () => {
    const entry = (kind: DrainRestoreEntry['kind'], ref: string): DrainRestoreEntry => ({
        kind,
        ref,
        label: ref,
        workspaceId: 'ws1',
    });
    const probes = (over: Partial<Parameters<typeof restoreEntryIsRunning>[1]> = {}) => ({
        agentIsLive: () => false,
        siteIsRunning: () => false,
        processIsRunning: () => false,
        ...over,
    });

    it('says an AGENT whose terminal is still live is already running', () => {
        const agentIsLive = vi.fn().mockReturnValue(true);
        expect(restoreEntryIsRunning(entry('agent', 'ws1:moic'), probes({ agentIsLive }))).toBe(true);
        expect(agentIsLive).toHaveBeenCalledWith('ws1:moic', 'ws1');
    });

    it('says an AGENT whose terminal died is NOT running — the positive control', () => {
        // Without this, "is it running" answering `true` for everything would
        // pass the test above and restore nothing at all.
        expect(restoreEntryIsRunning(entry('agent', 'ws1:moic'), probes())).toBe(false);
    });

    it('asks each kind its OWN probe, never another kind\'s', () => {
        // A site id and a process spec id are different namespaces; one shared
        // lookup is how a live process silently suppresses a dead site.
        const agentIsLive = vi.fn().mockReturnValue(false);
        const siteIsRunning = vi.fn().mockReturnValue(false);
        const processIsRunning = vi.fn().mockReturnValue(false);
        const p = probes({ agentIsLive, siteIsRunning, processIsRunning });

        restoreEntryIsRunning(entry('site', 'ws1/web'), p);
        expect(siteIsRunning).toHaveBeenCalledWith('ws1/web');
        expect(processIsRunning).not.toHaveBeenCalled();
        expect(agentIsLive).not.toHaveBeenCalled();

        restoreEntryIsRunning(entry('process', 'proc-queue'), p);
        expect(processIsRunning).toHaveBeenCalledWith('proc-queue');
        expect(siteIsRunning).toHaveBeenCalledTimes(1);
    });

    it('treats a probe that THROWS as "not running" — the direction that restores', () => {
        // Unknown must not become "everything is up", which is a restore that
        // silently does nothing. The cost of being wrong the other way is one
        // redundant start, and for an agent that start is a warm reattach.
        const agentIsLive = vi.fn(() => {
            throw new Error('the database is locked');
        });
        expect(restoreEntryIsRunning(entry('agent', 'ws1:moic'), probes({ agentIsLive }))).toBe(
            false,
        );
    });
});
