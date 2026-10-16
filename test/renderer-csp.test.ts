import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE RENDERER'S CONTENT SECURITY POLICY lets it dial a Genie host's socket (§6.8). Both remote
 * paths run in this renderer — the desktop driving another machine over `wss://`, and the phone's
 * page (served over http from the host's own port) opening `ws://` back to that origin. CSP3's
 * `'self'` does not cover a different host, so `connect-src` names the socket schemes explicitly;
 * everything else stays shut (`default-src 'none'`). Pinned because the meta tag is the one place a
 * silent "the socket never opens" can come from, with nothing in Genie's own code to point at.
 */

describe('index.html CSP', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const csp = /content="([^"]*)"/.exec(/http-equiv="Content-Security-Policy"[\s\S]*?content="[^"]*"/.exec(html)![0])![1]!;
    const directive = (name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `))?.slice(name.length + 1).split(/\s+/) ?? [];

    it('connect-src allows the renderer itself and both socket schemes, and nothing else', () => {
        expect(directive('connect-src').sort()).toEqual(["'self'", 'ws:', 'wss:'].sort());
    });

    it('everything not named stays shut, and the QR (a data: image) still renders', () => {
        expect(directive('default-src')).toEqual(["'none'"]);
        expect(directive('script-src')).toEqual(["'self'"]);
        expect(directive('img-src')).toContain('data:');
    });
});
