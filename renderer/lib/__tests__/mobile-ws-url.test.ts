import { describe, expect, it } from 'vitest';
import { buildWsUrl } from '../mobile-client';

/**
 * The single most important thing for serving the mobile UX over TLS: the client's
 * WebSocket URL must be SAME-ORIGIN-derived, so an https page automatically uses
 * wss (and http uses ws). buildWsUrl is the pure core of that derivation.
 */
describe('buildWsUrl (same-origin ws/wss derivation)', () => {
    it('derives wss from an https page', () => {
        expect(buildWsUrl('https:', 'host.ts.net:51718', '/ws/events', 'tok')).toBe(
            'wss://host.ts.net:51718/ws/events?token=tok',
        );
    });

    it('derives ws from an http page', () => {
        expect(buildWsUrl('http:', '100.1.2.3:51718', '/ws/events', 'tok')).toBe(
            'ws://100.1.2.3:51718/ws/events?token=tok',
        );
    });

    it('attaches extra params + the token, and omits the token when absent', () => {
        expect(buildWsUrl('https:', 'h:1', '/ws/term', 'tok', { terminal: 't1' })).toBe(
            'wss://h:1/ws/term?terminal=t1&token=tok',
        );
        expect(buildWsUrl('http:', 'h:1', '/ws/events', null)).toBe('ws://h:1/ws/events?');
    });
});
