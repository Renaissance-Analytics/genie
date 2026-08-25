import { describe, expect, it } from 'vitest';
import { chatIdBinding, quotable, withPersonaBriefing, withStartupInstructions } from '../startup';
import { LAUNCH_PROFILES } from '../../agentinbox/session-capture';

/**
 * Starting an agent: when its chat-id becomes knowable, and what a pre-loaded
 * instruction is allowed to look like once it reaches a shell (Tynn #254).
 */

describe('when a harness binds its chat-id', () => {
    it('says AFTER-LAUNCH for codex — the constraint the whole design bends around', () => {
        expect(chatIdBinding('codex')).toBe('after-launch');
        expect(chatIdBinding('claude')).toBe('at-launch');
        expect(chatIdBinding('custom')).toBe('after-launch');
    });

    it('treats only the SESSION-FLAG strategy as at-launch, whatever else a profile says', () => {
        // The load-bearing invariant, and the reason the codex profile's
        // `strategy: 'none'` — which is incomplete, and is being corrected in the
        // Codex harness-startup work — cannot propagate a wrong answer here.
        //
        // "Genie mints the id and passes it in" is a property of the FLAG
        // strategy alone. Every other value, present or future (`none`,
        // `detect`, a hook strategy, an unrecognised one), means the id is only
        // knowable after the process exists — which is the same requirement on
        // the saved-agent model either way: resolve without it, bind it later.
        // So this asserts the RULE against the live table, not a copy of today's
        // answers, and survives the profile being corrected underneath it.
        for (const [provider, profile] of Object.entries(LAUNCH_PROFILES)) {
            const expected = profile.strategy === 'flag' ? 'at-launch' : 'after-launch';
            expect(chatIdBinding(provider as 'claude' | 'codex' | 'custom')).toBe(expected);
        }
        // Positive control: the two branches are both actually reachable from
        // the current table, so the loop is not asserting one thing three times.
        const answers = new Set(
            Object.keys(LAUNCH_PROFILES).map((p) =>
                chatIdBinding(p as 'claude' | 'codex' | 'custom'),
            ),
        );
        expect([...answers].sort()).toEqual(['after-launch', 'at-launch']);
    });
});

describe('pre-loaded instructions', () => {
    it('become one positional prompt after the command', () => {
        expect(withStartupInstructions('claude --foo', 'Read AGENTS.md first.')).toBe(
            'claude --foo "Read AGENTS.md first."',
        );
    });

    it('are a no-op when empty, so a caller need not branch', () => {
        expect(withStartupInstructions('claude', '')).toBe('claude');
        expect(withStartupInstructions('claude', '   ')).toBe('claude');
    });

    it('NEVER hand the CLI an option-shaped prompt', () => {
        // A prompt is caller-supplied (`runAgent start --instructions`), and it
        // reaches the harness as one argv element. An element beginning with `-`
        // is ambiguous to every option parser: at best the CLI rejects an
        // unknown flag and the agent never starts, at worst it consumes the
        // prompt as one. Genie's launch line does not yet carry an explicit
        // end-of-options `--` separator — that is provider-aware grammar being
        // built separately — so the prompt itself must not look like an option.
        //
        // Stripping is the same deliberate prose-mangling trade `quotable`
        // already makes for `"` and backticks: instructions are instructions,
        // and a launch line the shell parses differently than Genie meant is the
        // failure being removed. It also stays correct once `--` arrives — a
        // separator plus a non-option-shaped prompt is belt and braces.
        expect(withStartupInstructions('codex', '--help me refactor')).toBe(
            'codex "help me refactor"',
        );
        expect(withStartupInstructions('codex', '-v then read AGENTS.md')).toBe(
            'codex "v then read AGENTS.md"',
        );
        expect(withStartupInstructions('codex', '  --- go')).toBe('codex "go"');
    });

    it('leaves a dash INSIDE the prompt alone — only the first character is ambiguous', () => {
        expect(withStartupInstructions('claude', 'Run npm test --silent')).toBe(
            'claude "Run npm test --silent"',
        );
    });

    it('drops a prompt that was NOTHING but dashes rather than emitting an empty argument', () => {
        expect(withStartupInstructions('claude', '--')).toBe('claude');
    });

    it('still refuses everything a double-quoted shell word cannot survive', () => {
        expect(quotable('say "hi" `now` $HOME 50% !bang\nand more')).toBe(
            'say hi now HOME 50 bang and more',
        );
        expect(quotable('C:\\_Projects\\x.md')).toBe('C:/_Projects/x.md');
    });
});

describe('a GApp persona briefing', () => {
    it('is the same mechanism with the app supplying the text', () => {
        const line = withPersonaBriefing('claude', '/ws/.agents/strategist.md', 'Strategist');
        expect(line.startsWith('claude "You are Strategist,')).toBe(true);
        expect(line).toContain('/ws/.agents/strategist.md');
        // One argument, so exactly two quotes — the shell-quoting lives in one
        // place now and this is what proves the GApp path goes through it.
        expect(line.split('"')).toHaveLength(3);
    });
});
