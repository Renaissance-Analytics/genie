import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { RELEASE_NOTES } from '../src/main/release-notes.js';

const expected = () => Object.fromEntries(readdirSync('docs/releases').filter(name => /^v.+\.md$/.test(name))
    .map(name => [name.slice(1, -3), readFileSync(`docs/releases/${name}`, 'utf8')]));

describe('release notes in the host source and shipped bundle (Tynn #720)', () => {
    it('the Vite-transformed module contains every release document, byte for byte', () => {
        expect(RELEASE_NOTES).toEqual(expected());
        expect(Object.keys(RELEASE_NOTES).length).toBeGreaterThan(0);
    });
    it('plain Node/tsx can import the same notes before the host opens its endpoint', async () => {
        const script = "const { RELEASE_NOTES } = await import('./src/main/release-notes.ts'); process.stdout.write(JSON.stringify(RELEASE_NOTES));";
        const { stdout } = await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
            { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
        expect(JSON.parse(stdout)).toEqual(expected());
    }, 20_000);
});
