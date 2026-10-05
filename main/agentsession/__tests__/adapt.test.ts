import { describe, expect, it } from 'vitest';
import { handoffAt, inboxAgentIdOf, mailFrom } from '../adapt';

/**
 * The impure bindings are delegation, but three decisions inside them are not, and
 * each has a known-expensive way to get it wrong. They live here so they are tested
 * without a database, a broker or a disk.
 */

describe('inboxAgentIdOf — THE TWO IDS', () => {
    it('reads the terminal meta id, which is what the broker is keyed on', () => {
        expect(inboxAgentIdOf({ agent_id: 'inbox-7' })).toBe('inbox-7');
    });

    it('returns null when the terminal carries none', () => {
        // And NOT the spec id, and not the workspace_agents id. host-tools states the
        // cost of mixing them up: "Reading one id for both is not a subtle bug — it
        // reports every healthy agent on the machine as unreachable." A null here
        // means "no mail readable for this agent", which is true and harmless.
        expect(inboxAgentIdOf({})).toBeNull();
        expect(inboxAgentIdOf(undefined)).toBeNull();
        expect(inboxAgentIdOf({ agent_id: '' })).toBeNull();
        expect(inboxAgentIdOf({ agent_id: '   ' })).toBeNull();
    });

    it('ignores a non-string meta value', () => {
        expect(inboxAgentIdOf({ agent_id: 42 as unknown as string })).toBeNull();
    });
});

describe('mailFrom', () => {
    const msg = (over: Record<string, unknown> = {}) => ({
        id: 'm1',
        from: 'human',
        fromLabel: 'You',
        text: 'hello',
        ts: 1_000,
        ...over,
    });

    it('calls a message from the human a human message', () => {
        expect(mailFrom([msg()], 'inbox-7')).toEqual([
            { id: 'm1', from: 'human', author: null, body: 'hello', at: 1_000 },
        ]);
    });

    it('calls the agent own messages its own', () => {
        expect(mailFrom([msg({ from: 'inbox-7', fromLabel: 'kai' })], 'inbox-7')[0]).toMatchObject({
            from: 'agent',
            author: null,
        });
    });

    it('calls anybody else a peer, and NAMES them', () => {
        // Without the name the transcript shows a sibling agent's words as if the
        // owner had said them, which is how you end up answering your own agent.
        expect(mailFrom([msg({ from: 'inbox-9', fromLabel: 'vale' })], 'inbox-7')[0]).toMatchObject({
            from: 'peer',
            author: 'vale',
        });
    });

    it('falls back to the sender id when a peer has no label', () => {
        expect(mailFrom([msg({ from: 'inbox-9', fromLabel: '' })], 'inbox-7')[0]!.author).toBe('inbox-9');
    });

    it('drops a message with no text rather than rendering a blank row', () => {
        expect(mailFrom([msg({ text: '' }), msg({ id: 'm2' })], 'inbox-7').map((m) => m.id)).toEqual(['m2']);
    });

    it('treats every message as a peer when the agent own id is unknown', () => {
        // Better to attribute nothing to the agent than to attribute somebody else's
        // words to it.
        expect(mailFrom([msg({ from: 'inbox-7', fromLabel: 'kai' })], null)[0]).toMatchObject({
            from: 'peer',
            author: 'kai',
        });
    });
});

describe('handoffAt', () => {
    it('prefers the time the note states', () => {
        expect(handoffAt(5_000, 9_000)).toBe(5_000);
    });

    it('falls back to the file mtime when the note does not say', () => {
        // A real fact about the file, unlike `Date.now()`, which would date a
        // month-old note to this second and float it to the top of a transcript.
        expect(handoffAt(null, 9_000)).toBe(9_000);
    });

    it('is null when neither is known, so the caller can decline the note', () => {
        expect(handoffAt(null, null)).toBeNull();
    });
});
