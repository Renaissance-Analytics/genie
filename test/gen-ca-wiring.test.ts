import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * MAIN WIRES GENIE'S CA (main.ts cannot be composed in a test — it is Electron — so its two lines are read):
 * Genie 1's `host-gen` folder under Genie 1's userData (the same `app.getPath('userData')` v1DatabaseFile reads) is
 * offered for adoption, and a front-door change (trust read, a site added, Not now) refreshes the Deck, so Genie's
 * Trust item appears and leaves without anyone polling.
 */

const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');

describe('main wires the CA', () => {
    it('genie-host’s hosting is offered Genie 1’s host-gen folder under Genie 1’s userData — once; the window offers none (Tynn #955)', () => {
        const inputs = readFileSync(new URL('../src/main/hosting-inputs.ts', import.meta.url), 'utf8');
        expect(inputs.match(/v1CaDirs: \[\.\.\.new Set\(\[\.\.\.\(paths\.v1UserData \? \[join\(paths\.v1UserData, 'host-gen'\)\]/g) ?? []).toHaveLength(1);
        expect(main).not.toMatch(/v1CaDirs:/);
    });

    // The window registry's Deck, which a front-door change used to refresh here, was read by nothing (Tynn #998, 2g-4b1: the
    // proof is in test/split-2g4b1-settings-watch.test.ts). The person's Deck, with its Trust item, is genie-host's.
    it('main refreshes no Deck of its own on a front-door change; genie-host’s Deck carries the Trust item', () => {
        expect(main).not.toMatch(/composed\.onFrontDoorChange\(\(\)\s*=>\s*registry\?\.touch\(\)\)/);
        // Its hosting's own items (the Trust ask among them), beside what waits for a window (2g-4d E2b).
        expect(readFileSync(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8')).toMatch(/trust: \[\.\.\.\(hostingStack\?\.trustDeckItems\(\) \?\? \[\]\), \.\.\.hostingElevation\.deckItems\(\)\],/);
    });
});
