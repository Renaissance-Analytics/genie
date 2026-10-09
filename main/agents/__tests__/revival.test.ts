import { describe, expect, it } from 'vitest';
import { agentsToRevive } from '../revival';

describe('agentsToRevive', () => {
    const running = { id: 'running', type: 'terminal', workspace_id: 'ws', meta: { agent: 'claude', agent_id: 'a', was_running: true } };
    it.each([
        ['stopped', { ...running, id: 'skip', meta: { ...running.meta, user_stopped: true } }],
        ['never ran', { ...running, id: 'skip', meta: { ...running.meta, was_running: undefined } }],
        ['exited', { ...running, id: 'skip', meta: { ...running.meta, was_running: false } }],
        ['operator', { ...running, id: 'skip', meta: { ...running.meta, agent_id: 'genie:workstation' } }],
        ['plain shell', { ...running, id: 'skip', meta: { was_running: true } }],
    ])('skips %s and still revives the running agent', (_name, skipped) => {
        expect(agentsToRevive([skipped, running]).map(s => s.id)).toEqual(['running']);
    });
});

/**
 * NOT ON A COLD BOOT — the owner's ruling, 2026-10-09, after a reboot brought every agent
 * back working with no window to reach them through:
 *
 *   "No more forced terminals on reboot?"
 *
 * The filter above answers "is this agent restorable". It never answered "SHOULD we restore
 * it right now", and `reviveRunningAgents()` ran unconditionally at boot, so the two
 * questions were one and the answer was always yes.
 *
 * They are separated here because the two callers are genuinely different events:
 *
 *  - LAUNCH — a cold boot or an upgrade. Nobody asked for anything. Default: restore
 *    nothing, because an agent that starts itself while you are not looking is the whole
 *    complaint.
 *  - HOST RECOVERY — the detached pty host died mid-session while you were working. The
 *    agents were running a second ago and you never stopped them; putting them back is
 *    repairing a fault, not making a decision. That must keep working, opt-in or not.
 */
describe('restoring on LAUNCH is opt-in', () => {
    const running = {
        id: 's1',
        type: 'terminal',
        workspace_id: 'w1',
        meta: { agent: 'claude', agent_id: 'a1', was_running: true },
    };

    it('restores NOTHING on launch by default', () => {
        expect(agentsToRevive([running], { onLaunch: true, optedIn: false })).toEqual([]);
    });

    it('POSITIVE CONTROL: the same spec restores when the user opted in', () => {
        // Without this, the test above also passes against a filter that rejects this spec
        // for some unrelated reason — which would make the opt-in look like it works while
        // nothing could ever be restored.
        expect(agentsToRevive([running], { onLaunch: true, optedIn: true })).toHaveLength(1);
    });

    it('ALWAYS restores for host recovery, opted in or not', () => {
        // A fault repaired mid-session, not a decision made on your behalf.
        expect(agentsToRevive([running], { onLaunch: false, optedIn: false })).toHaveLength(1);
    });

    it('defaults to restoring when asked nothing, so existing callers are unchanged', () => {
        // The host-recovery call site passes no options today. Treating "unspecified" as a
        // launch would silently disable the repair, which is the opposite failure.
        expect(agentsToRevive([running])).toHaveLength(1);
    });

    it('still refuses a spec the base rule rejects, even when opted in', () => {
        // Opting in says "restore what was running", not "restore anything".
        const stopped = { ...running, meta: { ...running.meta, user_stopped: true } };
        expect(agentsToRevive([stopped], { onLaunch: true, optedIn: true })).toEqual([]);
    });
});
