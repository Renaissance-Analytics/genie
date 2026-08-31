import { describe, expect, it } from 'vitest';
import { decideTuiSwitch, type SwitchRuntime } from '../tui-switch';

/**
 * Switching the TUI an agent runs under — the point of the whole redesign.
 *
 * An agent is not its TUI. `claude` and `codex` are drivers it can move between,
 * and the driver it moves AWAY from keeps its pty and its conversation as a
 * hidden sidecar to flip back to. That is what makes switching acceptable at
 * all: a Claude transcript means nothing to Codex, so conversation continuity is
 * per-TUI by nature. The agent's IDENTITY — its `agent_id`, its inbox, its name,
 * its prompt — carries across; each TUI keeps its own thread to return to.
 *
 * THE OWNER'S RULE: never kill or stop without confirmation. So this decision
 * has no "stop" outcome at all. It can front an existing runtime or create one;
 * it can never end another. Anything that costs a live process is a separate,
 * confirmed action, which is also why the decision is pure and enumerable rather
 * than a sequence of side effects someone has to read to audit.
 */
describe('decideTuiSwitch', () => {
    const runtime = (provider: string, fronted = false, spec: string | null = 't1'): SwitchRuntime => ({
        id: `r-${provider}`,
        provider,
        terminalSpecId: spec,
        fronted,
    });

    it('flips to a TUI the agent already has, without starting anything', () => {
        // The sidecar case: the runtime is there and warm, so this is a swap.
        const decision = decideTuiSwitch({
            runtimes: [runtime('claude', true), runtime('codex', false, 't2')],
            to: 'codex',
            allowed: ['claude', 'codex'],
        });
        expect(decision).toEqual({ kind: 'front', runtimeId: 'r-codex' });
    });

    it('creates a runtime for a TUI the agent has never run', () => {
        const decision = decideTuiSwitch({
            runtimes: [runtime('claude', true)],
            to: 'codex',
            allowed: ['claude', 'codex'],
        });
        expect(decision).toEqual({ kind: 'create', provider: 'codex' });
    });

    it('is a no-op when the requested TUI is already the visible one', () => {
        // Not an error: asking for what you have should be harmless, and
        // treating it as a switch would tear down and relaunch for nothing.
        expect(
            decideTuiSwitch({
                runtimes: [runtime('claude', true)],
                to: 'claude',
                allowed: ['claude'],
            }),
        ).toEqual({ kind: 'already', runtimeId: 'r-claude' });
    });

    it('refuses a TUI the agent’s file does not list', () => {
        // `tuis` in AGENT.md is the author's statement of which drivers this
        // agent is written for. A prompt tuned for one harness is not
        // automatically safe on another.
        const decision = decideTuiSwitch({
            runtimes: [runtime('claude', true)],
            to: 'kiwi',
            allowed: ['claude', 'codex'],
        });
        expect(decision.kind).toBe('refuse');
    });

    it('allows any TUI when the agent lists none', () => {
        // An empty `tuis` is "no opinion", not "nothing permitted" — the file
        // defaults it to empty, and reading that as a lockout would make every
        // agent unswitchable until someone edited a file they never saw.
        expect(
            decideTuiSwitch({
                runtimes: [runtime('claude', true)],
                to: 'codex',
                allowed: [],
            }),
        ).toEqual({ kind: 'create', provider: 'codex' });
    });

    it('NEVER decides to stop the runtime it is leaving', () => {
        // The owner's rule, asserted as a property rather than trusted to
        // review: nothing this function returns may end a live process.
        for (const to of ['codex', 'kiwi', 'claude', 'genie']) {
            const decision = decideTuiSwitch({
                runtimes: [runtime('claude', true), runtime('codex', false, 't2')],
                to,
                allowed: [],
            });
            expect(decision.kind).not.toBe('stop');
            expect(JSON.stringify(decision)).not.toMatch(/stop|kill/i);
        }
    });

    it('fronts the first TUI of an agent that had none running', () => {
        // A dormant agent being started IS a switch to its first driver.
        expect(
            decideTuiSwitch({ runtimes: [], to: 'claude', allowed: ['claude'] }),
        ).toEqual({ kind: 'create', provider: 'claude' });
    });

    it('adopts an existing runtime even when its terminal is gone', () => {
        // A sidecar whose pty exited is still that agent's Codex conversation.
        // Creating a second Codex runtime beside it would strand the thread and
        // trip the one-runtime-per-TUI rule.
        const decision = decideTuiSwitch({
            runtimes: [runtime('claude', true), runtime('codex', false, null)],
            to: 'codex',
            allowed: [],
        });
        expect(decision).toEqual({ kind: 'front', runtimeId: 'r-codex' });
    });
});
