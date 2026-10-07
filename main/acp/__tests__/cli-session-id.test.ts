import { describe, expect, it } from 'vitest';
import { META_CLI_SESSION_ID } from '@particle-academy/prism-acp';
import { applySessionUpdate } from '../update-to-session';
import { emptyAgentSession } from '../../agentsession/model';

/**
 * Capturing the CLI's session id — the one thing resume cannot work without.
 *
 * ACP's `session/new` returns an id prism-acp MINTS (`sess_<n>_<timestamp>`). The provider's
 * real id is a different string, and `session/load` needs THAT one. Passing ACP's id gets a
 * refusal naming the key (prism-acp 0.3.0); before 0.3.0 the id was recorded as unmapped and
 * reached nobody at all, which is why resume was unreachable from a client.
 *
 * It rides on the FIRST `session/update` of a session, deliberately: a session can die before
 * its first turn finishes, and you cannot store what you were never sent.
 *
 * ## The failure this prevents, in the provider's own words
 *
 * Prism probed the CLI rather than reasoning about it. A non-UUID gives *"is not a UUID and
 * does not match any session title"*; a well-formed but unknown UUID gives *"No conversation
 * found with session ID"*. Both `is_error: true`, zero turns, zero cost.
 *
 * So Genie's standing doctrine — *"a wrong resume flag does not error, it starts a FRESH
 * conversation"* — is NOT true of `--resume` on claude 2.1.292. The real hazard is narrower
 * and worse-shaped: it errors ONE TURN TOO LATE, after the load has already reported success.
 * Which is exactly why the id has to be the right one up front.
 */

const NOW = 1_700_000_000_000;
const identity = {
    agentId: 'ag-1', specId: 'spec-1', provider: 'claude',
    name: 'kai', cwd: '/repo', workspaceId: 'ws-1',
};
const CLI_ID = '9f1c2f84-0000-4000-8000-5a6b7c8d9e01';

const chunk = (meta?: Record<string, unknown>) =>
    ({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'working' },
        ...(meta ? { _meta: meta } : {}),
    }) as never;

describe('the CLI session id', () => {
    it('is captured from the first update that carries it', () => {
        const s = applySessionUpdate(
            emptyAgentSession(identity, NOW),
            chunk({ [META_CLI_SESSION_ID]: CLI_ID }),
            NOW,
        );
        expect(s.session.sessionId).toBe(CLI_ID);
    });

    it('is NOT overwritten by a later update that omits it', () => {
        // Every subsequent chunk arrives without `_meta`. Letting that clear the id would
        // lose resume one message after gaining it.
        let s = applySessionUpdate(emptyAgentSession(identity, NOW), chunk({ [META_CLI_SESSION_ID]: CLI_ID }), NOW);
        s = applySessionUpdate(s, chunk(), NOW);
        expect(s.session.sessionId).toBe(CLI_ID);
    });

    it('does not invent one when the provider never sends it', () => {
        // A provider that reports no id cannot be resumed, and saying so is the honest
        // answer — `restartOptionsFor` keys `canResume` off exactly this.
        const s = applySessionUpdate(emptyAgentSession(identity, NOW), chunk(), NOW);
        expect(s.session.sessionId).toBeNull();
    });

    it('ignores a non-string id rather than storing a number', () => {
        // `_meta` is `unknown` on the wire. Storing a number would be passed to
        // `session/load` and refused one turn later, which is the late-error shape.
        const s = applySessionUpdate(emptyAgentSession(identity, NOW), chunk({ [META_CLI_SESSION_ID]: 42 }), NOW);
        expect(s.session.sessionId).toBeNull();
    });

    it('ignores an empty string, which is not an id', () => {
        const s = applySessionUpdate(emptyAgentSession(identity, NOW), chunk({ [META_CLI_SESSION_ID]: '  ' }), NOW);
        expect(s.session.sessionId).toBeNull();
    });

    it('rides on ANY update kind, not just a message chunk', () => {
        // Prism says "the first session/update of every session". Keying off one kind would
        // miss a session whose first update happened to be a tool call.
        const s = applySessionUpdate(
            emptyAgentSession(identity, NOW),
            { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', status: 'pending', _meta: { [META_CLI_SESSION_ID]: CLI_ID } } as never,
            NOW,
        );
        expect(s.session.sessionId).toBe(CLI_ID);
    });
});
