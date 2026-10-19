import { describe, expect, it } from 'vitest';
import { genieUrlIn, signInCodeFrom, tynnSignInUrl } from '../src/core/tynn-sign-in.js';

/**
 * SIGN IN TO TYNN THE WAY GENIE 1 DID (the owner, 2026-10-19: "this is not how we handle tynn logins. Look at Genie 1").
 *
 * Sign in opens Tynn's /genie/callback in the browser — not /login, which drops the return URL for someone already signed
 * in. Tynn hands a single-use 64-character code back through genie://oauth/callback?token=…, or shows it to paste. Genie
 * takes the code from that URL (a second launch's argv on Windows and Linux, open-url on macOS) or from what was pasted —
 * the bare code or the whole URL — and nothing else.
 */

const CODE = 'aB3'.repeat(21) + 'x'; // 64 letters and digits, the shape Tynn mints (Str::random(64))

describe('tynnSignInUrl', () => {
    it('is /genie/callback under the host, returning to genie://oauth/callback', () => {
        expect(tynnSignInUrl('https://tynn.ai')).toBe('https://tynn.ai/genie/callback?return=genie%3A%2F%2Foauth%2Fcallback');
        expect(tynnSignInUrl(' https://tynn.example.com/ ')).toBe('https://tynn.example.com/genie/callback?return=genie%3A%2F%2Foauth%2Fcallback');
    });
});

describe('signInCodeFrom', () => {
    it('takes the bare code, trimmed', () => {
        expect(signInCodeFrom(`  ${CODE}\n`)).toBe(CODE);
    });

    it('takes the code out of the whole genie://oauth/callback URL', () => {
        expect(signInCodeFrom(`genie://oauth/callback?token=${CODE}`)).toBe(CODE);
        expect(signInCodeFrom(`genie://oauth/callback/?token=${CODE}`)).toBe(CODE);
    });

    it('refuses anything else: wrong length, other characters, another genie:// route, another scheme', () => {
        expect(signInCodeFrom('')).toBeNull();
        expect(signInCodeFrom(CODE.slice(1))).toBeNull();
        expect(signInCodeFrom(`${CODE}a`)).toBeNull();
        expect(signInCodeFrom(`${CODE.slice(1)}-`)).toBeNull();
        expect(signInCodeFrom(`genie://workstation/open?token=${CODE}`)).toBeNull();
        expect(signInCodeFrom(`https://tynn.ai/genie/callback?token=${CODE}`)).toBeNull();
        expect(signInCodeFrom('genie://oauth/callback')).toBeNull();
    });
});

describe('genieUrlIn', () => {
    it('finds the genie:// URL a second launch was handed, among Electron’s own switches', () => {
        expect(genieUrlIn(['C:\\Genie\\Genie.exe', '--allow-file-access-from-files', `genie://oauth/callback?token=${CODE}`])).toBe(`genie://oauth/callback?token=${CODE}`);
    });

    it('CONTROL: an ordinary launch has none', () => {
        expect(genieUrlIn(['C:\\Genie\\Genie.exe', '--quit'])).toBeNull();
        expect(genieUrlIn([])).toBeNull();
    });
});

describe('where a signed-out Genie is told to go', () => {
    it('IssueWatch points at the sign-in, not at a token field that no longer exists', async () => {
        const { issueWatchWhyNot } = await import('../src/core/issue-watch.js');
        const why = issueWatchWhyNot({ linked: true, state: 'signed-out' } as Parameters<typeof issueWatchWhyNot>[0]);
        expect(why).toBe('not signed in to Tynn (Settings → Workstation → Integrations → Open Tynn in your browser)');
        expect(why).not.toMatch(/token/i);
    });
});

describe('the installed app owns genie://', () => {
    it('electron-builder declares the genie scheme (Genie 1 did: the AppImage .desktop and the macOS Info.plist get it at build time)', async () => {
        const { readFileSync } = await import('node:fs');
        // Line endings normalised: a Windows checkout is CRLF, and a `\n`-only pattern read it as "no block" (2026-10-19).
        const yml = readFileSync('electron-builder.yml', 'utf8').replace(/\r\n/g, '\n');
        const block = yml.match(/^protocols:\n((?:[ \t]+.*\n)+)/m);
        expect(block, 'a top-level protocols: block').not.toBeNull();
        expect(block![1]).toMatch(/schemes:\s*\n\s*-\s*genie\s*$/m);
    });
});
