import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');
const workflows = ['ci.yml', 'e2e.yml', 'test-build.yml', 'release.yml'];

describe('supported Node runtime', () => {
    it('declares Node 22 for contributors and installed dependencies', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
            engines?: { node?: string };
        };
        expect(pkg.engines?.node).toBe('>=22');
    });

    it.each(workflows)('%s validates and releases on Node 22', (workflow) => {
        const yaml = fs.readFileSync(path.join(root, '.github', 'workflows', workflow), 'utf8');
        const pins = [...yaml.matchAll(/node-version:\s*['"]?(\d+)['"]?/g)].map((match) => match[1]);
        expect(pins.length).toBeGreaterThan(0);
        expect(new Set(pins)).toEqual(new Set(['22']));
    });
});
