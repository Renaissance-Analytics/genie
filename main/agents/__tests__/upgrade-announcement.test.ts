import { describe, expect, it, vi } from 'vitest';
import {
    AGENT_UPGRADE_NUDGE_INTERVAL_MS,
    announceAgentUpgrade,
    formatAgentUpgradeMessage,
    withWorkstationOperator,
} from '../upgrade-announcement';
import { GENIE_OS_AGENT } from '../os-agent';

/**
 * The stagger's scheduler seam, driven SYNCHRONOUSLY (genie#353). Tests drive
 * the clock; they never sleep, so a dozen agents cost nothing instead of 15s
 * each.
 */
const runNow = (run: () => void): void => run();

describe('agent upgrade announcement', () => {
    it('formats a concise no-reply system message', () => {
        expect(formatAgentUpgradeMessage('0.8.0', ['Native AgentInbox transport', 'What’s New menu'])).toBe(
            'Genie upgraded to v0.8.0. What changed:\n- Native AgentInbox transport\n- What’s New menu\n\nIf this terminal predates AMS, call agentUpgrade now and follow its ordered migration guide.\n\nThis is a system notice; no reply is needed.',
        );
    });

    it('sends once to every registered agent after a version change', () => {
        const send = vi.fn(() => true);
        const persist = vi.fn();

        expect(announceAgentUpgrade({
            currentVersion: '0.8.0',
            previousVersion: '0.7.9',
            agents: [
                { agentId: 'a-tynn', name: 'tynn-builder' },
                { agentId: 'a-front', name: 'frontend' },
            ],
            changes: ['Native inbox delivery'],
            send,
            persist,
            schedule: runNow,
        })).toBe(2);

        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenNthCalledWith(1, 'a-tynn', expect.stringContaining('no reply is needed'));
        expect(send).toHaveBeenNthCalledWith(2, 'a-front', expect.stringContaining('no reply is needed'));
        expect(persist).toHaveBeenCalledWith('0.8.0');
    });

    it('does nothing when this version was already announced', () => {
        const send = vi.fn(() => true);
        const persist = vi.fn();
        expect(announceAgentUpgrade({
            currentVersion: '0.8.0',
            previousVersion: '0.8.0',
            agents: [{ agentId: 'a-tynn', name: 'tynn-builder' }],
            changes: [],
            send,
            persist,
        })).toBe(0);
        expect(send).not.toHaveBeenCalled();
        expect(persist).not.toHaveBeenCalled();
    });
});

/**
 * An agent named `general` is NEVER nudged (Tynn story #262).
 *
 * The owner's rule: *"No agents named general get any nudges or anything so
 * they don't start doing work on restart if any still exist."*
 *
 * v62 removes the DORMANT `general` agents, but three on this workstation hold
 * a live terminal and are deliberately left alone. Those survivors must not be
 * woken by the upgrade announcement — a nudge lands in a TUI and starts a turn,
 * which is precisely what must not happen to an agent nobody meant to create.
 *
 * The RECONNECT is covered too, not just the message. It types a command into
 * the agent's terminal, so a reconnect without a notice is still a nudge — and
 * it runs FIRST, so excluding only the message would wake the agent anyway.
 */
describe('an agent named `general` is never nudged', () => {
    const base = {
        currentVersion: '0.8.0',
        previousVersion: '0.7.9',
        changes: ['Native inbox delivery'],
        schedule: runNow,
    };

    it('is not sent the upgrade notice', () => {
        const send = vi.fn(() => true);
        const persist = vi.fn();

        const sent = announceAgentUpgrade({
            ...base,
            agents: [
                { agentId: 'a-general', name: 'general' },
                { agentId: 'a-real', name: 'frontend' },
            ],
            send,
            persist,
        });

        expect(sent).toBe(1);
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith('a-real', expect.any(String));
    });

    it('is not RECONNECTED either — that types into its terminal', () => {
        const reconnect = vi.fn();

        announceAgentUpgrade({
            ...base,
            agents: [
                { agentId: 'a-general', name: 'general' },
                { agentId: 'a-real', name: 'frontend' },
            ],
            send: () => true,
            reconnect,
            persist: vi.fn(),
        });

        expect(reconnect).toHaveBeenCalledTimes(1);
        expect(reconnect).toHaveBeenCalledWith('a-real');
    });

    it('still records the version when every agent was skipped', () => {
        // Otherwise a workstation whose only agents are `general` would re-run
        // the announcement on every single boot, forever.
        const persist = vi.fn();

        const sent = announceAgentUpgrade({
            ...base,
            agents: [{ agentId: 'a-general', name: 'general' }],
            send: () => true,
            persist,
        });

        expect(sent).toBe(0);
        expect(persist).toHaveBeenCalledWith('0.8.0');
    });

    it('matches the WHOLE name — `general-purpose` is a real agent and IS nudged', () => {
        const send = vi.fn(() => true);

        announceAgentUpgrade({
            ...base,
            agents: [{ agentId: 'a-gp', name: 'general-purpose' }],
            send,
            persist: vi.fn(),
        });

        expect(send).toHaveBeenCalledWith('a-gp', expect.any(String));
    });
});

/**
 * genie#353 — the nudges are STAGGERED, not fired in one tick.
 *
 * Every nudge starts a model turn, and a woken agent's first move is
 * `agentinbox receive` plus `connectToGenie` — against an MCP server whose
 * process was just replaced by the upgrade (#346). A dozen agents woken in the
 * same tick is a thundering herd at the worst possible moment.
 *
 * The scheduler is an injected SEAM rather than an `await`: `announceAgentUpgrade`
 * stays synchronous and returns a count, which is what makes it testable at all.
 */
describe('upgrade nudges are staggered (genie#353)', () => {
    const base = {
        currentVersion: '0.8.0',
        previousVersion: '0.7.9',
        changes: ['Native inbox delivery'],
    };
    const fleet = [
        { agentId: 'a-one', name: 'one' },
        { agentId: 'a-two', name: 'two' },
        { agentId: 'a-three', name: 'three' },
    ];

    /** A scheduler that records instead of running — the test IS the clock. */
    const recorder = () => {
        const queue: { delayMs: number; run: () => void }[] = [];
        return {
            queue,
            schedule: (run: () => void, delayMs: number) => {
                queue.push({ delayMs, run });
            },
            /** Fire everything due, in the order it was scheduled. */
            drain: () => queue.splice(0).forEach((entry) => entry.run()),
        };
    };

    it('is a named constant, ~15s, not a magic number', () => {
        expect(AGENT_UPGRADE_NUDGE_INTERVAL_MS).toBe(15_000);
    });

    it('spaces the sends by the interval instead of firing them all at once', () => {
        const clock = recorder();
        const send = vi.fn((_agentId: string, _text: string) => true);

        announceAgentUpgrade({ ...base, agents: fleet, send, persist: vi.fn(), schedule: clock.schedule });

        // The first agent goes now; nothing else has been woken yet.
        expect(send).toHaveBeenCalledTimes(1);
        expect(clock.queue.map((entry) => entry.delayMs)).toEqual([
            AGENT_UPGRADE_NUDGE_INTERVAL_MS,
            AGENT_UPGRADE_NUDGE_INTERVAL_MS * 2,
        ]);

        // POSITIVE CONTROL: "they were spaced out" passes just as well against a
        // function that sent nothing. Drive the clock and check all three land.
        clock.drain();
        expect(send.mock.calls.map((call) => call[0])).toEqual(['a-one', 'a-two', 'a-three']);
    });

    it('keeps reconnect → send paired per agent, never interleaved', () => {
        // ORDER IS THE POINT. A notice that lands first is read with dead tools —
        // so staggering must not let one agent's reconnect race another's send.
        const clock = recorder();
        const order: string[] = [];

        announceAgentUpgrade({
            ...base,
            agents: fleet,
            reconnect: (agentId) => order.push(`reconnect:${agentId}`),
            send: (agentId) => {
                order.push(`send:${agentId}`);
                return true;
            },
            persist: vi.fn(),
            schedule: clock.schedule,
        });
        clock.drain();

        expect(order).toEqual([
            'reconnect:a-one', 'send:a-one',
            'reconnect:a-two', 'send:a-two',
            'reconnect:a-three', 'send:a-three',
        ]);
    });

    it('persists the version ONCE, without waiting for the last agent', () => {
        // A crash mid-stagger must not re-announce the whole fleet on next boot.
        const clock = recorder();
        const persist = vi.fn();

        announceAgentUpgrade({ ...base, agents: fleet, send: () => true, persist, schedule: clock.schedule });

        expect(persist).toHaveBeenCalledTimes(1);
        expect(persist).toHaveBeenCalledWith('0.8.0');

        clock.drain();
        expect(persist).toHaveBeenCalledTimes(1);
    });

    it('counts the agents it will nudge, not just the one it already sent', () => {
        const clock = recorder();

        expect(
            announceAgentUpgrade({ ...base, agents: fleet, send: () => true, persist: vi.fn(), schedule: clock.schedule }),
        ).toBe(3);
    });
});

/**
 * genie#352 — the workstation operator is in the audience by construction.
 *
 * The audience was `agentInboxBroker.directory().filter(status !== 'offline')`,
 * and the OSA is not in that directory at boot. So the ONE broadcast that exists
 * to tell agents the ground moved under them reached every agent except the one
 * whose job is the machine.
 */
describe('the OSA is always in the upgrade audience (genie#352)', () => {
    it('adds the workstation operator when the directory does not report it', () => {
        expect(withWorkstationOperator([{ agentId: 'a-front', name: 'frontend' }])).toEqual([
            { agentId: 'a-front', name: 'frontend' },
            { agentId: GENIE_OS_AGENT.id, name: GENIE_OS_AGENT.name },
        ]);
    });

    it('does not nudge it twice when the directory DOES report it', () => {
        const reported = [{ agentId: GENIE_OS_AGENT.id, name: 'genie' }];

        expect(withWorkstationOperator(reported)).toEqual(reported);
    });

    it('POSITIVE CONTROL — every other agent is kept, in order', () => {
        // Otherwise "the OSA is there" passes against a function that returns
        // only the OSA and drops the whole fleet.
        const fleet = [
            { agentId: 'a-one', name: 'one' },
            { agentId: 'a-two', name: 'two' },
        ];

        expect(withWorkstationOperator(fleet).slice(0, 2)).toEqual(fleet);
    });

    it('gets the notice even though it is not a directory agent', () => {
        const send = vi.fn(() => true);

        announceAgentUpgrade({
            currentVersion: '0.8.0',
            previousVersion: '0.7.9',
            changes: [],
            agents: withWorkstationOperator([{ agentId: 'a-front', name: 'frontend' }]),
            send,
            persist: vi.fn(),
            schedule: runNow,
        });

        expect(send).toHaveBeenCalledWith(GENIE_OS_AGENT.id, expect.stringContaining('Genie upgraded'));
    });
});
