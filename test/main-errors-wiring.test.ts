import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * main.ts INSTALLS THE MAIN-PROCESS ERROR POLICY — first, and it reaches the Deck. Source guards, comments stripped by
 * line (CRLF-safe) so prose cannot satisfy them; the policy itself is driven in main-errors.test.ts. Red on origin/main:
 * main.ts installs no `uncaughtException` listener at all, so Electron's blocking main-process error dialog is what a
 * stray throw gets (2026-10-15: an EPIPE from the pty froze Genie behind it).
 */

describe('main.ts wires the error policy', () => {
    const main = () => readFileSync('src/main/main.ts', 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
    const INSTALL = 'installMainErrorPolicy(process, mainErrors);';

    it('the policy is installed exactly once, on `process`, with the book the Deck reads', () => {
        const src = main();
        expect(src).toMatch(/^import \{ MainErrorBook, installMainErrorPolicy \} from '\.\.\/core\/main-errors\.js';$/m);
        expect(src.match(/installMainErrorPolicy\(/g) ?? []).toHaveLength(1);
        expect(src).toMatch(/^const mainErrors = new MainErrorBook\(\);\ninstallMainErrorPolicy\(process, mainErrors\);$/m);
        // Nothing else in main.ts listens for these: one listener each, and it is the policy's.
        expect(src).not.toMatch(/process\.(on|once|prependListener)\('(uncaughtException|unhandledRejection)'/);
    });

    it('it is the FIRST statement — only imports come before it — so it precedes the lock, boot() and app.whenReady', () => {
        const src = main();
        const at = src.indexOf('const mainErrors = new MainErrorBook();');
        expect(at).toBeGreaterThan(-1);
        const before = src.slice(0, at).replace(/^import\s[\s\S]*?\sfrom\s'[^']+';$/gm, '');
        expect(before.trim()).toBe('');
        const install = src.indexOf(INSTALL);
        for (const later of ['requestSingleInstanceLock(', 'async function boot(', 'app.whenReady()', "app.on('before-quit'"]) {
            const i = src.indexOf(later);
            expect(i, later).toBeGreaterThan(install);
        }
    });

    it('what it records is on the Deck, refreshed at once, and the Deck’s Dismiss reaches it', () => {
        const src = main();
        expect(src).toMatch(/registry\.setDeckSource\(\(\) => \[\.\.\.mainErrors\.deckItems\(\), \.\.\.composed\.deckItems\(\)\]\);/);
        expect(src).toMatch(/mainErrors\.onChange\(\(\) => registry\?\.touch\(\)\);/);
        const ports = src.slice(src.indexOf('const featurePorts: FeaturePorts = {'), src.indexOf('\n    };', src.indexOf('const featurePorts: FeaturePorts = {')));
        expect(ports).toMatch(/^\s*mainErrors,$/m);
    });
});
