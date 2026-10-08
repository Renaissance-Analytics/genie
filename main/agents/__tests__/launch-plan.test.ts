import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchPlan } from '../launch-plan';
import { withClaudeAgentInboxChannelLaunch } from '../../mcp/agent-config';

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
    it('starts a STRUCTURED session for a capable provider — ACP is not optional', () => {
        // This asserted a pty "by default". There is no default to choose any more: a
        // provider that can speak ACP speaks it.
        expect(launchPlan({ provider: 'claude', command: 'claude --session-id x' })).toEqual({
            kind: 'acp',
            provider: 'claude',
        });
    });

    it('types the launch line into a pty for a provider with NO ACP mode', () => {
        // The pty path is not gone — it is what a pty-only provider still takes, and most
        // of the twenty-one are.
        expect(launchPlan({ provider: 'aider', command: 'aider' })).toEqual({
            kind: 'pty',
            command: 'aider',
        });
    });

    it('starts a structured session when ACP is on for a capable provider', () => {
        expect(launchPlan({ provider: 'claude', command: 'claude' })).toEqual({
            kind: 'acp',
            provider: 'claude',
        });
    });

    it('stays on the pty for a provider with no ACP mode, even when ACP is on', () => {
        expect(launchPlan({ provider: 'aider', command: 'aider' })).toMatchObject({ kind: 'pty' });
    });

    it('returns nothing when a PTY-ONLY provider has no launch command', () => {
        // Nothing to type and nothing to start, so the caller skips the launch entirely.
        // Asked of aider rather than claude, because claude no longer takes this path —
        // ACP needs no command at all.
        expect(launchPlan({ provider: 'aider', command: null })).toBeNull();
    });

    it('can start ACP with no launch command, because ACP does not use one', () => {
        // The command is a TUI invocation. An ACP agent is spawned from its adapter and
        // bare argv, so the absence of a command is not a reason to refuse.
        expect(launchPlan({ provider: 'claude', command: null })).toEqual({
            kind: 'acp',
            provider: 'claude',
        });
    });

    it('respects a per-agent override in both directions', () => {
        expect(launchPlan({ provider: 'claude', command: 'claude', agentOverride: 'acp' })).toMatchObject({ kind: 'acp' });
        expect(launchPlan({ provider: 'claude', command: 'claude', agentOverride: 'pty' })).toMatchObject({ kind: 'pty' });
    });

    it('stays on the pty when the provider is unknown', () => {
        expect(launchPlan({ provider: null, command: 'something' })).toMatchObject({ kind: 'pty' });
    });
});

describe('a CUSTOM launch command holds the agent on the pty', () => {
    /**
     * ACP cannot honour a command. The adapter is spawned with bare argv and everything
     * travels in the environment, so a configured command line reaches it in NO form:
     * `claude --model opus`, a wrapper script, `npx something`, a different binary — all of
     * it would be silently dropped and the agent would start with none of it.
     *
     * Dropping it is worse than refusing ACP for that agent, and much worse than it sounds:
     * `agent_command_custom` is a real Genie setting, the owner uses flags, and the failure
     * is invisible. The agent comes up, answers, and is simply not the agent that was
     * configured. Holding it on the pty honours the command exactly as before.
     *
     * Found by the `channel-liveness` fixtures, which start a claude agent with
     * `command: 'echo agent'`. ACP would have ignored that and started a real session.
     */
    it('refuses ACP for a command that is not the provider itself', () => {
        expect(launchPlan({ provider: 'claude', command: 'echo agent' })).toEqual({
            kind: 'pty',
            command: 'echo agent',
        });
    });

    it('refuses ACP for the provider WITH extra flags, which ACP cannot pass on', () => {
        expect(
            launchPlan({ provider: 'claude', command: 'claude --model opus' }),
        ).toEqual({ kind: 'pty', command: 'claude --model opus' });
    });

    it('still takes ACP for the plain provider command', () => {
        expect(launchPlan({ provider: 'claude', command: 'claude' })).toEqual({
            kind: 'acp',
            provider: 'claude',
        });
    });

    it("still takes ACP when Genie's OWN session flag is the only addition", () => {
        // `renderAgentLaunch` appends `--session-id <uuid>` before this is called, so a
        // naive comparison would hold EVERY claude agent on the pty — ACP would be
        // unreachable and the suite would still be green, because the pty path works.
        expect(
            launchPlan({ provider: 'claude', command: 'claude --session-id 7f3a9b21-0000-4000-8000-000000000000' }),
        ).toEqual({ kind: 'acp', provider: 'claude' });
    });

    it('takes ACP when there is no command at all', () => {
        // Nothing was configured, so nothing is being dropped.
        expect(launchPlan({ provider: 'claude', command: null })).toEqual({
            kind: 'acp',
            provider: 'claude',
        });
    });

    it('is not fooled by the binary appearing later in the line', () => {
        // A wrapper that ENDS in the provider is still a wrapper.
        expect(launchPlan({ provider: 'claude', command: 'nice -n 10 claude' })).toEqual({
            kind: 'pty',
            command: 'nice -n 10 claude',
        });
    });

    it('accepts the provider with a .exe suffix and surrounding whitespace', () => {
        // Windows renders the binary this way, and a trailing newline is a formatting
        // artefact rather than an argument. Refusing these would turn ACP off on Windows,
        // which is the owner's platform.
        expect(launchPlan({ provider: 'claude', command: '  claude.exe  ' })).toEqual({
            kind: 'acp',
            provider: 'claude',
        });
    });

    /**
     * GENIE'S OWN additions do not count as a custom command, and the INSTRUCTIONS it folds
     * in are the subtle case.
     *
     * `withStartupInstructions` appends them as a quoted POSITIONAL argument — `claude "You
     * are Strategist…"` — so by shape they are indistinguishable from a user's own quoted
     * flag value. What distinguishes them is that the caller hands the same text to
     * `instructions`, which is how ACP delivers it. So this strips a trailing quoted argument
     * ONLY when it is the one we were told about.
     *
     * Found by `gapp-agents-launch`: a GApp folds its persona into the command, so without
     * this every GApp agent fell back to the pty — and the persona assertion passed, because
     * the pty carries it. ACP would simply never have been reached.
     */
    it('takes ACP when the only addition is the instructions ACP will carry itself', () => {
        expect(
            launchPlan({
                provider: 'claude',
                command: 'claude "You are Strategist, read /w/.agents/strategist.md"',
                instructions: 'You are Strategist, read /w/.agents/strategist.md',
            }),
        ).toEqual({ kind: 'acp', provider: 'claude' });
    });

    it('holds the pty for a quoted argument we were NOT told about', () => {
        // Not ours, so we cannot deliver it any other way. Someone's own prompt, a filename,
        // a wrapper's argument — dropping it silently is the failure this prevents.
        expect(
            launchPlan({
                provider: 'claude',
                command: 'claude "some prompt of my own"',
                instructions: 'a different briefing entirely',
            }),
        ).toEqual({ kind: 'pty', command: 'claude "some prompt of my own"' });
    });

    it('accepts the codex `--` separator form of the same addition', () => {
        // `withProviderStartupInstructions` inserts `--` for codex. Codex is pty-only today,
        // so this pins the grammar rather than a live path: when a codex ACP driver lands,
        // the engine decision must not read Genie's own separator as a custom command.
        expect(
            launchPlan({
                provider: 'claude',
                command: 'claude -- "briefing"',
                instructions: 'briefing',
            }),
        ).toEqual({ kind: 'acp', provider: 'claude' });
    });

    it('strips the session flag whatever shape the id is', () => {
        // `isSafeSessionId` permits a single character, so requiring a uuid here would hold
        // an agent with a short pinned id on the pty for no reason.
        expect(launchPlan({ provider: 'claude', command: 'claude --session-id x' })).toEqual({
            kind: 'acp',
            provider: 'claude',
        });
        expect(launchPlan({ provider: 'claude', command: 'claude --session-id=abc123' })).toEqual({
            kind: 'acp',
            provider: 'claude',
        });
    });

    /**
     * GENIE'S CHANNEL FLAG is its own addition too, and the ACP session SUPERSEDES it.
     *
     * `resolveAgentLaunch` appends `--dangerously-load-development-channels
     * server:genie-agentinbox-channel` whenever the workspace has the bridge adapter — so for
     * a real workspace the claude launch line is never bare, and without this every claude
     * agent in the product fell back to the pty. Nothing failed; ACP was simply never reached,
     * which is the shape of a feature that ships switched off.
     *
     * Stripping it is right rather than convenient: the flag's whole job is to give the agent
     * a mail transport, and an ACP session IS one (`main/acp/mail-transport.ts`), a push rather
     * than a pull. The pty keeps the flag; ACP replaces it.
     *
     * The flag text is asserted against `withClaudeAgentInboxChannelLaunch`'s own output rather
     * than copied, so this cannot drift from the line Genie writes.
     */
    it("takes ACP through Genie's OWN channel flag, which the session replaces", () => {
        // The flag is gated on the bridge ADAPTER existing — `withClaudeAgentInboxChannelLaunch`
        // refuses to promise a channel a workspace has not defined — so the fixture writes one.
        // Without it the helper returns the command untouched and this case tests nothing, which
        // is what the positive control below catches.
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-launch-plan-'));
        fs.mkdirSync(path.join(ws, '.agents', '_genie'), { recursive: true });
        fs.writeFileSync(path.join(ws, '.agents', '_genie', 'agentinbox-claude-channel.cjs'), '');
        const built = withClaudeAgentInboxChannelLaunch('claude', {
            agent: 'claude',
            mcpSyncClaudeOff: false,
            workspacePath: ws,
        });
        // POSITIVE CONTROL on the fixture itself.
        expect(built).not.toBe('claude');
        expect(built).toContain('--dangerously-load-development-channels');
        expect(launchPlan({ provider: 'claude', command: built })).toEqual({
            kind: 'acp',
            provider: 'claude',
        });
    });

    it('holds the pty for a USER flag beside the channel flag', () => {
        // `resolveProviderFlags` reads Settings → provider flags, which is the owner's
        // configuration and has no ACP equivalent. The direction of the error matters: the pty
        // honours it exactly as today, where ACP would drop it in silence.
        expect(
            launchPlan({
                provider: 'claude',
                command:
                    'claude --dangerously-load-development-channels server:genie-agentinbox-channel --dangerously-skip-permissions',
            }),
        ).toEqual({
            kind: 'pty',
            command:
                'claude --dangerously-load-development-channels server:genie-agentinbox-channel --dangerously-skip-permissions',
        });
    });

    it('an explicit ACP override still wins, because the owner said so', () => {
        // The custom command is a reason to be careful, not a veto. Someone who pins ACP for
        // an agent with a custom command is choosing to lose the flags.
        expect(
            launchPlan({ provider: 'claude', command: 'claude --model opus', agentOverride: 'acp' }),
        ).toEqual({ kind: 'acp', provider: 'claude' });
    });
});
