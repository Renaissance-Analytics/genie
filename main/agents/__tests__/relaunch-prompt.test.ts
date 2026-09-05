import { describe, expect, it } from 'vitest';
import { agentRelaunchPrompt } from '../relaunch-prompt';
import { quotable, withProviderStartupInstructions } from '../startup';

/**
 * genie#434 — a RESTART is a launch too, and it was the only one that said
 * nothing.
 *
 * The fresh path composes `agentBootPrompt` and hands it to the TUI as an
 * opening prompt. Every RELAUNCH path — the restart button, a revive, the drain
 * restore after an upgrade — composed nothing of its own: at best it replayed
 * the ORIGINAL launch instructions (a snapshot of a different moment), and for
 * a spec written before those were persisted, or by a surface that never set
 * them, it delivered a bare resume line. So the agent came back with no
 * instruction to re-establish the Genie channel and no way for anyone to tell
 * whether it had.
 *
 * These are pure: what gets injected is this function's return value.
 */
describe('agentRelaunchPrompt — genie#434', () => {
    it('asks a RESUMED agent to reconnect and confirm', () => {
        const out = agentRelaunchPrompt({ genieAvailable: true, resumed: true });

        expect(out).toContain('connectToGenie');
        expect(out).toContain('thumbsUp');
        // The reason has to be one the tool ACCEPTS. `thumbsUp`'s enum is
        // boot / ack / shutdown, and anything else is silently coerced to
        // `ack` — so a prompt asking for `restart` would produce a signal
        // that does not mean what the prompt said it meant.
        expect(out).toMatch(/reason\s+boot\b/);
        // It must say the conversation SURVIVED, or an agent handed a fresh
        // instruction at the top of a resumed transcript re-does its work.
        expect(out).toMatch(/resumed/i);
    });

    it('tells an agent whose conversation could NOT be resumed that it is fresh', () => {
        const out = agentRelaunchPrompt({ genieAvailable: false, resumed: false });
        expect(out).toBe('');

        const withGenie = agentRelaunchPrompt({ genieAvailable: true, resumed: false });
        expect(withGenie).toContain('connectToGenie');
        expect(withGenie).toContain('thumbsUp');
        expect(withGenie).toMatch(/fresh session/i);
        expect(withGenie).not.toMatch(/pick up where you left off/i);
    });

    it('says NOTHING when this workspace cannot serve the genie tools', () => {
        // Same rule as `agentBootPrompt`: naming a tool the agent has no way to
        // call is the boot prompt's own definition of a lie, and a restart is
        // not an exception to it.
        expect(agentRelaunchPrompt({ genieAvailable: false, resumed: true })).toBe('');
        expect(
            agentRelaunchPrompt({ genieAvailable: false, resumed: true, saved: 'be excellent' }),
        ).toBe('be excellent');
    });

    it('carries the agent standing launch instructions AFTER the relaunch line', () => {
        const out = agentRelaunchPrompt({
            genieAvailable: true,
            resumed: true,
            saved: 'Adopt your specialized persona from /p/AGENT.md.',
        });

        expect(out).toContain('Adopt your specialized persona from /p/AGENT.md.');
        // The relaunch line comes FIRST: it is about THIS launch, and the
        // standing instructions routinely open with "before starting anything".
        expect(out.indexOf('connectToGenie')).toBeLessThan(out.indexOf('Adopt your'));
    });

    it('ignores blank saved instructions rather than emitting an empty paragraph', () => {
        const out = agentRelaunchPrompt({ genieAvailable: true, resumed: true, saved: '   ' });
        expect(out).not.toMatch(/\n\n\s*$/);
        expect(out).toBe(agentRelaunchPrompt({ genieAvailable: true, resumed: true }));
    });

    /**
     * The prompt is delivered as ONE double-quoted argv element typed into a
     * live shell, and `quotable` STRIPS `"` `` ` `` `$` `!` `%` rather than
     * escaping them (agents/startup.ts). So markdown backticks around a tool
     * name arrive with the name pulled apart — which is exactly what this
     * prompt cannot afford, because the tool names ARE the instruction.
     */
    it('survives the shell quoting with both tool names intact', () => {
        for (const resumed of [true, false]) {
            const rendered = quotable(agentRelaunchPrompt({ genieAvailable: true, resumed }));
            expect(rendered).toContain('connectToGenie');
            expect(rendered).toContain('thumbsUp');
            // POSITIVE CONTROL for the assertion above: `quotable` really does
            // pull a backticked name apart, so "it survived" is a fact about
            // this text and not about a no-op sanitizer.
            expect(quotable('call `connectToGenie` now')).not.toContain('`connectToGenie`');
        }
    });

    it('renders onto a claude resume line as a positional prompt', () => {
        const line = withProviderStartupInstructions(
            'claude',
            'claude --dangerously-skip-permissions --resume abc-123',
            agentRelaunchPrompt({ genieAvailable: true, resumed: true }),
        );
        expect(line).toMatch(/^claude --dangerously-skip-permissions --resume abc-123 "/);
        expect(line).toContain('connectToGenie');
    });
});
