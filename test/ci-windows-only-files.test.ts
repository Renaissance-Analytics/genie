import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * A TEST FILE THAT RUNS ONLY ON WINDOWS SAYS SO, AND THE LINUX RUN NAMES IT (Tynn issue #692). The first unit run on
 * omarchy-test failed test/keychain-logon-hook.test.ts with `spawnSync pwsh ENOENT`: off Windows it ran the Windows
 * sign-in hook under PowerShell 7, which GitHub's Ubuntu image ships and an Omarchy machine never has. That proved nothing
 * about Linux, so the file runs on Windows only. A file skipped whole must not be skipped in silence:
 *
 *   - it carries one line, `// CI: WINDOWS ONLY (<reason>)`;
 *   - scripts/ci/linux.sh prints `NOT RUN ON LINUX <file> (<reason>)` for every file that carries it;
 *   - scripts/ci/windows.ps1 runs the whole suite, these files in it.
 *
 * "Whole" is read from the file: every top-level describe/it is gated on win32, written one of the two ways below.
 */
const MARK = /^\/\/ CI: WINDOWS ONLY \((.+)\)$/m;
const GATE = /^describe\.(?:runIf\(process\.platform === 'win32'\)|skipIf\(process\.platform !== 'win32'\))\(/;
const TOP = /^(?:describe|it|test)\b/;

const files = readdirSync(new URL('.', import.meta.url))
    .filter((name) => /\.test\.tsx?$/.test(name))
    .map((name) => {
        const text = readFileSync(new URL(name, import.meta.url), 'utf8');
        const tops = text.split(/\r?\n/).filter((l) => TOP.test(l));
        return { file: `test/${name}`, marked: MARK.test(text), reason: MARK.exec(text)?.[1] ?? null, windowsOnly: tops.length > 0 && tops.every((l) => GATE.test(l)) };
    });

describe('test files that run on Windows only', () => {
    it('CONTROL: the files are read, and the sign-in hook is one of them', () => {
        expect(files.length).toBeGreaterThan(500);
        expect(files.find((f) => f.file === 'test/keychain-logon-hook.test.ts')).toMatchObject({ windowsOnly: true, marked: true });
        // A file with one Windows describe among others is not a Windows-only file.
        expect(files.find((f) => f.file === 'test/program-lookup.test.ts')).toMatchObject({ windowsOnly: false, marked: false });
    });

    it('each one carries the marker with its reason, and nothing else carries it', () => {
        expect(files.filter((f) => f.windowsOnly && !f.marked).map((f) => f.file), 'Windows-only, with no marker').toEqual([]);
        expect(files.filter((f) => f.marked && !f.windowsOnly).map((f) => f.file), 'marked, but part of it runs elsewhere').toEqual([]);
    });

    it('the Linux run prints each marked file with its reason, from the marker itself', () => {
        const linux = readFileSync(new URL('../scripts/ci/linux.sh', import.meta.url), 'utf8');
        expect(linux).toContain("grep -rH '^// CI: WINDOWS ONLY (' test");
        expect(linux).toMatch(/echo "NOT RUN ON LINUX \$\{file\} \(\$\{reason\}\)"/);
    });
});
