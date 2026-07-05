import { describe, expect, it } from 'vitest';
import { localSiteUrl, remoteGenUrl } from '../gen-url';

describe('localSiteUrl', () => {
    it('omits the default port for the scheme', () => {
        expect(localSiteUrl('https', 'tynn.test', 443)).toBe('https://tynn.test');
        expect(localSiteUrl('http', 'app.test', 80)).toBe('http://app.test');
    });

    it('keeps a non-default port', () => {
        expect(localSiteUrl('http', 'app.test', 3000)).toBe('http://app.test:3000');
        expect(localSiteUrl('https', 'tynn.test', 8443)).toBe('https://tynn.test:8443');
        // A non-default port under the OTHER scheme is kept too.
        expect(localSiteUrl('http', 'x.test', 443)).toBe('http://x.test:443');
    });
});

describe('remoteGenUrl', () => {
    it('builds https from a bare .gen name', () => {
        expect(remoteGenUrl('tynn.gen')).toBe('https://tynn.gen');
    });

    it('normalises an already-qualified or trailing-slashed name', () => {
        expect(remoteGenUrl('https://tynn.gen/')).toBe('https://tynn.gen');
        expect(remoteGenUrl('http://tynn.gen')).toBe('https://tynn.gen');
    });
});
