import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * POWERSHELL VARIABLES IGNORE CASE (Tynn #692; the Azure run of `-Only unit` on candidate 101287c4: every row printed
 * "FAIL (timed out after N s)" within a second). windows.ps1 named the short run's prerequisite rows `$setup`, which IS
 * `$Setup`, the ci-out\setup folder: the folder became an array of row names, `New-Item` failed ("Cannot convert
 * System.Object[] to System.String"), ci-out was never made, and `Test-Path` of the array of mark paths returned an
 * array, which reads as true. Two spellings of one name are one variable; this keeps every name to one spelling.
 */
const ps1 = readFileSync(new URL('../scripts/ci/windows.ps1', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

describe('scripts/ci/windows.ps1', () => {
    it('CONTROL: its variables are read, $Setup and $Out among them', () => {
        expect(ps1).toMatch(/\$Setup = Join-Path \$Out 'setup'/);
        expect(ps1).toMatch(/\$Out = Join-Path \$Repo 'ci-out'/);
    });

    it('spells every variable one way: two spellings that differ only in case are the same variable', () => {
        const spellings = new Map<string, Set<string>>();
        for (const m of ps1.matchAll(/\$(?:script:)?([A-Za-z_][A-Za-z0-9_]*)/g)) {
            const name = m[1]!;
            const key = name.toLowerCase();
            if (!spellings.has(key)) spellings.set(key, new Set());
            spellings.get(key)!.add(name);
        }
        // PowerShell's own automatic variables, spelled as their documentation does.
        const automatic = new Set(['_', 'null', 'true', 'false', 'pid', 'home', 'lastexitcode', 'matches', 'psscriptroot', 'psversiontable', 'outputencoding', 'erroractionpreference', 'env']);
        const mixed = [...spellings].filter(([key, set]) => !automatic.has(key) && set.size > 1).map(([, set]) => [...set].sort().join(' / '));
        expect(mixed).toEqual([]);
    });

    it('a row that ends before its ceiling cannot read as timed out: the mark must be this row\'s own, and the time must have passed', () => {
        expect(ps1).toMatch(/\$timedOut = \(Test-Path -LiteralPath \$mark -PathType Leaf\) -and \(\(Get-Content -LiteralPath \$mark -Raw\)\.Trim\(\) -eq \$token\) -and \(\$elapsed -ge \$limit - 5\)/);
    });
});
