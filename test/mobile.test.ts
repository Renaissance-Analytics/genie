import { describe, expect, it } from 'vitest';
import { MOBILE_PATH, mobileEntry, mobilePageUrl, staticFile } from '../src/core/mobile.js';

/**
 * THE PHONE'S DOOR (§6.8 mobile UI). The host's Tailscale listener already carries the remote socket;
 * the same port now serves the built renderer at `/mobile`, so a phone on the tailnet opens a page,
 * reads the PIN off the desktop (or scans it: the QR carries the PAGE URL with `#pin=`), and drives
 * the host over the socket on the same origin. Three decisions are pure and pinned here: what the
 * QR points at, when the renderer is the phone's shell rather than the desktop's, and which files
 * the listener may hand out — confined to the built renderer, by an allow-list, never by guessing.
 */

describe('mobilePageUrl', () => {
    it('turns the socket URL into the page a phone can open: ws→http, wss→https, /genie→/mobile', () => {
        expect(mobilePageUrl('ws://alphar.tailnet.invalid:7421/genie')).toBe('http://alphar.tailnet.invalid:7421/mobile');
        expect(mobilePageUrl('wss://alphar.tailnet.invalid:7421/genie')).toBe('https://alphar.tailnet.invalid:7421/mobile');
        // A bare socket origin (no path) gets the page path too.
        expect(mobilePageUrl('wss://alphar.tailnet.invalid:7421')).toBe('https://alphar.tailnet.invalid:7421/mobile');
    });

    it('is null for anything that is not a Genie socket URL — nothing is guessed', () => {
        expect(mobilePageUrl('http://alphar.tailnet.invalid:7421/genie')).toBeNull();
        expect(mobilePageUrl('alphar:7421')).toBeNull();
        expect(mobilePageUrl('')).toBeNull();
        expect(mobilePageUrl(null)).toBeNull();
    });
});

describe('mobileEntry', () => {
    const at = (over: Partial<{ protocol: string; host: string; pathname: string; hash: string }> = {}) => ({
        protocol: 'http:', host: 'alphar.tailnet.invalid:7421', pathname: MOBILE_PATH, hash: '', ...over,
    });

    it('the served page with no desktop bridge is the phone: socket on the same origin, PIN read from the hash', () => {
        expect(mobileEntry(at({ hash: '#pin=482913' }), false)).toEqual({ kind: 'mobile', socketUrl: 'ws://alphar.tailnet.invalid:7421/genie', pin: '482913' });
        expect(mobileEntry(at({ protocol: 'https:' }), false)).toEqual({ kind: 'mobile', socketUrl: 'wss://alphar.tailnet.invalid:7421/genie', pin: null });
        // A trailing slash is the same page.
        expect(mobileEntry(at({ pathname: `${MOBILE_PATH}/` }), false)).toMatchObject({ kind: 'mobile' });
    });

    it('a PIN that is not six digits is no PIN — the form asks instead of sending junk to the host', () => {
        expect(mobileEntry(at({ hash: '#pin=abc' }), false)).toMatchObject({ kind: 'mobile', pin: null });
        expect(mobileEntry(at({ hash: '#pin=' }), false)).toMatchObject({ kind: 'mobile', pin: null });
        expect(mobileEntry(at({ hash: '#genie://deck' }), false)).toMatchObject({ kind: 'mobile', pin: null });
    });

    it('the desktop stays the desktop: a bridge present, a file:// load, or any other path', () => {
        expect(mobileEntry(at({ hash: '#pin=482913' }), true)).toEqual({ kind: 'desktop' });
        expect(mobileEntry(at({ protocol: 'file:', host: '', pathname: '/C:/app/renderer/index.html' }), false)).toEqual({ kind: 'desktop' });
        expect(mobileEntry(at({ pathname: '/' }), false)).toEqual({ kind: 'desktop' });
        expect(mobileEntry(at({ pathname: '/mobile-ish' }), false)).toEqual({ kind: 'desktop' });
    });
});

describe('staticFile', () => {
    it('the page routes and the built assets, each with its type and cache rule', () => {
        expect(staticFile('/')).toEqual({ relative: 'index.html', contentType: 'text/html; charset=utf-8', cache: 'no-store' });
        expect(staticFile('/mobile')).toEqual({ relative: 'index.html', contentType: 'text/html; charset=utf-8', cache: 'no-store' });
        expect(staticFile('/mobile/')).toMatchObject({ relative: 'index.html' });
        expect(staticFile('/mobile?from=qr')).toMatchObject({ relative: 'index.html' });
        expect(staticFile('/assets/index-Ck3p.js')).toEqual({ relative: 'assets/index-Ck3p.js', contentType: 'text/javascript; charset=utf-8', cache: 'public, max-age=31536000, immutable' });
        expect(staticFile('/assets/index-Ck3p.css')).toMatchObject({ contentType: 'text/css; charset=utf-8' });
        expect(staticFile('/assets/Geist-Variable-abc.woff2')).toMatchObject({ contentType: 'font/woff2' });
        expect(staticFile('/assets/index-Ck3p.js.map')).toMatchObject({ contentType: 'application/json; charset=utf-8' });
        expect(staticFile('/assets/sparkle-abc.wav')).toMatchObject({ contentType: 'audio/wav' });
        expect(staticFile('/assets/mark-abc.svg')).toMatchObject({ contentType: 'image/svg+xml' });
        expect(staticFile('/assets/logo-abc.png')).toMatchObject({ contentType: 'image/png' });
    });

    it('is an allow-list: nothing outside the renderer, nothing nested, no other extension, no traversal', () => {
        expect(staticFile('/assets/../package.json')).toBeNull();
        expect(staticFile('/assets/%2e%2e/package.json')).toBeNull();
        expect(staticFile('/assets/..%2fpackage.json')).toBeNull();
        expect(staticFile('/assets/sub/x.js')).toBeNull();
        expect(staticFile('/assets/x.exe')).toBeNull();
        expect(staticFile('/assets/x.html')).toBeNull();
        expect(staticFile('/assets/')).toBeNull();
        expect(staticFile('/assets')).toBeNull();
        expect(staticFile('/index.html')).toBeNull();
        expect(staticFile('/package.json')).toBeNull();
        expect(staticFile('/genie')).toBeNull();
        expect(staticFile('/assets/a\\b.js')).toBeNull();
        expect(staticFile('')).toBeNull();
    });
});
