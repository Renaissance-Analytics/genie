import { describe, expect, it } from 'vitest';
import {
    agentCapField,
    describeInheritedAgentCap,
    inheritedAgentCap,
    readAgentCapField,
    workstationAgentCapField,
    writeWorkstationAgentCap,
} from '../agent-cap-field';
import { DEFAULT_AGENT_TERMINAL_CAP } from '../../../main/terminal/agent-cap';

/**
 * The agent-terminal cap FIELD — what the two settings surfaces mean by an empty
 * box, a number, and "unlimited" (Tynn #117).
 *
 * This is a pure module rather than logic inside the two components because the
 * renderer test lane is Node-only (no jsdom): judgement that lives in a component
 * is judgement nobody can test. And the judgement matters — the field is the only
 * way a PERSON changes a limit that agents cannot, so "what does this box mean"
 * has to be settled once, not twice, and not by whichever component was edited
 * last.
 *
 * The direction of every fallback here is the same: an unusable value resolves
 * toward a real limit, never toward `unlimited`. A cap that silently turns itself
 * off because someone typed a letter is not a cap.
 */
describe('reading the field', () => {
    it('takes the mode as authoritative, not leftover text', () => {
        // Switching the select away from "Limit to" must not persist the number
        // still sitting in the (now hidden) box.
        expect(readAgentCapField('inherit', '5')).toEqual({ kind: 'inherit' });
        expect(readAgentCapField('unlimited', '5')).toEqual({ kind: 'unlimited' });
    });

    it('reads a positive integer as that limit', () => {
        expect(readAgentCapField('limit', '3')).toEqual({ kind: 'limit', limit: 3 });
        expect(readAgentCapField('limit', ' 12 ')).toEqual({ kind: 'limit', limit: 12 });
    });

    it('reads an EMPTY box as inherit', () => {
        // The brief's rule: clearing the number is how a person says "use the
        // workstation default", not how they say "no limit".
        expect(readAgentCapField('limit', '')).toEqual({ kind: 'inherit' });
        expect(readAgentCapField('limit', '   ')).toEqual({ kind: 'inherit' });
    });

    it('refuses to persist a number that would break the workspace', () => {
        // 0 and negatives are not small caps, they are "nothing may ever start".
        // Mid-typing garbage is not an instruction either. Both leave the stored
        // value alone rather than writing something the user did not mean.
        expect(readAgentCapField('limit', '0')).toEqual({ kind: 'unusable' });
        expect(readAgentCapField('limit', '-2')).toEqual({ kind: 'unusable' });
        expect(readAgentCapField('limit', 'abc')).toEqual({ kind: 'unusable' });
        expect(readAgentCapField('limit', '2.5')).toEqual({ kind: 'unusable' });
        expect(readAgentCapField('limit', '1e3')).toEqual({ kind: 'unusable' });
    });
});

describe('showing a stored cap in the field', () => {
    it('round-trips every state it can be in', () => {
        expect(agentCapField(null)).toEqual({ mode: 'inherit', limit: '' });
        expect(agentCapField(undefined)).toEqual({ mode: 'inherit', limit: '' });
        expect(agentCapField('unlimited')).toEqual({ mode: 'unlimited', limit: '' });
        expect(agentCapField(4)).toEqual({ mode: 'limit', limit: '4' });
    });

    it('shows an unusable stored number as inherit, not as a limit of 0', () => {
        expect(agentCapField(0)).toEqual({ mode: 'inherit', limit: '' });
    });

    it('survives the round trip for a real limit', () => {
        const field = agentCapField(6);
        expect(readAgentCapField(field.mode, field.limit)).toEqual({
            kind: 'limit',
            limit: 6,
        });
    });
});

describe('what an empty workspace field inherits', () => {
    it('is the workstation setting when it is a usable number', () => {
        expect(inheritedAgentCap('12')).toBe(12);
        expect(inheritedAgentCap('1')).toBe(1);
    });

    it('is unlimited only when the workstation explicitly says so', () => {
        expect(inheritedAgentCap('unlimited')).toBe('unlimited');
    });

    it('falls back to the built-in default — never to unlimited', () => {
        // An unset / unreadable workstation setting must not be the thing that
        // deletes the limit on every machine that never opened Settings.
        for (const raw of [undefined, null, '', '0', '-1', 'nonsense', '2.5']) {
            expect(inheritedAgentCap(raw)).toBe(DEFAULT_AGENT_TERMINAL_CAP);
        }
    });
});

/**
 * The WORKSTATION row is the same two controls over a string setting, with one
 * difference: there is no level above it, so it has no "inherit" — an empty box
 * means the built-in default, and a low number snaps to 1 rather than being
 * rejected. That snap mirrors the Max views row it sits beside; on a field whose
 * only control is the number, silently discarding a keystroke reads as broken.
 */
describe('the workstation default row', () => {
    it('shows the stored setting', () => {
        expect(workstationAgentCapField('12')).toEqual({ mode: 'limit', limit: '12' });
        expect(workstationAgentCapField('unlimited')).toEqual({
            mode: 'unlimited',
            limit: '',
        });
    });

    it('shows the built-in default when nothing is stored', () => {
        expect(workstationAgentCapField(undefined)).toEqual({
            mode: 'limit',
            limit: String(DEFAULT_AGENT_TERMINAL_CAP),
        });
        expect(workstationAgentCapField('garbage')).toEqual({
            mode: 'limit',
            limit: String(DEFAULT_AGENT_TERMINAL_CAP),
        });
    });

    it('leaves a box the user CLEARED empty rather than refilling it', () => {
        // Refilling as they type is the failure mode of a controlled number field.
        expect(workstationAgentCapField('')).toEqual({ mode: 'limit', limit: '' });
    });

    it('writes a number, and clamps a low one to 1 instead of dropping it', () => {
        expect(writeWorkstationAgentCap('limit', '5')).toBe('5');
        expect(writeWorkstationAgentCap('limit', '0')).toBe('1');
    });

    it('writes an empty box as unset — which enforcement reads as the default', () => {
        expect(writeWorkstationAgentCap('limit', '')).toBe('');
    });

    it('writes "unlimited" as the explicit off switch', () => {
        expect(writeWorkstationAgentCap('unlimited', '5')).toBe('unlimited');
    });

    it('ignores garbage so the field stays typable', () => {
        expect(writeWorkstationAgentCap('limit', 'abc')).toBeNull();
        expect(writeWorkstationAgentCap('limit', '2.5')).toBeNull();
        expect(writeWorkstationAgentCap('limit', '-4')).toBeNull();
    });

    it('round-trips: what it writes is what it shows', () => {
        const written = writeWorkstationAgentCap('limit', '7');
        expect(workstationAgentCapField(written)).toEqual({ mode: 'limit', limit: '7' });
    });
});

describe('the sub-label under the workspace field', () => {
    it('names the actual inherited number, not the word "default"', () => {
        // A person deciding whether to override needs to see what they are
        // overriding. "the default" tells them nothing.
        expect(describeInheritedAgentCap('12')).toBe('12 agent terminals');
        expect(describeInheritedAgentCap(undefined)).toBe(
            `${DEFAULT_AGENT_TERMINAL_CAP} agent terminals`,
        );
    });

    it('says one terminal in the singular', () => {
        expect(describeInheritedAgentCap('1')).toBe('1 agent terminal');
    });

    it('says unlimited in words rather than showing a number', () => {
        expect(describeInheritedAgentCap('unlimited')).toBe('no limit');
    });
});
