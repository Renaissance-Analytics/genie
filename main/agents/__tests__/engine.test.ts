import { describe, expect, it } from 'vitest';
import { engineFor } from '../engine';

/**
 * Which engine an agent runs on.
 *
 * One rule dominates: **the default does not move.** The owner's decision was that
 * Genie 2 is a parallel surface and the default flips at the end, so an agent runs on
 * the pty unless something explicitly says otherwise. Getting that backwards would
 * change how every existing agent starts, silently, on upgrade — and I have already
 * exceeded that decision twice in this work (defaulting the route to the Deck, then
 * giving it a global key), which is why it is pinned here rather than assumed.
 */

describe('engineFor', () => {
    it('is the pty by default', () => {
        expect(engineFor({ provider: 'claude', acpEnabled: false })).toBe('pty');
    });

    it('is ACP only when explicitly enabled', () => {
        expect(engineFor({ provider: 'claude', acpEnabled: true })).toBe('acp');
    });

    it('stays on the pty for a provider with no ACP mode, even when enabled', () => {
        // Not a refusal — aider simply has no structured mode, and it keeps working
        // exactly as it does today. "Enabled" is permission, not a promise.
        expect(engineFor({ provider: 'aider', acpEnabled: true })).toBe('pty');
        expect(engineFor({ provider: 'goose', acpEnabled: true })).toBe('pty');
    });

    it('covers every provider that has an ACP mode', () => {
        for (const p of ['claude', 'codex', 'gemini', 'kimi']) {
            expect(engineFor({ provider: p, acpEnabled: true })).toBe('acp');
        }
    });

    it('stays on the pty when the provider is unknown', () => {
        // A null provider is already "unknown" fidelity to the session model. Starting a
        // structured session for something we cannot name would be a guess about which
        // binary to run.
        expect(engineFor({ provider: null, acpEnabled: true })).toBe('pty');
    });

    it('lets a PER-AGENT choice override the global setting, both ways', () => {
        // An agent the owner has moved across keeps its engine when the global flag is
        // off, and an agent explicitly held back keeps the pty when it is on. Without
        // both directions the override is only half a control.
        expect(engineFor({ provider: 'claude', acpEnabled: false, agentOverride: 'acp' })).toBe('acp');
        expect(engineFor({ provider: 'claude', acpEnabled: true, agentOverride: 'pty' })).toBe('pty');
    });

    it('refuses a per-agent ACP override for a provider that cannot do it', () => {
        // The override is a preference, not a capability. Honouring it would spawn
        // something that is not an ACP server and then hang in the handshake.
        expect(engineFor({ provider: 'aider', acpEnabled: false, agentOverride: 'acp' })).toBe('pty');
    });
});
