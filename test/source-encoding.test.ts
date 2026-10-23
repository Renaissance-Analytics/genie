import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * EVERY SOURCE FILE IS UTF-8 (2026-10-23). Vite 8's bundler (rolldown) refused to build: "stream did not contain valid
 * UTF-8" in src/core/workspace-label.ts — two em dashes written as Windows-1252 byte 0x97, which Vite 7 had read past.
 * An editor or script that guesses an encoding writes these; this holds every file the build reads to strict UTF-8.
 */

const ROOT = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SOURCE = /\.(ts|tsx|js|mjs|cjs|css|html|json)$/;

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? files(p) : SOURCE.test(name) ? [p] : [];
    });
}

describe('source encoding', () => {
    it('every file under src/ decodes as strict UTF-8', () => {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const bad = files(ROOT).filter((p) => { try { decoder.decode(readFileSync(p)); return false; } catch { return true; } });
        expect(bad).toEqual([]);
    });
});
