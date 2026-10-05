import { describe, expect, it } from 'vitest';
import { launchPlan } from '../launch-plan';

/**
 * What starting an agent MEANS, for each engine.
 *
 * The pure half of the one branch in `createAgentTerminal`. That function is the single
 * chokepoint every launch path bottoms out in — a renderer click, `runAgent start`,
 * mobile, revival — and it lives in a 115 KB file that imports electron and the database
 * and has no test of its own. So the decision lives here and the file gets a two-line
 * branch.
 */

describe('launchPlan', () => {
    it('types the launch line into a pty by default', () => {
        expect(launchPlan({ provider: 'claude', command: 'claude --session-id x', acpEnabled: false })).toEqual({
            kind: 'pty',
            command: 'claude --session-id x',
        });
    });

    it('starts a structured session when ACP is on for a capable provider', () => {
        expect(launchPlan({ provider: 'claude', command: 'claude', acpEnabled: true })).toEqual({
            kind: 'acp',
            provider: 'claude',
        });
    });

    it('stays on the pty for a provider with no ACP mode, even when ACP is on', () => {
        expect(launchPlan({ provider: 'aider', command: 'aider', acpEnabled: true })).toMatchObject({ kind: 'pty' });
    });

    it('stays on the pty when there is no launch command AND no ACP', () => {
        // Nothing to type and nothing to start. The caller skips the launch entirely, the
        // same as today.
        expect(launchPlan({ provider: 'claude', command: null, acpEnabled: false })).toBeNull();
    });

    it('can start ACP with no launch command, because ACP does not use one', () => {
        // The command is a TUI invocation. An ACP agent is spawned from its adapter and
        // bare argv, so the absence of a command is not a reason to refuse.
        expect(launchPlan({ provider: 'claude', command: null, acpEnabled: true })).toEqual({
            kind: 'acp',
            provider: 'claude',
        });
    });

    it('respects a per-agent override in both directions', () => {
        expect(launchPlan({ provider: 'claude', command: 'claude', acpEnabled: false, agentOverride: 'acp' })).toMatchObject({ kind: 'acp' });
        expect(launchPlan({ provider: 'claude', command: 'claude', acpEnabled: true, agentOverride: 'pty' })).toMatchObject({ kind: 'pty' });
    });

    it('stays on the pty when the provider is unknown', () => {
        expect(launchPlan({ provider: null, command: 'something', acpEnabled: true })).toMatchObject({ kind: 'pty' });
    });
});
