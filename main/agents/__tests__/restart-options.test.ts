import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS, canResumeTui } from '../registry';
import { acpResumeSessionId, capturedSessionId, restartOptionsFor } from '../restart-options';

/**
 * genie#443 — WHICH restart a terminal can be offered.
 *
 * The old menus asked one question, `canResumeTui(agent)`, and used its answer
 * for both operations. That is why a provider with `resume: null` lost the
 * option entirely, and why the answer for a resumable provider with NO captured
 * session was "yes" right up until the host refused.
 *
 * Two questions now, and this is where they are answered — pure, so both the
 * renderer's menus and the host's `restartAgentTerminal` reason off the same
 * function rather than two that agree until they don't.
 */

const claude = (meta: Record<string, unknown> = {}) => ({
    meta: { agent: 'claude', agent_command: 'claude', ...meta },
});

describe('restartOptionsFor', () => {
    it('offers a FRESH restart to a provider that cannot resume — the reported case', () => {
        // The terminal in the report: a Genie TUI that died at
        // `bash: genie: command not found`. Nothing was captured because nothing
        // ever started, so there is no conversation to protect — and the old
        // gate removed its only way out.
        const o = restartOptionsFor({ meta: { agent: 'genie', agent_command: 'genie' } });

        expect(o.canRestartFresh).toBe(true);
        expect(o.canResume).toBe(false);
        // …and nothing pretends there is a conversation to lose.
        expect(o.losesConversation).toBe(false);
    });

    it('offers BOTH to a resumable provider with a captured session', () => {
        const o = restartOptionsFor(claude({ chat_session_id: 'sess-1' }));

        expect(o.canResume).toBe(true);
        expect(o.canRestartFresh).toBe(true);
        // Restarting fresh here really does abandon a chat, so the surfaces warn.
        expect(o.losesConversation).toBe(true);
    });

    it('withholds RESUME from a resumable provider with nothing captured', () => {
        // Both halves are required. A grammar with no id has nothing to resume,
        // and offering it anyway is a menu item that exists only to be refused.
        const o = restartOptionsFor(claude());

        expect(canResumeTui('claude')).toBe(true);
        expect(o.canResume).toBe(false);
        expect(o.canRestartFresh).toBe(true);
    });

    it('reads a session id that lives only in the stored launch command', () => {
        // genie#364 — the id can be recorded ONLY by `--session-id` in the
        // command. A restart offered on the strength of the field alone would
        // miss it, and a "fresh" restart that ignored it would resume the very
        // chat the user asked to leave.
        const spec = claude({ agent_command: 'claude --session-id 3f2504e0-4f89-11d3-9a0c-0305e82c3301' });

        expect(capturedSessionId(spec)).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
        expect(restartOptionsFor(spec).canResume).toBe(true);
        expect(restartOptionsFor(spec).losesConversation).toBe(true);
    });

    it('offers NEITHER to a terminal that is not an agent', () => {
        // POSITIVE CONTROL for `canRestartFresh: true` above: a predicate that
        // simply returned true would satisfy every case up to here.
        expect(restartOptionsFor({ meta: { agent_command: 'bash' } })).toEqual({
            isAgent: false,
            canResume: false,
            canRestartFresh: false,
            losesConversation: false,
        });
        expect(restartOptionsFor(null).isAgent).toBe(false);
        expect(restartOptionsFor(undefined).isAgent).toBe(false);
    });

    it('answers for a provider string it does not know, without throwing', () => {
        // `meta.agent` is a stored string; a spec written by a newer build can
        // name a provider this one has never heard of. It cannot be resumed —
        // and it can still be restarted, which is the point.
        const o = restartOptionsFor({ meta: { agent: 'not-a-provider', chat_session_id: 's' } });

        expect(o.canResume).toBe(false);
        expect(o.canRestartFresh).toBe(true);
    });

    it('every registered provider can be restarted fresh, and none falls off the table', () => {
        for (const id of PROVIDER_IDS) {
            const o = restartOptionsFor({ meta: { agent: id, chat_session_id: 'sess' } });
            expect(o.canRestartFresh, id).toBe(true);
            // The resume half still tracks the registry exactly — the fix is a
            // SECOND operation, never a weaker first one (genie#440).
            expect(o.canResume, id).toBe(canResumeTui(id));
        }
    });
});

/**
 * An ACP agent resumes through `session/load`, not through a resume FLAG.
 *
 * `canResumeTui` asks whether a provider's CLI has a resume GRAMMAR — `claude --resume <id>`
 * typed into a pty. That is the wrong question for a structured session: there is no command
 * line, and the capability is the protocol's `session/load` plus a stored provider id.
 *
 * Getting this wrong is not cosmetic. `canResume: false` hides "Restart (resume)" and leaves
 * only the fresh restart, so the control that preserves the conversation disappears for
 * exactly the agents that now have one — and the menu would be telling the truth about a
 * capability Genie had and did not know it had.
 */
describe('an ACP session', () => {
    const acpSpec = (over: Record<string, unknown> = {}) =>
        ({ meta: { agent: 'claude', engine: 'acp', ...over } }) as never;

    it('can resume when Genie holds the provider’s session id', () => {
        const o = restartOptionsFor(acpSpec({ chat_session_id: 'cli-uuid' }));
        expect(o).toMatchObject({ isAgent: true, canResume: true, losesConversation: true });
    });

    /**
     * THE CASE THAT DISTINGUISHES, and the reason the claude tests above are not enough.
     *
     * `canResumeTui` is true for claude, so an ACP claude session reports `canResume: true`
     * whether or not anything is engine-aware — right answer, wrong reason, and a test that
     * cannot fail is not a test.
     *
     * Measured: `canResumeTui` is true for claude and codex, FALSE for gemini and kimi. All
     * four are ACP-capable. So a gemini ACP session has a resumable conversation (the
     * protocol's `session/load` plus a stored provider id) while its CLI has no `--resume`
     * flag at all — and keying on the pty grammar hides the control that preserves it.
     */
    it('can resume a provider with NO pty resume flag, because ACP does not use one', () => {
        const o = restartOptionsFor({
            meta: { agent: 'gemini', engine: 'acp', chat_session_id: 'cli-uuid' },
        } as never);
        expect(o.canResume).toBe(true);
    });

    it('cannot resume when no id was ever captured', () => {
        // A first launch, or a provider that reported none. Honest: there is nothing to
        // continue, and offering the control would produce a refusal.
        expect(restartOptionsFor(acpSpec()).canResume).toBe(false);
    });

    it('can always restart FRESH, which needs no id', () => {
        expect(restartOptionsFor(acpSpec()).canRestartFresh).toBe(true);
    });
});

describe('a PTY agent is unaffected', () => {
    it('still needs a resume grammar, not just an id', () => {
        // The inverse must keep working: aider has no `--resume`, so a captured id does not
        // make it resumable, and claiming otherwise would type a flag the CLI rejects.
        const noGrammar = { meta: { agent: 'aider', chat_session_id: 'x' } } as never;
        expect(restartOptionsFor(noGrammar).canResume).toBe(false);
    });

    it('resumes with a grammar AND an id, exactly as before', () => {
        const withBoth = { meta: { agent: 'claude', chat_session_id: 'x' } } as never;
        expect(restartOptionsFor(withBoth).canResume).toBe(true);
    });
});

describe('acpResumeSessionId — what an ACP session may CONTINUE', () => {
    /**
     * A MINTED id is not a captured one.
     *
     * `renderAgentLaunch` mints a uuid for claude's `--session-id` flag and stores it on the
     * spec before anything has run. For a pty that is fine: the CLI creates the session it
     * was handed. ACP never sends that command, so the session does not exist — and the ACP
     * launch read `capturedSessionId` to decide whether to `session/load`.
     *
     * Measured in `gapp-agents-launch`: the first launch of a GApp claude agent attempted to
     * resume a uuid no conversation had ever had. It recovered — the driver falls back to a
     * fresh session — which is exactly what made it invisible, and the fallback is also what
     * would hide a REAL resume failure.
     */
    it('refuses an id Genie minted, because no session was ever created under it', () => {
        expect(
            acpResumeSessionId({
                meta: { agent: 'claude', chat_session_id: 'minted-uuid', chat_session_id_minted: true },
            } as never),
        ).toBeNull();
    });

    it('returns an id that was actually CAPTURED', () => {
        // From `META_CLI_SESSION_ID` over ACP, or from the transcript on the pty path. Either
        // way a conversation exists under it, so continuing is the right default.
        expect(
            acpResumeSessionId({ meta: { agent: 'claude', chat_session_id: 'real-id' } } as never),
        ).toBe('real-id');
    });

    it('returns null when there is no id at all', () => {
        expect(acpResumeSessionId({ meta: { agent: 'claude' } } as never)).toBeNull();
        expect(acpResumeSessionId(null)).toBeNull();
    });

    it('does not change what the RESTART menu offers', () => {
        // Separate question, deliberately. `canResume` is about whether a control is worth
        // showing; this is about whether a handshake may claim a session exists. A minted id
        // still means "this agent has a session id", and the pty resume grammar still works
        // with it — so narrowing the menu here would remove a control that functions.
        const minted = {
            meta: { agent: 'claude', chat_session_id: 'minted-uuid', chat_session_id_minted: true },
        } as never;
        expect(capturedSessionId(minted)).toBe('minted-uuid');
    });
});
