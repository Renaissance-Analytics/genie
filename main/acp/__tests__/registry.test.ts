import { describe, expect, it } from 'vitest';
import { AcpRegistry, terminalIsLive, writeRefusal, type AcpSessionEntry } from '../registry';

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
    const entry = () => ({
        kill: () => {},
        closed: false,
        prompt: async () => ({ delivered: true, submitted: true }),
        cancel: async () => ({ honoured: true }),
        decide: () => {},
    });

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
        const e = { kill: () => {}, closed: false, prompt: async () => ({ delivered: true, submitted: true }), cancel: async () => ({ honoured: true }), decide: () => {} };
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
        r.register('s1', { kill: () => void (killed += 1), closed: false, prompt: async () => ({ delivered: true, submitted: true }), cancel: async () => ({ honoured: true }), decide: () => {} });
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
        r.register('dead', { kill: () => {}, closed: true, prompt: async () => ({ delivered: true, submitted: true }), cancel: async () => ({ honoured: true }), decide: () => {} });
        expect(r.liveSpecIds()).toEqual(['live']);
    });

    it('replaces an entry for a reused spec id rather than stacking two', () => {
        // Spec ids are reused across restarts ON PURPOSE — that reuse is what carries an
        // agent's AgentInbox identity. Two entries for one id would leak the first child
        // with nothing holding a handle to it.
        let firstKilled = 0;
        const r = new AcpRegistry();
        r.register('s1', { kill: () => void (firstKilled += 1), closed: false, prompt: async () => ({ delivered: true, submitted: true }), cancel: async () => ({ honoured: true }), decide: () => {} });
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

/**
 * SENDING a prompt to an ACP session — the write path.
 *
 * `AcpSessionDriver.prompt()` existed, was tested, and **had no production caller**, exactly
 * like `applySessionUpdate` before it. So an ACP agent could be started and observed and
 * could not be TALKED TO — and `writeRefusal`, which exists to explain that, had no caller
 * either, so a write went to a pty that was not there and reported nothing.
 *
 * That was survivable only while ACP was opt-in. The owner has since made it the mechanism
 * (*"acp is the core of our agent communications, this is not optional"*), which means every
 * Claude agent takes this path — and without it every one of them is unreachable, silently.
 * Wiring it is a precondition of that change landing, not a follow-up to it.
 */
describe('the write path', () => {
    const entry = (over: Partial<AcpSessionEntry> = {}): AcpSessionEntry => ({
        kill: () => {},
        closed: false,
        prompt: async () => ({ delivered: true, submitted: true }),
        cancel: async () => ({ honoured: true }),
        decide: () => {},
        ...over,
    });

    it('hands back a prompt function for a registered session', () => {
        const r = new AcpRegistry();
        r.register('spec-1', entry());
        expect(r.promptFor('spec-1')).toBeTypeOf('function');
    });

    it('hands back nothing for a spec it does not hold — a PTY agent', () => {
        // The discriminator for the whole branch: most agents are pty agents, and the
        // absence of an entry is how the write path stays exactly as it was for them.
        expect(new AcpRegistry().promptFor('spec-pty')).toBeNull();
    });

    it('hands back nothing once the channel has CLOSED', () => {
        // Prompting a dead channel would hang or throw inside a tool call. A closed entry is
        // not a session, which is the same rule `isLive` already holds to.
        const r = new AcpRegistry();
        r.register('spec-1', entry({ closed: true }));
        expect(r.promptFor('spec-1')).toBeNull();
    });

    it('hands back nothing after the session is stopped', () => {
        const r = new AcpRegistry();
        r.register('spec-1', entry());
        r.stop('spec-1');
        expect(r.promptFor('spec-1')).toBeNull();
    });

    it('reports delivered AND submitted — the first time Genie can say so honestly', () => {
        // The pty path could only ever say "we could not check": it wrote bytes and watched
        // for a reaction. An ACP agent ACKNOWLEDGES the call, so both are earned.
        const r = new AcpRegistry();
        r.register('spec-1', entry());
        return expect(r.promptFor('spec-1')!('hello')).resolves.toEqual({
            delivered: true,
            submitted: true,
        });
    });
});

describe('writeRefusal — raw writes, once there is a prompt path', () => {
    it('refuses a raw write to an ACP session, and says what to do instead', () => {
        // Still needed with the prompt path wired: `terminal:write` and friends send
        // KEYSTROKES, which an ACP session has nowhere to put. The refusal is the difference
        // between "nothing happened" and "nothing happened, send a prompt instead".
        expect(writeRefusal('acp')).toMatch(/structured ACP session/i);
        expect(writeRefusal('acp')).toMatch(/prompt/i);
    });

    it('does not refuse a pty write', () => {
        expect(writeRefusal('pty')).toBeNull();
    });
});
