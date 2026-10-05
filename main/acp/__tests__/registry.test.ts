import { describe, expect, it } from 'vitest';
import { AcpRegistry, terminalIsLive, writeRefusal } from '../registry';

/**
 * The seam that makes an ACP session a first-class Genie agent.
 *
 * `isTerminalLive` is imported by the roster, the agent cap, drain, triage,
 * `savedAgentsOf` and `runAgent`. An ACP session has no pty, so without this it reads as
 * DEAD in all of them at once — and that is not a cosmetic bug: drain would let an upgrade
 * proceed over a working agent, and triage would prescribe a restart for something that is
 * running fine.
 */

describe('AcpRegistry', () => {
    const entry = () => ({ kill: () => {}, closed: false });

    it('reports a registered session as live', () => {
        const r = new AcpRegistry();
        r.register('s1', entry());
        expect(r.isLive('s1')).toBe(true);
    });

    it('reports an unknown spec as not live', () => {
        expect(new AcpRegistry().isLive('s1')).toBe(false);
    });

    it('stops reporting live once the channel has CLOSED', () => {
        // A registered entry whose channel died is not live. Reporting it live hides a dead
        // agent behind a healthy-looking roster row.
        const r = new AcpRegistry();
        const e = { kill: () => {}, closed: false };
        r.register('s1', e);
        e.closed = true;
        expect(r.isLive('s1')).toBe(false);
    });

    it('forgets a session on unregister', () => {
        const r = new AcpRegistry();
        r.register('s1', entry());
        r.unregister('s1');
        expect(r.isLive('s1')).toBe(false);
    });

    it('kills the child when asked, and forgets it', () => {
        let killed = 0;
        const r = new AcpRegistry();
        r.register('s1', { kill: () => (killed += 1), closed: false });
        r.stop('s1');
        expect(killed).toBe(1);
        expect(r.isLive('s1')).toBe(false);
    });

    it('is safe to stop something it is not holding', () => {
        // Called from teardown paths that cannot know which engine an agent used.
        expect(() => new AcpRegistry().stop('ghost')).not.toThrow();
    });

    it('lists live sessions only', () => {
        const r = new AcpRegistry();
        r.register('live', entry());
        r.register('dead', { kill: () => {}, closed: true });
        expect(r.liveSpecIds()).toEqual(['live']);
    });

    it('replaces an entry for a reused spec id rather than stacking two', () => {
        // Spec ids are reused across restarts ON PURPOSE — that reuse is what carries an
        // agent's AgentInbox identity. Two entries for one id would leak the first child
        // with nothing holding a handle to it.
        let firstKilled = 0;
        const r = new AcpRegistry();
        r.register('s1', { kill: () => (firstKilled += 1), closed: false });
        r.register('s1', entry());
        expect(firstKilled).toBe(1);
        expect(r.liveSpecIds()).toEqual(['s1']);
    });
});

describe('terminalIsLive', () => {
    it('is live when the pty is', () => {
        expect(terminalIsLive('s1', { ptyLive: () => true, acpLive: () => false })).toBe(true);
    });

    it('is live when the ACP session is, with no pty at all', () => {
        // The whole point: everything downstream keeps working unchanged.
        expect(terminalIsLive('s1', { ptyLive: () => false, acpLive: () => true })).toBe(true);
    });

    it('is dead only when NEITHER is', () => {
        expect(terminalIsLive('s1', { ptyLive: () => false, acpLive: () => false })).toBe(false);
    });

    it('asks the pty FIRST, so the common case costs nothing extra', () => {
        let acpAsked = 0;
        terminalIsLive('s1', {
            ptyLive: () => true,
            acpLive: () => {
                acpAsked += 1;
                return false;
            },
        });
        expect(acpAsked).toBe(0);
    });
});

describe('writeRefusal', () => {
    it('allows a write to a pty agent', () => {
        expect(writeRefusal('pty')).toBeNull();
    });

    it('REFUSES a keystroke write to an ACP session, and names what to do instead', () => {
        // There is no input box to type into. A silent no-op would look like the agent
        // ignoring the message — the exact failure the pty settle-and-confirm dance was
        // built to detect and still could only call "we could not check".
        const refusal = writeRefusal('acp');
        expect(refusal).toBeTruthy();
        expect(refusal).toMatch(/prompt/i);
    });
});
