import { describe, expect, it } from 'vitest';
import {
    asFtqAvailability,
    DEFAULT_DND_MESSAGE,
    resolveDndMessage,
    resolveFtqAvailability,
} from '../availability';

/**
 * ForceTheQuestion availability resolution (PendingQuestions UX Phase A). Pure —
 * most-specific scope wins (workspace → workstation → global → Available default);
 * the DND notice falls back to the owner-authored default.
 */
describe('resolveFtqAvailability', () => {
    it('defaults to Available when nothing is set at any scope', () => {
        expect(resolveFtqAvailability({})).toBe('available');
        expect(resolveFtqAvailability({ workspace: null, workstation: null, global: null })).toBe(
            'available',
        );
    });

    it('uses the global setting when no narrower scope is set', () => {
        expect(resolveFtqAvailability({ global: 'dnd' })).toBe('dnd');
        expect(resolveFtqAvailability({ global: 'available' })).toBe('available');
    });

    it('workstation overrides global', () => {
        expect(resolveFtqAvailability({ workstation: 'dnd', global: 'available' })).toBe('dnd');
        expect(resolveFtqAvailability({ workstation: 'available', global: 'dnd' })).toBe('available');
    });

    it('workspace overrides BOTH workstation and global (most specific wins)', () => {
        expect(
            resolveFtqAvailability({ workspace: 'dnd', workstation: 'available', global: 'available' }),
        ).toBe('dnd');
        expect(
            resolveFtqAvailability({ workspace: 'available', workstation: 'dnd', global: 'dnd' }),
        ).toBe('available');
    });

    it('an unset (null) narrower scope inherits the broader one', () => {
        // workspace unset → inherits the workstation's DND.
        expect(resolveFtqAvailability({ workspace: null, workstation: 'dnd' })).toBe('dnd');
        // workspace + workstation unset → inherits global.
        expect(resolveFtqAvailability({ workspace: null, workstation: null, global: 'dnd' })).toBe(
            'dnd',
        );
    });
});

describe('asFtqAvailability', () => {
    it('passes valid values and rejects everything else to undefined (inherit)', () => {
        expect(asFtqAvailability('available')).toBe('available');
        expect(asFtqAvailability('dnd')).toBe('dnd');
        expect(asFtqAvailability('')).toBeUndefined();
        expect(asFtqAvailability('forced')).toBeUndefined();
        expect(asFtqAvailability(null)).toBeUndefined();
        expect(asFtqAvailability(undefined)).toBeUndefined();
        expect(asFtqAvailability(1)).toBeUndefined();
    });
});

describe('resolveDndMessage', () => {
    it('returns the configured message when set', () => {
        expect(resolveDndMessage('hold off, I am heads-down')).toBe('hold off, I am heads-down');
    });

    it('trims and falls back to the owner default when blank / non-string', () => {
        expect(resolveDndMessage('  spaced  ')).toBe('spaced');
        expect(resolveDndMessage('   ')).toBe(DEFAULT_DND_MESSAGE);
        expect(resolveDndMessage('')).toBe(DEFAULT_DND_MESSAGE);
        expect(resolveDndMessage(undefined)).toBe(DEFAULT_DND_MESSAGE);
        expect(resolveDndMessage(42)).toBe(DEFAULT_DND_MESSAGE);
    });
});
