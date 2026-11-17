import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A real client's name may not appear in this PUBLIC repository: not in the UI, fixtures, tests, comments or docs. The
// guard must not leak the names it guards, so it holds only their SHA-256 (lowercased, separators removed) and checks
// every word, and every two adjacent words joined, against them. That catches the CamelCase, spaced, hyphenated and
// snake_case spellings of a two-word name alike. To add a name: hash its lowercase letters and append it here.
const FORBIDDEN: ReadonlySet<string> = new Set([
    '45cdca991e63f7497bc14a3e310f97752ca99fb940f8ab6b30928f905c9371d7',
]);

const ROOTS = ['src', 'test', 'docs'];
const TEXT = /\.(?:[cm]?[jt]sx?|md|txt|json|html|css|sh|ps1|py|ya?ml)$/i;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** The forbidden names (by hash) a line carries: each word, and each word joined with the next. */
function hits(line: string, forbidden: ReadonlySet<string> = FORBIDDEN): boolean {
    const words = line.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (let i = 0; i < words.length; i++) {
        if (forbidden.has(sha(words[i]!))) return true;
        if (i + 1 < words.length && forbidden.has(sha(words[i]! + words[i + 1]!))) return true;
    }
    return false;
}

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : TEXT.test(name) ? [path] : [];
    });
}

describe('no client names in the repository', () => {
    it('src/, test/ and docs/ carry no client name, in any casing or spacing', () => {
        const offenders = ROOTS.flatMap(files).flatMap((path) =>
            readFileSync(path, 'utf8').split(/\r?\n/).flatMap((line, i) => (hits(line) ? [`${path}:${i + 1}`] : [])));
        expect(offenders).toEqual([]);
    });

    it('CONTROL: the matcher finds every spelling of a two-word name, and passes neutral text', () => {
        const sample = new Set([sha('acmewidget')]);
        for (const line of ['AcmeWidget onboarding', 'the Acme Widget call', "name: 'Acmewidget'", 'C:/Users/me/acme-widget', 'ACME_WIDGET', '/w/acmewidget.agi'])
            expect(hits(line, sample), line).toBe(true);
        for (const line of ['a client onboarding call', 'acme widgets', 'Acme, then Widget later on'])
            expect(hits(line, sample), line).toBe(false);
    });
});
