import { describe, expect, it } from 'vitest';
import { resolveAgentAddress, type AddressablePeer } from '../address';

/**
 * ADDRESSING A PEER BY NAME, not by uuid.
 *
 * The owner's ask: "we need to change the way agents start other agents in dm's
 * and channels. They should not have to use an id and should be able to use the
 * agent tag, the {workspace}:{provider}:{agent} tag thing we changed to."
 *
 * `list` already hands every peer a `ref` — `{provider}:{name}[:{chat-id}]` —
 * and calls it "the identity a person or an agent can actually say out loud".
 * But `send` only accepted `agentId`, a uuid, so the one field an agent could
 * READ was the one field it could not USE. That is the whole gap.
 *
 * A second, independent reason arrived from a peer agent the same day: it built
 * a button that stored a configured agentId, and reasoned out that the id is
 * only stable while the TERMINAL is. A name survives a terminal replacement; a
 * uuid does not.
 *
 * Reachability is deliberately NOT decided here. This turns a name into an
 * address; the broker's existing scope check still owns who may be reached, so
 * there is exactly one ACL and this cannot drift from it.
 */
const peer = (over: Partial<AddressablePeer> = {}): AddressablePeer => ({
    agentId: 'uuid-tynn',
    ref: 'claude:tynn',
    workspaceId: 'ws-1',
    slug: 'demo',
    ...over,
});

describe('resolveAgentAddress', () => {
    const CALLER = 'ws-1';

    it('passes a raw agentId straight through', () => {
        // Back-compat is not optional: every agent written against the old
        // contract keeps working, and a uuid can never collide with a ref
        // because a ref must name a known provider.
        const got = resolveAgentAddress('uuid-tynn', [peer()], CALLER);

        expect(got).toEqual({ ok: true, agentId: 'uuid-tynn' });
    });

    it('resolves {provider}:{name} inside the callers own workspace', () => {
        const got = resolveAgentAddress('claude:tynn', [peer()], CALLER);

        expect(got).toEqual({ ok: true, agentId: 'uuid-tynn' });
    });

    it('resolves a FULL ref with a chat-id, since that is what `list` prints', () => {
        const got = resolveAgentAddress(
            'claude:tynn:chat-abc',
            [peer({ ref: 'claude:tynn:chat-abc' })],
            CALLER,
        );

        expect(got).toEqual({ ok: true, agentId: 'uuid-tynn' });
    });

    it('matches on the {provider}:{name} half when the chat-id has since changed', () => {
        // A chat-id is rebound on relaunch. An agent holding yesterday's full ref
        // means the same agent, and refusing it would make the durable half of
        // the identity useless.
        const got = resolveAgentAddress(
            'claude:tynn:stale-chat',
            [peer({ ref: 'claude:tynn:fresh-chat' })],
            CALLER,
        );

        expect(got).toEqual({ ok: true, agentId: 'uuid-tynn' });
    });

    it('reaches another workspace with {slug}:{provider}:{name}', () => {
        const peers = [
            peer(),
            peer({ agentId: 'uuid-far', ref: 'codex:builder', workspaceId: 'ws-2', slug: 'ripple' }),
        ];

        const got = resolveAgentAddress('ripple:codex:builder', peers, CALLER);

        expect(got).toEqual({ ok: true, agentId: 'uuid-far' });
    });

    it('prefers the CALLERS workspace when the same name exists elsewhere', () => {
        // Otherwise `claude:tynn` would silently mean a stranger's agent as soon
        // as another workspace happened to name one the same.
        const peers = [
            peer({ agentId: 'uuid-far', workspaceId: 'ws-2', slug: 'ripple' }),
            peer({ agentId: 'uuid-mine' }),
        ];

        const got = resolveAgentAddress('claude:tynn', peers, CALLER);

        expect(got).toEqual({ ok: true, agentId: 'uuid-mine' });
    });

    it('REFUSES an ambiguous name rather than guessing between strangers', () => {
        const peers = [
            peer({ agentId: 'uuid-a', workspaceId: 'ws-2', slug: 'ripple' }),
            peer({ agentId: 'uuid-b', workspaceId: 'ws-3', slug: 'orr' }),
        ];

        const got = resolveAgentAddress('claude:tynn', peers, CALLER);

        expect(got.ok).toBe(false);
        if (got.ok) throw new Error('unreachable');
        // The fix has to be IN the message: naming the qualified forms means the
        // agent can retry without going to read documentation.
        expect(got.error).toContain('ripple:claude:tynn');
        expect(got.error).toContain('orr:claude:tynn');
    });

    it('names who IS reachable when the tag matches nobody', () => {
        const got = resolveAgentAddress('claude:ghost', [peer()], CALLER);

        expect(got.ok).toBe(false);
        if (got.ok) throw new Error('unreachable');
        expect(got.error).toContain('claude:tynn');
    });

    it('leaves reachability to the broker — an unreachable peer still RESOLVES', () => {
        // Two ACLs would drift. The broker already refuses a peer the caller may
        // not reach, with a message written for that case; deciding it here as
        // well would produce two different refusals for one situation.
        const got = resolveAgentAddress('claude:tynn', [peer()], 'ws-other');

        expect(got).toEqual({ ok: true, agentId: 'uuid-tynn' });
    });

    it('treats an unknown provider as a plain id, not a malformed tag', () => {
        // `notaprovider:thing` is not a ref at all. Reporting it as a bad tag
        // would be wrong for anyone whose agentId genuinely contains a colon.
        const got = resolveAgentAddress('notaprovider:thing', [peer()], CALLER);

        expect(got).toEqual({ ok: true, agentId: 'notaprovider:thing' });
    });
});
