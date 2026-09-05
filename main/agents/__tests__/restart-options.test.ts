import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS, canResumeTui } from '../registry';
import { capturedSessionId, restartOptionsFor } from '../restart-options';

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
