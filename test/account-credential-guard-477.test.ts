import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GENIE READS NO TOKEN (Tynn #477). Who an account is comes from the provider's own status answers; a provider's
 * credential file is never opened by anything under src/. The names are matched in code, with comments stripped BY LINE
 * (a note may say what is not done). The guard is proved by a planted read, and by what it must not flag.
 */
const NAMES = /\.credentials\.json|(?<![A-Za-z0-9_])auth\.json|['"`]\.?credentials['"`]\s*\+\s*['"`]\.?json|['"`]auth['"`]\s*\+\s*['"`]\.json/;
const stripComments = (source: string): string => source.split(/\r?\n/).map((line) => line.replace(/^\s*(\/\/|\*|\/\*).*$/, '').replace(/\s\/\/\s.*$/, '')).join('\n');
const readsCredentialFile = (source: string): boolean => NAMES.test(stripComments(source));

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx|mts|js|mjs)$/.test(e.name) ? [join(dir, e.name).replaceAll('\\', '/')] : []);

describe('no code under src/ opens a provider credential file', () => {
    it('the guard detects a planted read (positive control)', () => {
        expect(readsCredentialFile("const t = readFileSync(join(home, '.credentials.json'), 'utf8');")).toBe(true);
        expect(readsCredentialFile("await readFile(path.join(codexHome, 'auth.json'))")).toBe(true);
        expect(readsCredentialFile("const f = join(home, '.credentials' + '.json');")).toBe(true);
        expect(readsCredentialFile('const f = join(home, `auth.json`);')).toBe(true);
    });

    it('the guard does not flag a comment, or a name that merely contains one', () => {
        expect(readsCredentialFile('// Genie never opens .credentials.json or auth.json\nconst a = 1;')).toBe(false);
        expect(readsCredentialFile(' * auth.json is the provider\'s own\nconst a = 1;')).toBe(false);
        expect(readsCredentialFile("const f = join(home, 'oauth.json');")).toBe(false);
    });

    it('the tree has none', () => {
        const all = files('src');
        expect(all.length).toBeGreaterThan(100);
        expect(all.filter((file) => readsCredentialFile(readFileSync(file, 'utf8')))).toEqual([]);
    });
});
