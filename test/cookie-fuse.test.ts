import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE COOKIE FUSE (the host split, P2b). Measured on omarchy-test: stock Electron writes a cookie's value in the clear on Linux,
 * and with EnableCookieEncryption on it doesn't; existing clear cookies stay readable after it goes on; `safeStorage` is
 * unaffected. A launch with no keyring that opens a store destroys it, which is why the guard (browser-store-guard.test.tsx)
 * came first. ONE WAY: turning the fuse off again loses what was written under it. Not a setting to flip back in a release.
 */

const yml = readFileSync('electron-builder.yml', 'utf8');

describe('the build', () => {
    it('turns it on, and only it', () => {
        const block = /^electronFuses:\r?\n((?: {2}.*\r?\n)+)/m.exec(yml)?.[1] ?? '';
        expect(block).toMatch(/^ {2}enableCookieEncryption: true/m);
        expect(block.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))).toHaveLength(1);
    });

    it('the host still runs as Node: nothing here turns that off', () => {
        expect(yml).not.toMatch(/runAsNode:\s*false/);
    });
});

describe('CI reads it from what was packaged', () => {
    it('the fuse, as the built binary has it, not as the config asks', () => {
        const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
        expect(ci).toMatch(/@electron\/fuses read --app/);
        expect(ci).toMatch(/EnableCookieEncryption is Enabled/);
    });
});
