import { describe, expect, it } from 'vitest';
import {
    agentDisplay,
    unifiedAgentId,
    needsIdentityRewrite,
    agentName,
    agentRef,
    isAgentProvider,
    parseAgentRef,
    savedAgentKey,
} from '../identity';

/**
 * An agent's identity, in its two forms (Tynn #254).
 *
 * The property this file is really defending is the SPLIT: the machine-facing
 * ref carries the chat-id and the human-facing display cannot. Both had been
 * "the label", assembled ad hoc, which is how a chat-id ends up in a header and
 * how an agent ends up unaddressable.
 */

describe('the saved-config key', () => {
    it('is provider + name, with NO chat-id', () => {
        expect(savedAgentKey('claude', 'tynn')).toBe('claude:tynn');
        expect(savedAgentKey('codex', 'tynn-slave')).toBe('codex:tynn-slave');
    });

    it('is what makes a Codex agent resolvable BEFORE its harness runs', () => {
        // The constraint the whole design bends around: Codex's session id does
        // not exist until SessionStart fires, so anything needed to FIND a saved
        // agent must be knowable without it. This is that assertion — the key is
        // computable from what a caller types.
        const key = savedAgentKey('codex', 'tynn-slave');
        expect(key).not.toContain(':' + 'undefined');
        expect(key.split(':')).toHaveLength(2);
    });

    it('normalises the name the same way the AgentInbox purpose does', () => {
        // One field, one normaliser. A second name with its own rules would let
        // the ref and the inbox disagree about what an agent is called.
        expect(savedAgentKey('claude', 'Tynn Slave')).toBe('claude:tynn-slave');
        expect(agentName('  MY Agent!! ')).toBe('my-agent');
        expect(agentName('')).toBe('general');
        expect(agentName(undefined)).toBe('general');
    });
});

describe('the canonical ref', () => {
    it('is provider:name:chat-id when the chat-id is bound', () => {
        expect(
            agentRef({ provider: 'claude', name: 'tynn', chatSessionId: 'abc-123' }),
        ).toBe('claude:tynn:abc-123');
    });

    it('degrades to the key — not an empty third field — before the bind', () => {
        // Codex spends its entire startup in this state, and `codex:tynn-slave:`
        // reads as "its chat is called nothing" rather than "not bound yet".
        expect(agentRef({ provider: 'codex', name: 'tynn-slave', chatSessionId: null })).toBe(
            'codex:tynn-slave',
        );
        expect(agentRef({ provider: 'codex', name: 'tynn-slave' })).toBe('codex:tynn-slave');
        expect(agentRef({ provider: 'codex', name: 'tynn-slave', chatSessionId: '  ' })).toBe(
            'codex:tynn-slave',
        );
    });

    it('round-trips through parse, in both forms', () => {
        for (const ref of ['claude:tynn:abc-123', 'codex:tynn-slave']) {
            const parsed = parseAgentRef(ref);
            expect(parsed).not.toBeNull();
            expect(agentRef(parsed!)).toBe(ref);
        }
    });

    it('keeps a chat-id that contains a colon whole', () => {
        // Taken as the REMAINDER, so a harness whose session ids are structured
        // is not silently truncated into a different agent's address.
        expect(parseAgentRef('claude:tynn:sess:2026:01')?.chatSessionId).toBe('sess:2026:01');
    });

    it('rejects what is not a ref', () => {
        expect(parseAgentRef('')).toBeNull();
        expect(parseAgentRef('tynn')).toBeNull(); // no provider
        expect(parseAgentRef(':tynn')).toBeNull(); // empty provider
        expect(parseAgentRef('claude:')).toBeNull(); // empty name
        expect(parseAgentRef('gemini:tynn')).toBeNull(); // not a provider Genie runs
    });

    it('knows which providers are ours', () => {
        expect(isAgentProvider('claude')).toBe(true);
        expect(isAgentProvider('codex')).toBe(true);
        expect(isAgentProvider('kiwi')).toBe(true);
        expect(isAgentProvider('genie')).toBe(true);
        expect(isAgentProvider('custom')).toBe(true);
        expect(isAgentProvider('CLAUDE')).toBe(false);
        expect(isAgentProvider(undefined)).toBe(false);
    });
});

describe('the human-facing display', () => {
    it('is the provider and the name — and structurally CANNOT carry a chat-id', () => {
        const shown = agentDisplay({
            provider: 'claude',
            name: 'tynn',
            chatSessionId: 'abc-123',
        });
        expect(shown).toEqual({ provider: 'claude', name: 'tynn' });
        // Not a filter that a future edit can forget to apply: the chat-id has
        // nowhere to go in the returned shape.
        expect(Object.values(shown).join(' ')).not.toContain('abc-123');
    });

    it('distinguishes two agents of the same name by PROVIDER alone', () => {
        // Which is what lets the renderer draw two different logos for them. If
        // this collapsed, `claude:tynn` and `codex:tynn` would be one row twice.
        const a = agentDisplay({ provider: 'claude', name: 'tynn' });
        const b = agentDisplay({ provider: 'codex', name: 'tynn' });
        expect(a.name).toBe(b.name);
        expect(a.provider).not.toBe(b.provider);
    });
});

/**
 * ONE agent, ONE id.
 *
 * AMS and AgentInbox each invented an identity for the same agent:
 *
 *     AgentInbox   terminal_specs.meta.agent_id   a uuid  (c024b80b…)
 *     AMS          workspace_agents.id            agent:<terminalSpecId>
 *
 * Nothing reconciled them, so an agent could be READY in one and INVISIBLE in
 * the other at once. Measured live: `thumbsUp` set `ready_at` on
 * `agent:f633f4ed…` while `agentinbox list` returned no `self`, because the
 * broker was looking for `c024b80b…`. Both calls returned ok. Neither helped.
 *
 * THE INBOX ID WINS, and the direction is not a preference: it already keys
 * durable messages, read receipts and peer addressing, so renaming it would
 * break message history and every saved reference. The AMS row is newer and
 * nothing outside AMS points at its id, so it is the one that moves.
 */
describe('unifiedAgentId', () => {
    it('adopts the inbox id when the terminal already has one', () => {
        expect(unifiedAgentId({ inboxAgentId: 'c024b80b', amsId: 'agent:term-1' })).toBe('c024b80b');
    });

    it('keeps the AMS id when the terminal has no inbox identity yet', () => {
        // A registered agent that has never been started has no terminal and no
        // inbox id. Minting one here would invent an identity nothing agreed to.
        expect(unifiedAgentId({ inboxAgentId: null, amsId: 'uuid-fresh' })).toBe('uuid-fresh');
    });

    it('ignores a blank inbox id rather than adopting an empty identity', () => {
        expect(unifiedAgentId({ inboxAgentId: '   ', amsId: 'agent:term-1' })).toBe('agent:term-1');
    });
});

describe('needsIdentityRewrite', () => {
    it('flags a legacy agent:<specId> row that has an inbox id to adopt', () => {
        expect(needsIdentityRewrite({ inboxAgentId: 'c024b80b', amsId: 'agent:term-1' })).toBe(true);
    });

    it('does NOT rewrite a row that already agrees', () => {
        // Idempotence: the migration must be safe to re-run, and a row rewritten
        // to itself would churn updated_at and make every launch look like a change.
        expect(needsIdentityRewrite({ inboxAgentId: 'c024b80b', amsId: 'c024b80b' })).toBe(false);
    });

    it('does NOT rewrite a workspace-level row, which has no terminal', () => {
        // The TWA rows are not terminal-backed, have no inbox identity to adopt,
        // and are the target of `parent_agent_id` — their ids must not move.
        expect(needsIdentityRewrite({ inboxAgentId: null, amsId: 'workspace:ws-1' })).toBe(false);
    });
});
