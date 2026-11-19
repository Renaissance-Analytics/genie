import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as server from '../src/main/playwright-server.js';

/**
 * CodeQL #113 (js/biased-cryptographic-random): the Playwright server's port was `20_000 + (randomBytes(2) % 20_000)`. 65536
 * is not a multiple of 20000, so the low 5536 ports came up more often than the rest. The port is now picked with
 * `crypto.randomInt`, which is uniform, over the same range as before: 20000 to 39999.
 */
const src = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

describe('the Playwright server port (CodeQL #113)', () => {
    it('is picked by playwrightServerPort, in 20000..39999, and covers that range', () => {
        const pick = (server as Record<string, unknown>).playwrightServerPort;
        expect(typeof pick, 'playwright-server.ts exports playwrightServerPort').toBe('function');
        const seen = Array.from({ length: 4000 }, () => (pick as () => number)());
        for (const port of seen) {
            expect(Number.isInteger(port), String(port)).toBe(true);
            expect(port).toBeGreaterThanOrEqual(20_000);
            expect(port).toBeLessThan(40_000);
        }
        // Not stuck on one value, and reaching both halves of the range.
        expect(new Set(seen).size).toBeGreaterThan(3000);
        expect(seen.some((p) => p < 30_000)).toBe(true);
        expect(seen.some((p) => p >= 30_000)).toBe(true);
    });

    it('uses crypto.randomInt, with no modulo of random bytes', () => {
        const s = src('src/main/playwright-server.ts');
        expect(s).toMatch(/import \{[^}]*\brandomInt\b[^}]*\} from 'node:crypto'/);
        expect(s).toMatch(/export function playwrightServerPort\(\): number \{\s*return randomInt\(20_000, 40_000\);\s*\}/);
    });

    it('is what the host hands the server, not a modulo of its own', () => {
        const host = src('src/main/genie-host.ts');
        expect(host).toMatch(/allocatePort: playwrightServerPort,/);
        expect(host).not.toMatch(/randomBytes\([^)]*\)\.readUInt16BE\([^)]*\)\s*%/);
    });
});
