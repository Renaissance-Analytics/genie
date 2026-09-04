import { describe, expect, it } from 'vitest';
import {
    AGENT_MODES,
    agentMode,
    AUTOMATED_FRAMING,
    agentModeLabel,
    bootPromptMode,
    DEFAULT_AGENT_MODE,
    inboxNoticeMode,
    MANUAL_FRAMING,
    attentionNudgeMode,
    parseAgentMode,
    upgradeNoticeMode,
} from '../agent-mode';
import { parseAgentFile, renderAgentFile } from '../agent-file';
import { applyPersonaEdit, personaView } from '../persona';

/**
 * genie#408 — an agent is Automated or Manual, and Genie's nudges are worded
 * for which it is.
 *
 * The wording IS the feature, so it is pinned here rather than left to each
 * surface. A Manual agent told *"restore your connection and migrate"* will do
 * exactly that, and it is not wrong to: it was told to.
 */

/** Every clause the four surfaces can emit, as `[surface, automated, manual]`. */
const CLAUSES: readonly [string, string, string][] = [
    ['upgrade', upgradeNoticeMode('automated'), upgradeNoticeMode('manual')],
    ['inbox', inboxNoticeMode('automated'), inboxNoticeMode('manual')],
    ['attention', attentionNudgeMode('automated'), attentionNudgeMode('manual')],
    ['boot', bootPromptMode('automated'), bootPromptMode('manual')],
];

describe('the agent mode', () => {
    it('defaults to manual — an undeclared agent is never told to act on its own', () => {
        expect(DEFAULT_AGENT_MODE).toBe('manual');
        expect(agentMode(null)).toBe('manual');
        expect(agentMode(undefined)).toBe('manual');
        // POSITIVE CONTROL: a DECLARED mode is honoured, so the default above is
        // a default and not a hard-coded answer.
        expect(agentMode('automated')).toBe('automated');
        expect(agentMode('manual')).toBe('manual');
    });

    it('reads a declared mode from text, case- and space-insensitively', () => {
        expect(parseAgentMode('automated')).toBe('automated');
        expect(parseAgentMode('  Automated ')).toBe('automated');
        expect(parseAgentMode('MANUAL')).toBe('manual');
    });

    it('reads anything it does not recognise as UNDECLARED, not as automated', () => {
        // Null is "the file said nothing", which resolves to manual — the safe
        // direction. Guessing `automated` from a typo would be the unsafe one.
        for (const junk of ['', '   ', 'auto', 'yes', 'true', 'supervised', 'Automatic']) {
            expect(parseAgentMode(junk), junk).toBeNull();
            expect(agentMode(parseAgentMode(junk)), junk).toBe('manual');
        }
        expect(parseAgentMode(null)).toBeNull();
        expect(parseAgentMode(undefined)).toBeNull();
    });

    it('names both modes, manual first — the default leads', () => {
        expect(AGENT_MODES).toEqual(['manual', 'automated']);
        expect(agentModeLabel('manual')).toBe('Manual');
        expect(agentModeLabel('automated')).toBe('Automated');
    });
});

describe('the wording each mode gets', () => {
    it.each(CLAUSES)(
        'the %s clause is imperative for Automated and informational for Manual',
        (_surface, automated, manual) => {
            // The Manual clause must SAY it is informational. Asserting only
            // that it lacks an imperative would pass against an empty string —
            // hence the paired assertion on the Automated one, which must carry
            // the imperative the Manual one refuses.
            expect(manual).toContain('Manual agent');
            expect(manual).toMatch(/do not act/i);

            expect(automated).toContain('Automated agent');
            expect(automated).toMatch(/\bact\b/i);
            expect(automated).not.toMatch(/do not act/i);

            expect(manual).not.toBe(automated);
        },
    );

    it('carries ONE framing sentence across the three notice surfaces', () => {
        // One mode, one voice. Three surfaces each inventing their own way to
        // say "informational" is how the wording drifts until one of them reads
        // as an instruction again.
        expect(MANUAL_FRAMING).toMatch(/do not act on it unless a person asks you to/i);
        for (const clause of [
            upgradeNoticeMode('manual'),
            inboxNoticeMode('manual'),
            attentionNudgeMode('manual'),
        ]) {
            expect(clause).toContain(MANUAL_FRAMING);
        }
        for (const clause of [
            upgradeNoticeMode('automated'),
            inboxNoticeMode('automated'),
            attentionNudgeMode('automated'),
        ]) {
            expect(clause).toContain(AUTOMATED_FRAMING);
            expect(clause).not.toContain(MANUAL_FRAMING);
        }
    });

    it('closes the exact mis-inference #407 reported, for a Manual agent', () => {
        // *"the agent thinks they need to be all restarted when it gets the
        // genie just upgraded nudge."* The Manual upgrade clause names that
        // inference and rules it out.
        const manual = upgradeNoticeMode('manual');
        expect(manual).toMatch(/not a reason to restart/i);
        expect(manual).toMatch(/sites, services or processes/i);
        // POSITIVE CONTROL: the Automated agent is the one that SHOULD restore
        // what it owns, so the same sentence must not appear there.
        expect(upgradeNoticeMode('automated')).not.toMatch(/not a reason to restart/i);
        expect(upgradeNoticeMode('automated')).toMatch(/restore what you own/i);
    });

    it('never tells a Manual agent that a launch instruction is optional', () => {
        // The boot prompt is the one surface where a person HAS just asked for
        // something — `runAgent`'s `instructions` are appended to it. A Manual
        // clause that read "wait to be asked" there would stall the very work
        // the launch was for.
        const manual = bootPromptMode('manual');
        expect(manual).toMatch(/launched you (with|to do)/i);
        expect(manual).not.toMatch(/wait (for|until) (a person|someone)/i);
    });
});

describe('the mode lives on AGENT.md', () => {
    const file = (lines: string[]): string =>
        ['---', 'name: moic', 'purpose: agent management', ...lines, '---', '', 'Body.', ''].join(
            '\n',
        );

    it('is absent by default, and absence reads as manual', () => {
        const parsed = parseAgentFile(file([]));
        expect(parsed.config.mode).toBeNull();
        expect(agentMode(parsed.config.mode)).toBe('manual');
    });

    it('round-trips a declared mode', () => {
        for (const declared of AGENT_MODES) {
            const raw = file([`mode: ${declared}`]);
            const parsed = parseAgentFile(raw);
            expect(parsed.config.mode, declared).toBe(declared);
            // A FIXED POINT: parse then render reproduces the file, so opening
            // an agent and pressing Save with no edit produces no diff.
            expect(renderAgentFile(parsed.config, parsed.body, parsed.extra), declared).toBe(raw);
        }
    });

    it('does not invent a `mode:` line for a file that never had one', () => {
        // The same fixed point in the other direction. Writing `mode: manual`
        // into every existing AGENT.md would light Save on every agent and put
        // a line in a diff nobody asked for.
        const raw = file([]);
        const parsed = parseAgentFile(raw);
        expect(renderAgentFile(parsed.config, parsed.body, parsed.extra)).toBe(raw);
        expect(applyPersonaEdit(raw, {})).toBe(raw);
    });

    it('never carries `mode` through as an unknown header key', () => {
        // It is a key Genie renders itself now, so leaving it in `extra` would
        // write it twice.
        expect(parseAgentFile(file(['mode: automated'])).extra).toEqual([]);
    });

    it('is what the manager reads and what an edit writes', () => {
        const raw = file([]);
        expect(personaView(raw).mode).toBe('manual');

        const promoted = applyPersonaEdit(raw, { mode: 'automated' });
        expect(promoted).toContain('mode: automated');
        expect(personaView(promoted).mode).toBe('automated');

        // …and back again, stated rather than silently dropped: a human who
        // chose Manual has made a declaration, not reverted to a blank.
        const demoted = applyPersonaEdit(promoted, { mode: 'manual' });
        expect(demoted).toContain('mode: manual');
        expect(personaView(demoted).mode).toBe('manual');
    });

    it('leaves the mode alone when an edit does not name it', () => {
        const raw = file(['mode: automated']);
        expect(personaView(applyPersonaEdit(raw, { purpose: 'something else' })).mode).toBe(
            'automated',
        );
    });
});
