import { describe, expect, it } from 'vitest';
import { ATTRIBUTION_EMOJI, assignEmoji } from '../emoji';

/**
 * Per-user attribution emoji. Tynn is the assignment AUTHORITY (access is granted
 * there, and it may hand the host a `preferred` emoji); the host only needs a
 * deterministic, collision-avoiding fallback so an unlabelled principal still gets
 * a STABLE signature rather than a random one that changes on every reconnect.
 */

describe('assignEmoji', () => {
    it('is deterministic for the same principal (survives reconnects)', () => {
        expect(assignEmoji('user-42')).toBe(assignEmoji('user-42'));
    });

    it('honours the emoji the access grant assigned (Tynn is the authority)', () => {
        expect(assignEmoji('user-42', [], '🐙')).toBe('🐙');
    });

    it('avoids an emoji already taken by another connected user', () => {
        const first = assignEmoji('user-42');
        const second = assignEmoji('user-42', [first]);
        expect(second).not.toBe(first);
        expect(ATTRIBUTION_EMOJI).toContain(second);
    });

    it('gives distinct emoji to a roomful of users', () => {
        const taken: string[] = [];
        for (let i = 0; i < 12; i++) taken.push(assignEmoji(`user-${i}`, taken));
        expect(new Set(taken).size).toBe(12);
    });

    it('always returns an emoji from the palette when none is preferred', () => {
        expect(ATTRIBUTION_EMOJI).toContain(assignEmoji('somebody'));
    });
});
