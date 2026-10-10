import { describe, expect, it } from 'vitest';
import { engineFor } from '../engine';

/**
 * Which engine an agent runs on.
 *
 * ## ACP IS NOT OPTIONAL
 *
 * Owner directive: *"acp is the core of our agent communications, this is not optional."*
 * No global flag. A provider that can speak ACP speaks it.
 *
 * This file previously pinned the OPPOSITE rule — "the default does not move", an agent on
 * the pty unless something said otherwise — which was correct while Genie 2 was a parallel
 * surface whose default flipped at the end. It is replaced rather than loosened, and the
 * reversal is recorded because the old rule was pinned deliberately: a future reader deserves
 * to know it was retired on purpose rather than forgotten.
 *
 * ## The flip was reverted once before it landed
 *
 * Measured, it turned 8 test files red, and those tests were right: an ACP session could not
 * resume a conversation, so making it the default would have discarded one on every Genie
 * restart — and a restart on the owner's machine wedged 21 of 32 agents the same day. It
 * landed only once `session/load` worked from a client (prism-acp 0.3.0), Genie captured and
 * persisted the provider's session id, `restartOptionsFor` became engine-aware, and
 * `ACP_PROVIDERS` was corrected to mean capability rather than intent.
 */

describe('engineFor', () => {
    it('is ACP for a provider that can speak it — no flag, no opt-in', () => {
        expect(engineFor({ provider: 'claude' })).toBe('acp');
    });

    it('covers every provider that can actually run on ACP', () => {
        // The list is `ACP_PROVIDERS` and it means CAPABILITY: codex was in it while
        // `acpLaunch` refused it, so every codex agent was routed to an engine that declined
        // it and never started.
        for (const p of ['claude', 'gemini', 'kimi']) {
            expect(engineFor({ provider: p })).toBe('acp');
        }
    });

    it('keeps CODEX on the pty, because ACP cannot launch it yet', () => {
        // Not a preference: `acpLaunch` refuses it `no-acp-mode` until prism ships a driver.
        // `main/acp/__tests__/engine-launch-agree.test.ts` holds the two halves together.
        // CODEX IS ACP-CAPABLE NOW — prism-acp 0.5.4 ships a first-party `CodexDriver`, and a real
        // child completes `initialize` with no API key and drives a real turn. The old assertion
        // here (`'pty'`) encoded the holdback, not a property of codex, and the comment above it
        // named the condition for lifting it. Rewritten to the new contract rather than loosened.
        expect(engineFor({ provider: 'codex' })).toBe('acp');
    });

    it('stays on the pty for a provider with no ACP mode', () => {
        // Not a refusal — aider has no structured mode and keeps working exactly as today.
        expect(engineFor({ provider: 'aider' })).toBeNull();
        expect(engineFor({ provider: 'goose' })).toBeNull();
    });

    it('stays on the pty when the provider is unknown', () => {
        // A null provider is already "unknown" fidelity to the session model. Starting a
        // structured session for something we cannot name would be a guess about which
        // binary to run.
        expect(engineFor({ provider: null })).toBeNull();
    });

    it('has no way to hold an agent back ONTO a terminal', () => {
        // This asserted a 'pty' pin was honoured. Agents do not run in terminals, so the pin
        // has no target; a capable provider resolves to ACP whatever the override says.
        expect(engineFor({ provider: 'claude', agentOverride: 'acp' })).toBe('acp');
    });

    it('honours an explicit ACP override, which changes nothing for a capable provider', () => {
        expect(engineFor({ provider: 'claude', agentOverride: 'acp' })).toBe('acp');
    });

    it('REFUSES an ACP override for a provider that cannot do it', () => {
        // Capability before preference, in the old rule and this one. An override cannot
        // conjure a server that does not exist, and honouring it would spawn something that
        // is not an ACP server and then hang in the handshake.
        expect(engineFor({ provider: 'aider', agentOverride: 'acp' })).toBeNull();
        // Previously this proved an override cannot CONJURE a capability. Codex now has one, so the
        // case needs a provider that genuinely lacks it or it proves nothing.
        expect(engineFor({ provider: 'aider', agentOverride: 'acp' })).toBeNull();
    });
});
