import { describe, it, expect } from 'vitest';
import { safeName } from '../index';

/**
 * safeName sanitises a remote host's name before it's interpolated into the
 * injected "REMOTE SESSION" banner script + the window title. It's a security
 * boundary (the name comes off the wire from /api/ping), so it must strip
 * anything that could break out of the JS string / inject HTML.
 */
describe('safeName (remote-banner sanitisation)', () => {
    it('keeps ordinary hostnames intact', () => {
        expect(safeName('Wish-Desktop')).toBe('Wish-Desktop');
        expect(safeName('mac mini 2')).toBe('mac mini 2');
    });

    it('strips characters that could break the injected JS or inject HTML', () => {
        expect(safeName("x'); alert(1);//")).toBe('x alert1');
        expect(safeName('<script>evil</script>')).toBe('scriptevilscript');
        expect(safeName('a`b${c}')).toBe('abc');
    });

    it('falls back to a generic label when nothing safe remains', () => {
        expect(safeName('「」')).toBe('a remote machine');
        expect(safeName('')).toBe('a remote machine');
    });

    it('caps the length', () => {
        expect(safeName('a'.repeat(200)).length).toBe(60);
    });
});
