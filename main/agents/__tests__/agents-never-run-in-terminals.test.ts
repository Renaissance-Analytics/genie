import { describe, expect, it } from 'vitest';
import { engineFor } from '../engine';
import { launchPlan } from '../launch-plan';

/**
 * AGENTS DO NOT RUN IN TERMINALS. PTY IS NOT AN OPTION.
 *
 * Owner directive, 2026-10-09, after beta.2 still brought agents up in terminals:
 * *"agents do not fuckign run in terminals. PTY is not a fucking option."*
 *
 * ## What actually put them there — and it was not provider capability
 *
 * `claude` has been in `ACP_PROVIDERS` the whole time, so `engineFor` returned `'acp'` for
 * all 30 of the owner's agents. `launchPlan` then threw that away: it only kept the ACP
 * branch when the stored launch line was a BARE provider command, and every one of those
 * agents carries flags —
 *
 *   claude --dangerously-skip-permissions --dangerously-load-development-channels server:…
 *
 * — so `honoursCommand` was false and each fell through to `{ kind: 'pty', command }`. The
 * reasoning was that ACP drops the launch line silently, so an agent with a configured
 * command would "come up answering, but not as the agent that was configured". That traded
 * a visible wrong for an invisible one: it kept the flags by putting the agent in a terminal,
 * which is the thing that must never happen.
 *
 * ## The contract now
 *
 * There is no pty plan. `launchPlan` returns an ACP plan, or `null` meaning **this cannot run
 * as an agent** — and a caller must say so rather than quietly opening a terminal. A dropped
 * flag is reported on the plan (`droppedCommand`) so the loss is visible instead of silent.
 */
describe('agents never run in terminals', () => {
    it('plans ACP even when the stored command carries flags — the owner\'s real agents', () => {
        const plan = launchPlan({
            provider: 'claude',
            command:
                'claude --dangerously-skip-permissions --dangerously-load-development-channels server:genie-agentinbox-channel',
            instructions: null,
        });

        expect(plan).not.toBeNull();
        expect(plan?.kind).toBe('acp');
        // The flags are LOST by ACP, which is a real cost — so it is reported, not hidden.
        expect(plan?.droppedCommand).toContain('--dangerously-skip-permissions');
    });

    it('plans ACP for a bare command, and reports nothing dropped', () => {
        const plan = launchPlan({ provider: 'claude', command: 'claude', instructions: null });
        expect(plan?.kind).toBe('acp');
        expect(plan?.droppedCommand ?? null).toBeNull();
    });

    it('plans ACP with no command at all', () => {
        const plan = launchPlan({ provider: 'claude', command: null, instructions: null });
        expect(plan?.kind).toBe('acp');
    });

    it('REFUSES rather than falling back to a terminal when the provider cannot speak ACP', () => {
        // aider has no ACP mode. Before, this returned a pty plan and opened a terminal.
        // Now it is `null` — "not runnable as an agent" — which a caller has to surface.
        const plan = launchPlan({ provider: 'aider', command: 'aider --model gpt-4', instructions: null });
        expect(plan).toBeNull();
    });

    it('REFUSES for an unknown provider instead of guessing a shell', () => {
        expect(launchPlan({ provider: null, command: 'something', instructions: null })).toBeNull();
        expect(launchPlan({ provider: 'custom', command: 'whatever', instructions: null })).toBeNull();
    });

    it('COUNT, not a boolean: no provider in the registry plans a terminal', () => {
        // A boolean on one provider would pass while another still routed to a pty. Count
        // every provider that yields a pty plan; the only acceptable number is zero.
        const providers = ['claude', 'codex', 'gemini', 'kimi', 'aider', 'custom', null];
        const ptyPlans = providers.filter((p) => {
            const plan = launchPlan({ provider: p, command: `${p ?? 'x'} --some-flag`, instructions: null });
            return plan !== null && (plan as { kind: string }).kind !== 'acp';
        });
        expect(ptyPlans).toEqual([]);
    });

    it('engineFor never answers with a terminal engine', () => {
        // POSITIVE CONTROL: it must still answer 'acp' for the capable ones, otherwise
        // "never pty" would pass on a function that refuses everything.
        expect(engineFor({ provider: 'claude' })).toBe('acp');
        expect(engineFor({ provider: 'codex' })).toBe('acp');

        // And for the incapable ones it reports that it cannot, rather than naming a pty.
        expect(engineFor({ provider: 'aider' })).toBeNull();
        expect(engineFor({ provider: null })).toBeNull();
    });

    it('an agentOverride cannot ask for a terminal', () => {
        // The old escape hatch was `agentOverride: 'pty'` to hold one agent back. Holding an
        // agent back now means not running it as an agent at all -- it cannot mean a terminal.
        // @ts-expect-error 'pty' is no longer an AgentEngine; this is the compile-time half
        // of the guarantee, asserted here so the runtime half is checked too.
        expect(engineFor({ provider: 'claude', agentOverride: 'pty' })).toBe('acp');
    });
});
