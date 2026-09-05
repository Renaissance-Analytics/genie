import { describe, expect, it, vi } from 'vitest';
import {
    AGENT_UPGRADE_NUDGE_INTERVAL_MS,
    AGENT_UPGRADE_TRANSPORT_GRACE_MS,
    announceAgentUpgrade,
    formatAgentUpgradeMessage,
    withWorkstationOperator,
} from '../upgrade-announcement';
import { MANUAL_RECONNECT_NOTICE, type McpRecovery } from '../mcp-reconnect';
import { upgradeNoticeMode } from '../agent-mode';
import { GENIE_OS_AGENT } from '../os-agent';

/** The recovery a Claude terminal gets when the reconnect command actually ran. */
const RECONNECTED: McpRecovery = {
    strategy: { kind: 'command', text: '/mcp reconnect genie' },
    applied: true,
};

/**
 * The stagger's scheduler seam, driven SYNCHRONOUSLY (genie#353). Tests drive
 * the clock; they never sleep, so a dozen agents cost nothing instead of 15s
 * each.
 */
const runNow = (run: () => void): void => run();

describe('agent upgrade announcement', () => {
    it('formats a concise no-reply system message, ending in the mode clause', () => {
        // The mode clause is LAST and is the ONLY part that differs between an
        // Automated and a Manual agent (genie#408): the facts, the recovery and
        // the migration step are identical for both, because the mode is
        // guidance on how to read the notice and not a boundary on what may
        // be told.
        expect(
            formatAgentUpgradeMessage(
                '0.8.0',
                ['Native AgentInbox transport', 'What’s New menu'],
                RECONNECTED,
                'manual',
            ),
        ).toBe(
            'Genie upgraded to v0.8.0. What changed:\n- Native AgentInbox transport\n- What’s New menu\n\n' +
            'Your `genie` MCP connection was replaced by the upgrade, so its tools do not answer until it is restored. ' +
            'Genie ran `/mcp reconnect genie` in this terminal to restore it. If `genie` still does not answer, run it again yourself.\n\n' +
            'Once `genie` answers again: if this terminal predates AMS, call agentUpgrade and follow its ordered migration guide.\n\n' +
            upgradeNoticeMode('manual') + '\n\n' +
            'This is a system notice; no reply is needed.',
        );
    });

    /**
     * genie#346 — the notice used to say *"call agentUpgrade now and follow its
     * ordered migration guide"*, and `agentUpgrade` is served by the very server
     * the upgrade just replaced. The one instruction the agent was given was the
     * one it could not follow, which is why the whole thing reads as the tools
     * being broken rather than merely disconnected.
     */
    describe('the notice is honest about the dead connection', () => {
        it('never asks for agentUpgrade as though the tools were live', () => {
            const msg = formatAgentUpgradeMessage('0.8.0', [], RECONNECTED, 'manual');
            // What is TRUE comes first: the connection was replaced.
            expect(msg).toContain('replaced by the upgrade');
            // The restore step is stated BEFORE the migration is asked for…
            expect(msg.indexOf('/mcp reconnect genie')).toBeLessThan(msg.indexOf('agentUpgrade'));
            // …and the migration is CONDITIONED on the connection being back,
            // not demanded "now".
            expect(msg).toContain('Once `genie` answers again');
            expect(msg).not.toContain('call agentUpgrade now');
        });

        it('carries the per-agent recovery, so a notice provider is not told a lie', () => {
            // A kiwi/custom/Genie-TUI agent gets no reconnect at all. Handing it
            // Claude's sentence would tell it a command had been run in a
            // terminal that never saw one.
            const msg = formatAgentUpgradeMessage(
                '0.8.0',
                [],
                { strategy: { kind: 'notice', text: MANUAL_RECONNECT_NOTICE }, applied: false },
                'manual',
            );
            expect(msg).toContain(MANUAL_RECONNECT_NOTICE);
            expect(msg).not.toContain('/mcp reconnect genie');
        });

        it('says a reconnect was HELD BACK when the terminal refused it', () => {
            const msg = formatAgentUpgradeMessage(
                '0.8.0',
                [],
                { strategy: { kind: 'command', text: '/mcp reconnect genie' }, applied: false },
                'manual',
            );
            expect(msg).toContain('held the command back');
            expect(msg).not.toContain('Genie ran `/mcp reconnect genie`');
        });
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

    it('composes EACH agent its own notice from its own recovery', () => {
        // One text for the whole fleet is what made the notice dishonest: a
        // Claude terminal that was reconnected and a kiwi terminal that was not
        // are told different truths, so the message cannot be built once.
        const send = vi.fn((_agentId: string, _text: string) => true);
        const recoveries: Record<string, McpRecovery> = {
            'a-claude': { strategy: { kind: 'command', text: '/mcp reconnect genie' }, applied: true },
            'a-kiwi': { strategy: { kind: 'notice', text: MANUAL_RECONNECT_NOTICE }, applied: false },
        };

        announceAgentUpgrade({
            currentVersion: '0.8.0',
            previousVersion: '0.7.9',
            agents: [
                { agentId: 'a-claude', name: 'claude-one' },
                { agentId: 'a-kiwi', name: 'kiwi-one' },
            ],
            changes: [],
            reconnect: (agentId) => recoveries[agentId],
            send,
            persist: vi.fn(),
            schedule: runNow,
        });

        expect(send.mock.calls[0][1]).toContain('Genie ran `/mcp reconnect genie`');
        expect(send.mock.calls[1][1]).toContain(MANUAL_RECONNECT_NOTICE);
        expect(send.mock.calls[1][1]).not.toContain('/mcp reconnect genie');
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

    /**
     * genie#346 — NOTHING goes out in the boot tick, not even the first agent.
     *
     * The announcement runs at startup, and the harness channels an upgrade
     * killed re-attach on their own a second or two after the MCP server binds.
     * Firing the first nudge immediately meant that agent's notice was composed
     * while no transport was bound — so the broker read "not attached" and typed
     * it at the prompt, which is the exact symptom genie#344 fixed and this
     * issue re-created on every upgrade.
     *
     * The grace is what turns the PTY fallback back into the exception: it lets
     * a healed channel report itself BEFORE Genie decides how to reach the
     * agent.
     */
    it('holds even the FIRST nudge for the transport grace window', () => {
        const clock = recorder();
        const send = vi.fn((_agentId: string, _text: string) => true);

        announceAgentUpgrade({ ...base, agents: fleet, send, persist: vi.fn(), schedule: clock.schedule });

        // Nothing at all in the boot tick — the old code sent to `a-one` here.
        expect(send).not.toHaveBeenCalled();
        expect(clock.queue.map((entry) => entry.delayMs)).toEqual([
            AGENT_UPGRADE_TRANSPORT_GRACE_MS,
            AGENT_UPGRADE_TRANSPORT_GRACE_MS + AGENT_UPGRADE_NUDGE_INTERVAL_MS,
            AGENT_UPGRADE_TRANSPORT_GRACE_MS + AGENT_UPGRADE_NUDGE_INTERVAL_MS * 2,
        ]);

        // POSITIVE CONTROL: "they were spaced out" passes just as well against a
        // function that sent nothing. Drive the clock and check all three land.
        clock.drain();
        expect(send.mock.calls.map((call) => call[0])).toEqual(['a-one', 'a-two', 'a-three']);
    });

    it('gives the grace its own named constant, long enough for a channel to heal', () => {
        // The generated channel bridge retries with capped backoff (see
        // `claudeChannelBridge`); the grace has to outlast one full cap so a
        // healed channel is bound before the first notice is composed.
        expect(AGENT_UPGRADE_TRANSPORT_GRACE_MS).toBeGreaterThan(5_000);
    });

    it('keeps reconnect → send paired per agent, never interleaved', () => {
        // ORDER IS THE POINT. A notice that lands first is read with dead tools —
        // so staggering must not let one agent's reconnect race another's send.
        const clock = recorder();
        const order: string[] = [];

        announceAgentUpgrade({
            ...base,
            agents: fleet,
            reconnect: (agentId) => {
                order.push(`reconnect:${agentId}`);
            },
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
