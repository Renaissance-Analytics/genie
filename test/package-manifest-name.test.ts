import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE_SIGNATURE_FILE } from '../src/core/plugin-integrity.js';

/**
 * ONE MANIFEST FILE FOR EVERY PACKAGE (Tynn #581; GApps v2 decision 1, approved 2026-11-08). Plugins and apps alike are
 * described by `genie-package.json`, forward-only. The signature file is part of the genie-package/1 format and keeps its
 * name.
 */
const OLD_NAME = ['genie-plugin', 'json'].join('.');

function filesUnder(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? filesUnder(path) : [path];
    });
}

describe('the package manifest is genie-package.json', () => {
    const scanned = [...filesUnder('src'), ...filesUnder(join('docs', 'sdk'))];

    it('nothing in the source or the SDK docs names the old file', () => {
        // Control: the walk reaches the files that read the manifest.
        expect(scanned.map((f) => f.split(/[\\/]/).join('/'))).toEqual(expect.arrayContaining(['src/main/plugin-host.ts', 'docs/sdk/packages.md']));
        expect(scanned.filter((f) => readFileSync(f, 'utf8').includes(OLD_NAME))).toEqual([]);
    });

    it('the Plugins page and the SDK docs name the new one', () => {
        expect(readFileSync(join('src', 'renderer', 'components', 'PluginsPage.tsx'), 'utf8')).toContain('genie-package.json');
        expect(readFileSync(join('docs', 'sdk', 'packages.md'), 'utf8')).toContain('genie-package.json');
    });

    it('the signature file keeps its name: genie-package/1 is unchanged', () => {
        expect(PACKAGE_SIGNATURE_FILE).toBe('genie-plugin.sig');
    });
});
