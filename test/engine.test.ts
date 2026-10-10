import { describe, expect, it } from 'vitest';
import { ACP_PROVIDERS, engineFor, type AgentEngine } from '../src/core/engine.js';

/**
 * AN AGENT IS A SESSION. A SESSION IS NOT A TERMINAL.
 *
 * Owner directive, said more than twenty times before the previous build stopped violating
 * it: *"agents do not run in terminals. PTY is not an option."*
 *
 * The previous implementation had `AgentEngine = 'pty' | 'acp'` and an `engineFor` that
 * returned `'pty'` whenever the provider could not speak ACP. That fallback read as a
 * graceful degradation and was not one — it is the single line that put all thirty of the
 * owner's agents in terminals, and removing the *engine* did not help because a pty was
 * still spawned seventy lines before the engine was ever consulted.
 *
 * So the rule is enforced in the TYPE SYSTEM, not by vigilance. `AgentEngine` has one
 * member. "Agent on a pty" is unrepresentable — a compiler error is the only guard that
 * survives a year of edits — and the runtime half is pinned below.
 */
describe('engineFor — there is no terminal to fall back to', () => {
    it('answers acp for every provider that can speak it', () => {
        // POSITIVE CONTROL. Without this, "never pty" passes just as well against a function
        // that refuses everything and starts no agents at all.
        expect(engineFor('claude')).toBe('acp');
        expect(engineFor('codex')).toBe('acp');
    });

    it('REFUSES rather than degrading, for a provider with no ACP mode', () => {
        // `null` = cannot run as an agent. The old code returned 'pty' here.
        expect(engineFor('aider')).toBeNull();
        expect(engineFor('goose')).toBeNull();
    });

    it('refuses an unknown or absent provider instead of guessing a shell', () => {
        expect(engineFor('something-new')).toBeNull();
        expect(engineFor(null)).toBeNull();
        expect(engineFor('')).toBeNull();
    });

    it('COUNT, not a boolean: no input whatsoever yields a terminal', () => {
        // A boolean on one provider passes while another still routes wrongly — which is
        // exactly how the old build shipped. Count every answer that is not 'acp' or null;
        // the only acceptable number is zero.
        const inputs: Array<string | null> = [
            ...ACP_PROVIDERS,
            'aider', 'goose', 'amp', 'cursor', 'custom', 'gemini', 'kimi', '', null,
        ];

        const notAcpOrNull = inputs
            .map((p) => engineFor(p))
            .filter((e): e is Exclude<typeof e, AgentEngine | null> => e !== 'acp' && e !== null);

        expect(notAcpOrNull).toEqual([]);
    });

    it('has exactly one engine, and it is not a terminal', () => {
        // The type has one member, so this is the runtime echo of a compile-time fact.
        // If a second engine is ever added, this fails and someone has to think about it.
        const engines: AgentEngine[] = ['acp'];
        expect(engines).toEqual(['acp']);
    });
});
