import { describe, expect, it, vi } from 'vitest';
import { announceAgentUpgrade } from '../upgrade-announcement';
import {
    MANUAL_RECONNECT_NOTICE,
    mcpReconnectCommand,
    reconnectStrategy,
    recoveryInstruction,
} from '../mcp-reconnect';
import { PROVIDER_IDS, TUI_REGISTRY } from '../registry';

/**
 * After Genie upgrades, an agent's `genie` MCP connection is STALE.
 *
 * The upgrade notice tells the agent to act — call `agentUpgrade`, follow the
 * migration guide — using tools whose connection died with the old process. So
 * the agent reads a nudge and then cannot do the thing the nudge asks for, which
 * looks like the tools are broken rather than merely disconnected.
 *
 * The reconnect therefore has to reach the terminal BEFORE the notice, not
 * alongside it and not as advice inside it: by the time an agent is reading
 * prose it has already tried and failed.
 *
 * The repair is per-TUI, and not a matter of taste. Claude Code takes
 * `/mcp reconnect genie`, typed. Codex has NO equivalent — verified by the
 * Codex agent against codex-cli 0.150.1 — and does not discover the
 * replacement URL either, because Genie passes it in launch config. Its repair
 * is a managed RESTART, which resumes the session against refreshed config.
 *
 * Everything else used to get `{kind:'none'}` — silence, until a human noticed
 * (genie#346). Silence is not a safer default than a guessed slash command; it
 * is just a quieter failure. Those providers now get a NOTICE: the instruction
 * is stated, out of band, and the terminal is flagged for attention. Nothing is
 * typed into a prompt whose grammar Genie does not know.
 */
describe('mcpReconnectCommand', () => {
    it('gives Claude Code its slash command', () => {
        expect(mcpReconnectCommand('claude')).toBe('/mcp reconnect genie');
    });

    it('gives Codex a RESTART, never typed text', () => {
        // Verified by the Codex agent against codex-cli 0.150.1: `codex mcp`
        // exposes only list/get/add/remove/login/logout — there is no
        // single-server reconnect. And Codex does not discover the replacement
        // URL, because Genie passes it in launch config, so the running process
        // keeps the old endpoint. A managed restart resumes the session against
        // refreshed config.
        expect(reconnectStrategy('codex')).toEqual({ kind: 'restart' });
        expect(mcpReconnectCommand('codex')).toBeNull();
    });

    it('still types NOTHING into a TUI whose input grammar is unknown', () => {
        // A guessed command is typed into a live prompt. Codex parks on
        // key-driven modals — update pickers, approval requests, trust prompts —
        // where injected text is read as an answer, and on the update picker
        // option 1 runs a global npm install. That much is unchanged; what
        // changed is that NOT typing no longer means doing nothing.
        expect(mcpReconnectCommand('kiwi')).toBeNull();
        expect(mcpReconnectCommand('custom')).toBeNull();
        expect(mcpReconnectCommand('genie')).toBeNull();
    });
});

/**
 * genie#346's first acceptance clause: *"every provider has a recovery path and
 * none is left on `{kind:'none'}`."*
 *
 * The old table answered `none` for `kiwi`, `genie` and `custom`, and the share
 * of agents with no recovery grew with the TUI registry. So this asserts over
 * the REGISTRY rather than a hand-written list — a provider added to
 * `PROVIDER_IDS` without a recovery path fails here instead of shipping silent.
 */
describe('every provider has a recovery path (genie#346)', () => {
    it('leaves no registered provider without one', () => {
        // POSITIVE CONTROL. "No provider returns none" is trivially true of an
        // empty list, so the list itself is asserted first: this test has to be
        // able to FAIL, and it only can if there are providers to check.
        expect(PROVIDER_IDS.length).toBeGreaterThan(0);
        expect(PROVIDER_IDS).toEqual(Object.keys(TUI_REGISTRY));
        expect(PROVIDER_IDS).toContain('kiwi');

        for (const provider of PROVIDER_IDS) {
            const strategy = reconnectStrategy(provider);
            expect(strategy.kind, `provider ${provider}`).not.toBe('none');
            // An actionable path, not an empty shell: a `command`/`notice` whose
            // text is blank is `none` wearing a different tag.
            if (strategy.kind !== 'restart') {
                expect(strategy.text.trim().length, `provider ${provider}`).toBeGreaterThan(0);
            }
        }
    });

    it('gives kiwi, the Genie TUI and a custom agent a NOTICE, not silence', () => {
        // None of the three can be restarted without losing the conversation:
        // `renderAgentResume` renders a resume command for `claude` and `codex`
        // only, so `restartAgentTerminal` REFUSES the rest rather than drop an
        // agent into a fresh, context-less session. A notice is what is left,
        // and it is strictly more than the silence it replaces.
        for (const provider of ['kiwi', 'genie', 'custom'] as const) {
            expect(reconnectStrategy(provider)).toEqual({
                kind: 'notice',
                text: MANUAL_RECONNECT_NOTICE,
            });
        }
    });

    it('covers a provider it has never heard of, and one that is missing entirely', () => {
        // A terminal whose `meta.agent` is absent or from a newer build must not
        // fall off the end of the table into silence either.
        expect(reconnectStrategy('not-a-tui')).toEqual({
            kind: 'notice',
            text: MANUAL_RECONNECT_NOTICE,
        });
        expect(reconnectStrategy(null)).toEqual({ kind: 'notice', text: MANUAL_RECONNECT_NOTICE });
        expect(reconnectStrategy(undefined)).toEqual({
            kind: 'notice',
            text: MANUAL_RECONNECT_NOTICE,
        });
    });
});

/**
 * The instruction the agent is given must describe what ACTUALLY happened.
 *
 * `wakeTerminalIfIdle` refuses to type into a terminal that is mid-turn or
 * holds a human's draft, and `restartAgentTerminal` refuses a terminal with no
 * resumable session. Both are correct refusals — and both mean the reconnect
 * did NOT happen, so a message that says "Genie reconnected you" would be a
 * lie the agent then acts on.
 */
describe('recoveryInstruction tells the truth about what was done', () => {
    const command = { kind: 'command', text: '/mcp reconnect genie' } as const;

    it('distinguishes a reconnect that ran from one that was held back', () => {
        const ran = recoveryInstruction({ strategy: command, applied: true });
        const held = recoveryInstruction({ strategy: command, applied: false });
        expect(ran).not.toBe(held);
        expect(ran).toContain('/mcp reconnect genie');
        expect(held).toContain('/mcp reconnect genie');
        // The held case must ASK the agent to run it; the applied case must not
        // claim the connection is already good either, since the command may
        // still fail.
        expect(held.toLowerCase()).toMatch(/run it|run `\/mcp reconnect genie`/);
    });

    it('distinguishes a restart that ran from one that could not', () => {
        const ran = recoveryInstruction({ strategy: { kind: 'restart' }, applied: true });
        const refused = recoveryInstruction({ strategy: { kind: 'restart' }, applied: false });
        expect(ran).not.toBe(refused);
        expect(refused.toLowerCase()).toContain('restart');
    });

    it('hands a notice provider the notice itself', () => {
        expect(recoveryInstruction({
            strategy: { kind: 'notice', text: MANUAL_RECONNECT_NOTICE },
            applied: false,
        })).toContain(MANUAL_RECONNECT_NOTICE);
    });
});

describe('the upgrade notice reconnects first', () => {
    const base = {
        currentVersion: '0.7.0-beta.286',
        previousVersion: '0.7.0-beta.285',
        changes: ['something'],
        persist: () => {},
        // The nudges are STAGGERED ~15s apart now (genie#353), so the second
        // agent's turn is queued rather than run in this tick. The scheduler is
        // an injected seam precisely so a test can BE the clock: driving it
        // synchronously keeps every assertion below about ordering, not timing,
        // and costs the suite nothing.
        schedule: (run: () => void) => run(),
    };

    it('reconnects BEFORE the notice is sent', () => {
        const order: string[] = [];
        announceAgentUpgrade({
            ...base,
            agents: [{ agentId: 'a1', name: 'alpha' }],
            reconnect: (id) => {
                order.push(`reconnect:${id}`);
                return { strategy: { kind: 'restart' as const }, applied: true };
            },
            send: (id) => {
                order.push(`send:${id}`);
                return true;
            },
        });
        // Order is the entire point: a notice that lands first is read with dead
        // tools.
        expect(order).toEqual(['reconnect:a1', 'send:a1']);
    });

    it('reconnects every agent it notifies', () => {
        const reconnected: string[] = [];
        announceAgentUpgrade({
            ...base,
            agents: [{ agentId: 'a1', name: 'alpha' }, { agentId: 'a2', name: 'beta' }],
            reconnect: (id) => {
                reconnected.push(id);
                return undefined;
            },
            send: () => true,
        });
        expect(reconnected).toEqual(['a1', 'a2']);
    });

    it('still sends the notice when the reconnect throws', () => {
        // A failed reconnect leaves the agent worse informed, not silent. The
        // notice is the durable part and must not be lost to a TUI that would
        // not take the command.
        const send = vi.fn(() => true);
        announceAgentUpgrade({
            ...base,
            agents: [{ agentId: 'a1', name: 'alpha' }],
            reconnect: () => {
                throw new Error('pty gone');
            },
            send,
        });
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('tells an agent whose reconnect THREW how to reconnect itself', () => {
        // The failure mode genie#346 is about: the connection is gone, Genie
        // could not repair it, and the agent is told nothing about either. A
        // reconnect that throws must degrade to the manual notice, never to a
        // message that assumes the tools are live.
        const send = vi.fn((_agentId: string, _text: string) => true);
        announceAgentUpgrade({
            ...base,
            agents: [{ agentId: 'a1', name: 'alpha' }],
            reconnect: () => {
                throw new Error('pty gone');
            },
            send,
        });
        expect(send.mock.calls[0][1]).toContain(MANUAL_RECONNECT_NOTICE);
    });

    it('does nothing at all when the version has not moved', () => {
        // POSITIVE CONTROL on the guard: reconnecting every agent on every boot
        // would interrupt work for no reason.
        const reconnect = vi.fn();
        announceAgentUpgrade({
            ...base,
            previousVersion: base.currentVersion,
            agents: [{ agentId: 'a1', name: 'alpha' }],
            reconnect,
            send: () => true,
        });
        expect(reconnect).not.toHaveBeenCalled();
    });

    it('works without a reconnect callback at all', () => {
        // Callers that have no way to reach a terminal must not be forced to
        // invent one.
        const send = vi.fn(() => true);
        announceAgentUpgrade({ ...base, agents: [{ agentId: 'a1', name: 'alpha' }], send });
        expect(send).toHaveBeenCalledTimes(1);
    });
});
