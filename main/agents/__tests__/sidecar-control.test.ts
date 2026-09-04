import { describe, expect, it } from 'vitest';
import { sidecarActions, sidecarsOf, type SidecarSubject } from '../sidecar-control';

/**
 * Finding an agent's sidecars so a human can start, stop and restart them
 * (Tynn #709).
 *
 * The design of record says to prefer `workspace_agents.parent_agent_id` over
 * the `<driver>-slave` name convention, because "a rule that keys on a name is
 * one rename away from leaking". Correct — but the column CANNOT be the sole
 * discriminator today, and that is the finding these tests pin.
 *
 * `registerAgentInWorkspace` writes `parent_agent_id: workspaceDefaultAgent(ws.id)?.id`
 * for EVERY agent it registers. So in any workspace that has a Workspace Agent —
 * which is every workspace seeded since genie#324 — every ordinary agent already
 * carries an FK pointing at the TWA. Keying sidecar identity on the FK alone
 * would make the TWA the parent of the entire roster, and a human aiming "Stop
 * the sidecar" would stop a colleague's agent.
 *
 * So the rule is: a row is a sidecar of this driver when it IS a sidecar at all
 * (the suffix) AND the driver owns it (the FK, or failing that the name). The FK
 * is what lets a RENAMED sidecar still be found — which is the leak the design
 * was worried about — while the suffix is what stops the FK's current overload
 * from swallowing the roster. Re-pointing the column at real sidecar ownership
 * is #708's migration, and this resolver keeps working after it.
 */

const driver: SidecarSubject = { id: 'a-moic', name: 'moic', parent_agent_id: null };

describe('sidecarsOf', () => {
    it('finds a sidecar by the name convention', () => {
        const roster: SidecarSubject[] = [
            driver,
            { id: 'a-slave', name: 'moic-slave', parent_agent_id: null },
        ];
        expect(sidecarsOf(driver, roster).map((a) => a.id)).toEqual(['a-slave']);
    });

    it('PREFERS the FK: finds a sidecar the driver owns under a different name', () => {
        // The whole reason to key on the column. A sidecar renamed
        // `moic-codex-slave` is invisible to a name-only rule.
        const roster: SidecarSubject[] = [
            driver,
            { id: 'a-slave', name: 'moic-codex-slave', parent_agent_id: 'a-moic' },
        ];
        expect(sidecarsOf(driver, roster).map((a) => a.id)).toEqual(['a-slave']);
    });

    it('does NOT adopt an ordinary agent whose FK points at this one', () => {
        // The bug an FK-only rule would ship TODAY. `registerAgentInWorkspace`
        // sets parent_agent_id to the workspace's default agent for every agent
        // it registers, so `fancy` legitimately carries moic's id while being
        // nobody's sidecar.
        const roster: SidecarSubject[] = [
            driver,
            { id: 'a-fancy', name: 'fancy', parent_agent_id: 'a-moic' },
            { id: 'a-slave', name: 'moic-slave', parent_agent_id: 'a-moic' },
        ];
        const found = sidecarsOf(driver, roster);
        expect(found.map((a) => a.id)).toEqual(['a-slave']);
        // POSITIVE CONTROL for the line above: the resolver did find something
        // in this roster, so "fancy is absent" is not passing on an empty result.
        expect(found).toHaveLength(1);
    });

    it('does not steal another driver’s sidecar', () => {
        const roster: SidecarSubject[] = [
            driver,
            { id: 'a-other', name: 'tynn-slave', parent_agent_id: 'a-tynn' },
        ];
        expect(sidecarsOf(driver, roster)).toEqual([]);
    });

    it('never matches on a prefix', () => {
        // `tynnbuilder` is its own agent and must not be stopped as `tynn`'s.
        const tynn: SidecarSubject = { id: 'a-tynn', name: 'tynn', parent_agent_id: null };
        const roster: SidecarSubject[] = [
            tynn,
            { id: 'a-b', name: 'tynnbuilder', parent_agent_id: null },
            { id: 'a-bs', name: 'tynnbuilder-slave', parent_agent_id: null },
        ];
        expect(sidecarsOf(tynn, roster).map((a) => a.id)).toEqual([]);
    });

    it('a sidecar has no sidecar of its own', () => {
        const slave: SidecarSubject = {
            id: 'a-slave',
            name: 'moic-slave',
            parent_agent_id: 'a-moic',
        };
        const roster: SidecarSubject[] = [driver, slave];
        expect(sidecarsOf(slave, roster)).toEqual([]);
    });

    it('never returns the driver itself', () => {
        expect(sidecarsOf(driver, [driver])).toEqual([]);
    });

    it('finds more than one when a driver has more than one', () => {
        const roster: SidecarSubject[] = [
            driver,
            { id: 'a-1', name: 'moic-slave', parent_agent_id: null },
            { id: 'a-2', name: 'moic-cursor-slave', parent_agent_id: 'a-moic' },
        ];
        expect(sidecarsOf(driver, roster).map((a) => a.id).sort()).toEqual(['a-1', 'a-2']);
    });
});

describe('sidecarActions', () => {
    // What the buttons may do, so a running sidecar cannot be "started" into a
    // second copy and a dormant one cannot be "stopped" into an error.
    it('offers only Start when the sidecar is dormant', () => {
        expect(sidecarActions({ exists: true, running: false })).toEqual(['start']);
    });

    it('offers Stop and Restart when it is running', () => {
        expect(sidecarActions({ exists: true, running: true })).toEqual(['stop', 'restart']);
    });

    it('offers nothing when there is no sidecar', () => {
        // A control that acts on nothing is worse than an absent one: it looks
        // like it did something.
        expect(sidecarActions({ exists: false, running: false })).toEqual([]);
    });
});
