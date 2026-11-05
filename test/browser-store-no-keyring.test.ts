import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STORE_LOCKED, STORE_NO_KEYRING, storeRefusal } from '../src/core/browser-store.js';

/**
 * NO KEYRING AT ALL IS NOT A LOCKED ONE (the coordinator, 2026-11-05: every action shows its failure and the reason). With
 * no key a site's store is not opened (the store guard), and the panel and the Genie browser say why. Their sentence said
 * "Unlock it, then restart": right for a locked keyring, wrong on a Linux machine with no keyring at all (Electron's
 * backend `basic_text`, the CI runner's case), where there is nothing to unlock. That case says what to install.
 */
describe('why a site’s store is not opened', () => {
    it('Linux with no system keyring: says none is available, and what to install, then restart', () => {
        expect(storeRefusal('linux', 'basic_text')).toBe(STORE_NO_KEYRING);
        expect(STORE_NO_KEYRING).toMatch(/can’t be kept safely here/);
        expect(STORE_NO_KEYRING).toMatch(/no system keyring is available/);
        expect(STORE_NO_KEYRING).toMatch(/GNOME Keyring or KWallet/);
        expect(STORE_NO_KEYRING).toMatch(/restart Genie/);
        expect(STORE_NO_KEYRING).not.toMatch(/unlock/i);
    });

    it('CONTROL: a keyring that is there but locked keeps the unlock sentence; so does any other platform', () => {
        expect(storeRefusal('linux', 'gnome_libsecret')).toBe(STORE_LOCKED);
        expect(storeRefusal('linux', 'kwallet5')).toBe(STORE_LOCKED);
        expect(storeRefusal('win32', null)).toBe(STORE_LOCKED);
        expect(storeRefusal('darwin', null)).toBe(STORE_LOCKED);
    });
});

describe('wired: every place that refuses a store says it the same way', () => {
    const read = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    it('the site panel, the Genie browser’s notice and its store opener use storeRefusal, never the locked sentence alone', () => {
        for (const file of ['src/main/site-panels-electron.ts', 'src/main/browser-process.ts', 'src/main/genie-browser-electron.ts']) {
            const src = read(file);
            expect(src, file).toMatch(/storeRefusal\(process\.platform, /);
            expect(src, file).not.toMatch(/\bSTORE_LOCKED\b/);
        }
    });
});
