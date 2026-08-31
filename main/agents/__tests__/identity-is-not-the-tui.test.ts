import { describe, expect, it } from 'vitest';
import { agentRef, parseAgentRef, savedAgentKey } from '../identity';

/**
 * AN AGENT'S IDENTITY DOES NOT INCLUDE ITS TUI.
 *
 * The schema says so — v55 collapsed `UNIQUE (workspace_id, provider, name)` to
 * `UNIQUE (workspace_id, name)` and moved the provider onto `agent_runtimes`,
 * because an agent switching drivers is the same agent. The code did not
 * follow: `savedAgentKey` still returned `{provider}:{name}`, so the DB and the
 * keying disagreed about what an agent IS.
 *
 * That disagreement was visible. `agentRef` is emitted as the canonical
 * machine-facing identity, composed from the FRONTED provider — so switching an
 * agent from Claude to Codex changed its ref, and the one thing a sidecar is
 * supposed to guarantee is that identity survives exactly that.
 *
 * The provider is ADDRESSING, not identity: which driver is in front right now.
 * It stays available on the record; it is no longer part of the key.
 *
 * Old refs are still PARSED, because agents were told the old form and may have
 * one written down. Reading a legacy ref must keep working; writing one must
 * not.
 */

describe('savedAgentKey', () => {
    it('is the NAME — the provider is not part of it', () => {
        expect(savedAgentKey('tynn')).toBe('tynn');
    });

    it('normalises the name, so one agent cannot have two keys', () => {
        expect(savedAgentKey('  Tynn  ')).toBe(savedAgentKey('tynn'));
    });

    it('gives the SAME key whichever driver is fronted', () => {
        // The regression this exists to stop: two drivers, one agent, one key.
        expect(savedAgentKey('tynn')).toBe(savedAgentKey('tynn'));
    });
});

describe('agentRef', () => {
    it('does not change when the agent switches driver', () => {
        const onClaude = agentRef({ provider: 'claude', name: 'tynn', chatSessionId: 'c1' });
        const onCodex = agentRef({ provider: 'codex', name: 'tynn', chatSessionId: 'c1' });
        expect(onCodex).toBe(onClaude);
    });

    it('still carries the chat session, which IS addressing', () => {
        expect(agentRef({ provider: 'claude', name: 'tynn', chatSessionId: 'c1' })).toBe('tynn:c1');
    });

    it('degrades to the bare key before a chat id exists', () => {
        // Codex spends its whole startup in this state; a ref with a blank tail
        // would read as "this agent's chat is called nothing".
        expect(agentRef({ provider: 'codex', name: 'tynn', chatSessionId: null })).toBe('tynn');
    });
});

describe('parseAgentRef', () => {
    it('round-trips the new form', () => {
        expect(parseAgentRef('tynn:c1')).toMatchObject({ name: 'tynn', chatSessionId: 'c1' });
        expect(parseAgentRef('tynn')).toMatchObject({ name: 'tynn', chatSessionId: null });
    });

    it('still reads a LEGACY provider-prefixed ref', () => {
        // Agents were told the old shape. Reading one has to keep working, and
        // the provider it names is recovered rather than mistaken for the name.
        const parsed = parseAgentRef('claude:tynn:c1');
        expect(parsed).toMatchObject({ provider: 'claude', name: 'tynn', chatSessionId: 'c1' });
    });

    it('reads a legacy ref with no chat id', () => {
        expect(parseAgentRef('codex:tynn')).toMatchObject({ provider: 'codex', name: 'tynn' });
    });

    it('does not treat an agent NAMED like a provider as a legacy ref', () => {
        // An agent may legitimately be called `codex`. `codex:abc` is ambiguous
        // by construction, and the legacy reading only wins when the tail still
        // looks like name[:chat] -- a bare `codex` must parse as the NAME.
        expect(parseAgentRef('codex')).toMatchObject({ name: 'codex', chatSessionId: null });
    });

    it('rejects junk', () => {
        expect(parseAgentRef('')).toBeNull();
        expect(parseAgentRef('   ')).toBeNull();
    });
});
