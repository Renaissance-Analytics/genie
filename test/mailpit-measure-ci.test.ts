import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SERVICE_CATALOG } from '../src/core/services.js';
import { MAILPIT_MEASURED_IMAGE, MAILPIT_V130_DIGEST } from './mailpit-measure/mailpit-image.js';

/**
 * THE MAILPIT MEASUREMENT RUNS ON CI, AND ONLY THERE (Genie Mail G1, Tynn story #487). test/mailpit-measure/*.accept.ts
 * starts a real Mailpit container, so it is never part of `npm test` (which runs on people's machines too): it runs as
 * `npm run verify:mailpit` in its own CI job on Linux, against the image Genie itself runs, pinned by digest from GHCR.
 */
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
const config = (() => { try { return readFileSync(new URL('../vitest.mailpit.config.mts', import.meta.url), 'utf8'); } catch { return ''; } })();

describe('the Mailpit measurement', () => {
    it('is its own run: `npm run verify:mailpit`, over the .accept.ts files only, which `npm test` never picks up', () => {
        expect(pkg.scripts['verify:mailpit']).toBe('vitest run -c vitest.mailpit.config.mts');
        expect(config).toContain("include: ['test/mailpit-measure/**/*.accept.ts']");
        expect(vite).toContain("include: ['test/**/*.test.{ts,tsx}']");
        expect('test/mailpit-measure/mailpit-v130.accept.ts').not.toMatch(/\.test\.(ts|tsx)$/);
    });

    it('runs in its own CI job on Linux, always, and nowhere else in the workflow', () => {
        const job = /\n {2}mailpit:\n([\s\S]*?)(?=\n {2}[a-z0-9-]+:\n|$)/.exec(ci)?.[1] ?? '';
        expect(job).toContain('name: mailpit measure');
        expect(job).toContain('runs-on: ubuntu-latest');
        expect(job).toMatch(/- run: npm ci\n\s+- run: npm run verify:mailpit/);
        // Not path-filtered: a required check that is filtered out never reports.
        expect(job).not.toMatch(/\bif:/);
        expect(ci.match(/npm run verify:mailpit/g)).toHaveLength(1);
    });

    it('measures the image Genie runs: axllent/mailpit v1.30, by its digest, from GHCR', () => {
        const mailpit = SERVICE_CATALOG.find((e) => e.engine === 'mailpit')!;
        expect(mailpit.image).toBe('axllent/mailpit');
        expect(mailpit.majors).toEqual(['1.30']);
        expect(MAILPIT_V130_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(MAILPIT_MEASURED_IMAGE).toBe(`ghcr.io/axllent/mailpit@${MAILPIT_V130_DIGEST}`);
    });
});
