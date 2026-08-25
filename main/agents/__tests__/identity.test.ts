import { describe, expect, it } from 'vitest';
import {
    agentDisplay,
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
