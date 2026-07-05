import { describe, expect, it } from 'vitest';
import { remoteGenUrl } from '../gen-url';

describe('remoteGenUrl', () => {
    it('builds https from a bare .gen name', () => {
        expect(remoteGenUrl('tynn.gen')).toBe('https://tynn.gen');
    });

    it('normalises an already-qualified or trailing-slashed name', () => {
        expect(remoteGenUrl('https://tynn.gen/')).toBe('https://tynn.gen');
        expect(remoteGenUrl('http://tynn.gen')).toBe('https://tynn.gen');
    });
});
