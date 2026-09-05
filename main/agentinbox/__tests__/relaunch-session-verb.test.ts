import { describe, expect, it } from 'vitest';
import {
    renderAgentLaunch,
    agentRelaunchDecision,
    resolveRestartCommand,
} from '../session-capture';

/**
 * genie#364 — A RELAUNCH CHANGES THE SESSION VERB. IT NEVER REPLAYS THE CREATE
 * FLAG.
 *
 * `--session-id <uuid>` is CREATE-a-session-with-this-id. It succeeds exactly
 * once. The second time Claude Code refuses it — *"Error: Session ID <uuid> is
 * already in use."* — which is what the owner was shown while Genie's Restart
 * button reported "agent restarted".
 *
 * The create flag reaches a relaunch through the STORED command:
 * `renderAgentLaunch` mints the uuid, appends the flag, and is deliberately
 * IDEMPOTENT about one that is already there ("left untouched — we reuse/extract
 * its id"). That is right for a first launch and wrong for every one after: on a
 * relaunch the captured id must change VERB, not be preserved.
 *
 * Every assertion below is paired with the POSITIVE CONTROL that the FIRST
 * launch still mints `--session-id` and that the relaunch carries the SAME id.
 * "The relaunch has no create flag" passes just as well against a build that
 * lost session handling altogether — and that would be the worse bug, dropping
 * the conversation silently instead of loudly.
 */
describe('genie#364 — a relaunch resumes the captured id, never re-creates it', () => {
    const BASE = 'claude --dangerously-skip-permissions';

    it('mints --session-id on the FIRST launch and RESUMES that id on the next', () => {
        // POSITIVE CONTROL: session capture is intact — a first launch still
        // pins the conversation by minting an id and passing it in.
        const first = renderAgentLaunch('claude', BASE);
        expect(first.chatSessionId).toMatch(/^[0-9a-fA-F-]{8,}$/);
        expect(first.command).toBe(`${BASE} --session-id ${first.chatSessionId}`);

        // The command Genie submitted is the one a relaunch replays.
        const relaunch = agentRelaunchDecision(
            { meta: { agent: 'claude', agent_command: first.command } },
            false,
            () => true,
        );

        // SAME conversation, RESUME verb.
        expect(relaunch?.command).toBe(`${BASE} --resume ${first.chatSessionId}`);
        expect(relaunch?.command).not.toContain('--session-id');
    });

    it('restarts a spec whose only record of the session is the stored create flag', () => {
        const first = renderAgentLaunch('claude', BASE);
        const spec = { meta: { agent: 'claude', agent_command: first.command } };

        // Refusing here reads as "no conversation to resume" while the id is
        // sitting in the command; replaying it dies with "already in use".
        // Neither is the answer — the id IS captured, it just needs the other verb.
        const decision = resolveRestartCommand(spec, () => true);
        expect(decision).toEqual({ command: `${BASE} --resume ${first.chatSessionId}` });
    });

    it('degrades a PHANTOM session to --continue, still without the create flag', () => {
        const first = renderAgentLaunch('claude', BASE);
        const spec = { meta: { agent: 'claude', agent_command: first.command } };

        // No transcript on disk: `--resume <phantom>` dead-ends "No conversation
        // found", so the most-recent chat in the cwd is continued instead.
        const decision = resolveRestartCommand(spec, () => false);
        expect(decision).toEqual({ command: `${BASE} --continue` });
        expect(JSON.stringify(decision)).not.toContain('--session-id');
    });

    it('prefers the CAPTURED id over a stale one left in the stored command', () => {
        // A stored command can carry a stale id (the owner's own always-on flags,
        // or a spec written before capture moved to `meta`). `chat_session_id` is
        // the live record and outranks it.
        const stale = 'aaaaaaaa-0000-0000-0000-000000000000';
        const live = 'bbbbbbbb-1111-1111-1111-111111111111';
        expect(
            agentRelaunchDecision(
                {
                    meta: {
                        agent: 'claude',
                        agent_command: `${BASE} --session-id ${stale}`,
                        chat_session_id: live,
                    },
                },
                false,
                () => true,
            ),
        ).toEqual({ command: `${BASE} --resume ${live}` });
    });

    it('does not replay the create flag for a provider that cannot resume', () => {
        // `custom` has no resume grammar (`TuiDef.resume: null`), so Genie cannot
        // resume it. Replaying a one-shot create flag is not "keeping the
        // conversation" — it is a guaranteed crash. A fresh session is the honest
        // answer here, and the RESTART BUTTON still refuses outright (next test).
        const relaunch = agentRelaunchDecision(
            {
                meta: {
                    agent: 'custom',
                    agent_command:
                        'my-wrapper --session-id cccccccc-2222-2222-2222-222222222222',
                },
            },
            false,
            () => true,
        );
        expect(relaunch?.command).toBe('my-wrapper');
    });

    it('never hands a non-resumable provider a resume command it cannot run', () => {
        for (const agent of ['custom', 'kilo', 'genie'] as const) {
            const decision = resolveRestartCommand(
                {
                    meta: {
                        agent,
                        agent_command: `${agent}-cli --session-id dddddddd-3333-3333-3333-333333333333`,
                        chat_session_id: 'dddddddd-3333-3333-3333-333333333333',
                    },
                },
                () => true,
            );
            expect(decision).toHaveProperty('error');
            expect(JSON.stringify(decision)).not.toContain('--resume');
        }
    });

    it('answers every provider from the registry table, not a claude special case', () => {
        // codex declares a SUBCOMMAND grammar; the id is positional and last, so
        // the `-c` overrides Genie injects stay ahead of it.
        const sid = 'eeeeeeee-4444-4444-4444-444444444444';
        expect(
            resolveRestartCommand(
                { meta: { agent: 'codex', agent_command: 'codex --yolo', chat_session_id: sid } },
                () => true,
            ),
        ).toEqual({ command: `codex resume --yolo ${sid}` });
    });
});
